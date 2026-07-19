"""Claimed MySQL-authoritative runtime for managed process tools."""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any, Callable

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.internal_process_contract import (
    InternalProcessCommand,
    InternalProcessContractError,
    parse_and_bind_internal_process,
)
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_TIMEOUT,
    SANDBOX_EXECUTION_STATUS_CANCELLED,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.app.persistence.errors import ConflictError, IdempotencyKeyReuseError, NotFoundError
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.formal_session_runtime import get_formal_session_runtime
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor, SupervisorAdmissionError
from sandbox.services.workspace_manager import workspace_manager
from sandbox.trace import reset_trace_id, set_trace_id

logger = logging.getLogger("sandbox.services.formal_process_runtime")
FORMAL_PROCESS_RUNTIME_STATE_KEY = "formal_process_runtime"
_PUBLIC_PROCESS_STATUSES = frozenset({"starting", "running", "completed", "failed", "cancelled", "timeout", "lost", "orphaned"})
_INTERNAL_PROCESS_STATUS_ALIASES = {
    "created": "starting",
    "waiting_input": "running",
    "cancel_requested": "running",
}


def _public_process_status(value: Any, *, fallback: str | None = None) -> str:
    raw = str(value if value is not None else fallback or "").strip().lower()
    normalized = _INTERNAL_PROCESS_STATUS_ALIASES.get(raw, raw)
    if normalized not in _PUBLIC_PROCESS_STATUSES:
        raise ValueError(f"invalid process status: {value!r}")
    return normalized


class FormalProcessRuntime:
    def __init__(self, *, claim_validator: Any, supervisor: InternalExecutionSupervisor, id_factory: Callable[[], str], manager: Any | None = None, session_runtime: Any | None = None) -> None:
        self.claim_validator = claim_validator
        self.supervisor = supervisor
        self.id_factory = id_factory
        # Keep the legacy-compatible manager out of formal MySQL import paths.
        # The lifecycle injects/loads it only after the internal plane is
        # installed; unit tests can provide a protocol fake directly.
        if manager is None:
            from sandbox.services.process_manager import process_manager

            manager = process_manager
        self.manager = manager
        self.session_runtime = session_runtime
        self._inflight: dict[str, dict[str, Any]] = {}
        self._inflight_lock = threading.Lock()

    async def handle(self, *, claims: Mapping[str, Any], raw_body: bytes, tool_name: str) -> JSONResponse:
        try:
            command = parse_and_bind_internal_process(raw_body, claims, tool_name=tool_name)
        except InternalProcessContractError as exc:
            logger.warning("formal process contract rejected tool=%s code=%s", tool_name, exc.code)
            raise HTTPException(status_code=400, detail="Invalid request") from None
        try:
            return await self.supervisor.run_shielded(self._orchestrate(command))
        except SupervisorAdmissionError:
            raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None

    async def _orchestrate(self, command: InternalProcessCommand) -> JSONResponse:
        try:
            claimed = await run_in_threadpool(self.claim_validator.claim, self._claim_input(command))
        except NotFoundError:
            raise HTTPException(status_code=404, detail="Not found") from None
        except (ConflictError, IdempotencyKeyReuseError):
            raise HTTPException(status_code=409, detail="Conflict") from None
        except Exception:
            logger.exception("formal process claim failed tool=%s", command.tool_name)
            raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
        created = claimed.get("created") if isinstance(claimed, Mapping) else None
        execution = claimed.get("execution") if isinstance(claimed, Mapping) else None
        workspace_id = claimed.get("workspace_id") if isinstance(claimed, Mapping) else None
        if type(created) is not bool or not isinstance(execution, ExecutionRecord) or type(workspace_id) is not str:
            raise HTTPException(status_code=500, detail="Internal error")
        if created is False:
            return self._replay(execution)
        with self._inflight_lock:
            self._inflight[execution.execution_id] = {"org_id": command.org_id, "user_id": command.user_id, "execution_id": execution.execution_id, "execution_fence_token": command.execution_fence_token}
        try:
            try:
                result, terminal, error_code = await run_in_threadpool(self._run_sync, command, execution.execution_id, workspace_id)
            except Exception:
                logger.exception("formal process operation failed tool=%s", command.tool_name)
                recovered = await run_in_threadpool(self._mark_unknown, command, execution.execution_id)
                if recovered:
                    with self._inflight_lock:
                        self._inflight.pop(execution.execution_id, None)
                raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
            try:
                await run_in_threadpool(self.claim_validator.finalize, {
                    "org_id": command.org_id, "user_id": command.user_id,
                    "execution_id": execution.execution_id,
                    "execution_fence_token": command.execution_fence_token,
                    "status": terminal, "result_json": result,
                    "exit_code": result.get("exitCode"), "error_code": error_code,
                })
            except Exception:
                logger.exception("formal process finalize failed tool=%s", command.tool_name)
                recovered = await run_in_threadpool(self._mark_unknown, command, execution.execution_id)
                if recovered:
                    with self._inflight_lock:
                        self._inflight.pop(execution.execution_id, None)
                raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
            with self._inflight_lock:
                self._inflight.pop(execution.execution_id, None)
            response = dict(result)
            status_code = int(response.pop("_httpStatus", 200))
            return JSONResponse(status_code=status_code, content=response)
        except HTTPException:
            raise

    def _run_sync(self, command: InternalProcessCommand, execution_id: str, workspace_id: str) -> tuple[dict[str, Any], str, str | None]:
        token = set_trace_id(command.trace_id)
        try:
            return self._run_sync_with_trace(command, execution_id, workspace_id)
        finally:
            reset_trace_id(token)

    def _run_sync_with_trace(self, command: InternalProcessCommand, execution_id: str, workspace_id: str) -> tuple[dict[str, Any], str, str | None]:
        if command.tool_name == "process_start":
            context = self._context(command, workspace_id)
            raw = self.manager.start(
                session_id=command.sandbox_session_id,
                command=command.args["command"], env=command.args["env"],
                timeout=command.args["timeoutSeconds"], context=context,
                run_id=command.run_id, org_id=command.org_id,
                conversation_id=command.conversation_id,
                sandbox_session_id=command.sandbox_session_id,
                execution_id=execution_id,
            )
            raw_status = str(raw.get("status") or "").lower()
            response_status = (
                raw_status
                if raw_status in {"invalid", "blocked", "conflict", "quota_exceeded"}
                else _public_process_status(raw.get("status"))
            )
            result = {
                "processId": raw.get("process_id"), "status": response_status,
                "stdoutCursor": raw.get("stdout_cursor") or "0-0", "stderrCursor": raw.get("stderr_cursor") or "0-0",
                "startedAt": raw.get("started_at"),
            }
            if raw.get("error"):
                result["error"] = str(raw["error"])
            return self._result_or_failure(result, raw.get("status"))

        owned = self.manager.get_owned(command.args["processId"], org_id=command.org_id, user_id=command.user_id, sandbox_session_id=command.sandbox_session_id)
        if owned is None:
            return {"error": {"code": "PROCESS_NOT_FOUND", "message": "Process not found"}, "_httpStatus": 404}, SANDBOX_EXECUTION_STATUS_FAILED, "PROCESS_NOT_FOUND"
        if command.tool_name == "process_status":
            return {
                "processId": owned.get("process_id"), "status": _public_process_status(owned.get("status")),
                "exitCode": owned.get("exit_code"), "startedAt": owned.get("started_at"),
                "elapsedSeconds": owned.get("elapsed_seconds"), "pid": owned.get("pid"),
                "stdoutCursor": owned.get("stdout_cursor") or "0-0", "stderrCursor": owned.get("stderr_cursor") or "0-0",
            }, SANDBOX_EXECUTION_STATUS_SUCCESS, None
        if command.tool_name == "process_read":
            raw = self.manager.read_stream_owned(command.args["processId"], org_id=command.org_id, user_id=command.user_id, sandbox_session_id=command.sandbox_session_id, stream=command.args["stream"], cursor=command.args["cursor"], limit=command.args["limit"])
            if raw is None:
                return {"error": {"code": "PROCESS_NOT_FOUND", "message": "Process not found"}, "_httpStatus": 404}, SANDBOX_EXECUTION_STATUS_FAILED, "PROCESS_NOT_FOUND"
            if raw.get("status") == "invalid":
                return {"error": {"code": "CURSOR_INVALID", "message": raw.get("error") or "Invalid cursor"}, "_httpStatus": 400}, SANDBOX_EXECUTION_STATUS_FAILED, "CURSOR_INVALID"
            return {"processId": command.args["processId"], "stream": raw.get("stream"), "cursor": raw.get("cursor"), "nextCursor": raw.get("next_cursor"), "data": raw.get("data") or "", "truncated": bool(raw.get("truncated")), "completed": bool(raw.get("completed")), "status": _public_process_status(raw.get("status"))}, SANDBOX_EXECUTION_STATUS_SUCCESS, None
        raw = self.manager.signal_process_owned(command.args["processId"], command.args["signal"], org_id=command.org_id, user_id=command.user_id, sandbox_session_id=command.sandbox_session_id)
        if not raw.get("ok"):
            status_code = 404 if raw.get("status") == "not_found" else 409
            return {"error": {"code": "PROCESS_SIGNAL_NOT_DELIVERED", "message": "Process signal not delivered"}, "_httpStatus": status_code}, SANDBOX_EXECUTION_STATUS_FAILED, "PROCESS_SIGNAL_NOT_DELIVERED"
        return {"processId": command.args["processId"], "signal": command.args["signal"], "status": _public_process_status(raw.get("status"), fallback="running"), "signaled": bool(raw.get("signaled", True))}, SANDBOX_EXECUTION_STATUS_SUCCESS, None

    @staticmethod
    def _result_or_failure(result: dict[str, Any], status: Any) -> tuple[dict[str, Any], str, str | None]:
        status_s = str(status or "").lower()
        if status_s in {"invalid", "blocked", "quota_exceeded"} or not result.get("processId"):
            result["_httpStatus"] = 403 if status_s == "blocked" else 409 if status_s in {"conflict", "quota_exceeded"} else 400
            return result, SANDBOX_EXECUTION_STATUS_FAILED, status_s.upper() or "PROCESS_START_FAILED"
        return result, SANDBOX_EXECUTION_STATUS_SUCCESS, None

    def _context(self, command: InternalProcessCommand, workspace_id: str) -> SandboxExecutionContext:
        workspace = workspace_manager.init_workspace(workspace_id)
        temp = workspace_manager.init_temp(workspace_id)
        return SandboxExecutionContext(session_id=command.sandbox_session_id, workspace_id=workspace_id, temp_id=temp.name, physical_workspace=workspace, physical_temp=temp, user_id=command.user_id)

    def _claim_input(self, c: InternalProcessCommand) -> dict[str, Any]:
        return {"org_id": c.org_id, "user_id": c.user_id, "execution_id": self.id_factory(), "sandbox_session_id": c.sandbox_session_id, "run_id": c.run_id, "agent_session_id": c.agent_session_id, "conversation_id": c.conversation_id, "tool_execution_id": c.tool_execution_id, "tool_call_id": c.tool_call_id, "tool_name": c.tool_name, "kind": c.tool_name, "request_hash": c.request_hash, "request_hash_version": c.request_hash_version, "execution_fence_token": c.execution_fence_token, "trace_id": c.trace_id}

    @staticmethod
    def _replay(execution: ExecutionRecord) -> JSONResponse:
        if execution.status in (SANDBOX_EXECUTION_STATUS_SUCCESS, SANDBOX_EXECUTION_STATUS_FAILED, SANDBOX_EXECUTION_STATUS_TIMEOUT) and isinstance(execution.result_json, dict):
            result = dict(execution.result_json)
            status_code = int(result.pop("_httpStatus", 200))
            return JSONResponse(status_code=status_code, content=result)
        code = {SANDBOX_EXECUTION_STATUS_RUNNING: "IN_PROGRESS", SANDBOX_EXECUTION_STATUS_CANCELLED: "CANCELLED", SANDBOX_EXECUTION_STATUS_UNKNOWN: "TOOL_OUTCOME_UNKNOWN"}.get(execution.status, "TOOL_OUTCOME_UNKNOWN")
        return JSONResponse(status_code=409, content={"error": {"code": code, "message": "Tool execution unavailable"}})

    def _mark_unknown(self, c: InternalProcessCommand, execution_id: str) -> bool:
        try:
            self.claim_validator.mark_unknown_for_crash_recovery({"org_id": c.org_id, "user_id": c.user_id, "execution_id": execution_id, "execution_fence_token": c.execution_fence_token, "error_code": "POST_PROCESS_FINALIZE_FAILED", "result_json": {"unknown": True, "reason": "POST_PROCESS_FINALIZE_FAILED"}})
            return True
        except Exception:
            logger.exception("formal process UNKNOWN recovery failed")
            return False

    def reconcile_inflight_as_unknown(self) -> int:
        count = 0
        with self._inflight_lock:
            pending = list(self._inflight.values())
        for item in pending:
            try:
                self.claim_validator.mark_unknown_for_crash_recovery({**item, "error_code": "SHUTDOWN_DRAIN_TIMEOUT", "result_json": {"unknown": True, "reason": "SHUTDOWN_DRAIN_TIMEOUT"}})
                with self._inflight_lock:
                    self._inflight.pop(item["execution_id"], None)
                count += 1
            except Exception:
                logger.exception("formal process reconcile failed")
        return count


def set_formal_process_runtime(app: Any, runtime: FormalProcessRuntime | None) -> None:
    setattr(app.state, FORMAL_PROCESS_RUNTIME_STATE_KEY, runtime)


def get_formal_process_runtime(app: Any) -> FormalProcessRuntime | None:
    return getattr(app.state, FORMAL_PROCESS_RUNTIME_STATE_KEY, None)


__all__ = ["FormalProcessRuntime", "get_formal_process_runtime", "set_formal_process_runtime"]
