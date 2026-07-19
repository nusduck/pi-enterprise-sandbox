"""Claimed MySQL-authoritative runtime for synchronous bash/Python tools."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.internal_execution_contract import (
    InternalExecutionCommand,
    InternalExecutionContractError,
    parse_and_bind_internal_execution,
)
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_CANCELLED,
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_TIMEOUT,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.app.persistence.errors import (
    ConflictError,
    IdempotencyKeyReuseError,
    NotFoundError,
)
from sandbox.models import ExecutionStatus
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_manager import execution_manager
from sandbox.services.internal_execution_supervisor import (
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.policy_checker import policy_checker
from sandbox.services.workspace_manager import workspace_manager
from sandbox.trace import reset_trace_id, set_trace_id

logger = logging.getLogger("sandbox.services.formal_execution_runtime")

FORMAL_EXECUTION_RUNTIME_STATE_KEY = "formal_execution_runtime"


class FormalExecutionRuntime:
    """One-shot claim -> execute once -> finalize orchestration."""

    def __init__(
        self,
        *,
        claim_validator: Any,
        supervisor: InternalExecutionSupervisor,
        id_factory: Callable[[], str],
        manager: Any = execution_manager,
    ) -> None:
        self.claim_validator = claim_validator
        self.supervisor = supervisor
        self.id_factory = id_factory
        self.manager = manager
        self._inflight_lock = threading.Lock()
        self._inflight: dict[str, dict[str, Any]] = {}

    async def handle(
        self,
        *,
        claims: Mapping[str, Any],
        raw_body: bytes,
        tool_name: str,
    ) -> JSONResponse:
        try:
            command = parse_and_bind_internal_execution(
                raw_body, claims, tool_name=tool_name
            )
        except InternalExecutionContractError as exc:
            logger.warning(
                "formal execution contract rejected tool=%s code=%s",
                tool_name,
                exc.code,
            )
            raise HTTPException(status_code=400, detail="Invalid request") from None
        try:
            return await self.supervisor.run_shielded(self._orchestrate(command))
        except SupervisorAdmissionError:
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

    async def _orchestrate(self, command: InternalExecutionCommand) -> JSONResponse:
        try:
            claimed = await run_in_threadpool(
                self.claim_validator.claim, self._claim_input(command)
            )
        except NotFoundError:
            raise HTTPException(status_code=404, detail="Not found") from None
        except (ConflictError, IdempotencyKeyReuseError):
            raise HTTPException(status_code=409, detail="Conflict") from None
        except Exception:
            logger.exception("formal execution claim failed tool=%s", command.tool_name)
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

        created = claimed.get("created") if isinstance(claimed, Mapping) else None
        execution = claimed.get("execution") if isinstance(claimed, Mapping) else None
        workspace_id = claimed.get("workspace_id") if isinstance(claimed, Mapping) else None
        if type(created) is not bool or not isinstance(execution, ExecutionRecord):  # noqa: E721
            raise HTTPException(status_code=500, detail="Internal error")
        if type(workspace_id) is not str or not workspace_id:
            raise HTTPException(status_code=500, detail="Internal error")
        if created is False:
            return self._replay(execution)

        self._register_inflight(command, execution)
        result, terminal, error_code = await run_in_threadpool(
            self._execute_sync, command, execution.execution_id, workspace_id
        )
        try:
            await run_in_threadpool(
                self.claim_validator.finalize,
                {
                    "org_id": command.org_id,
                    "user_id": command.user_id,
                    "execution_id": execution.execution_id,
                    "execution_fence_token": command.execution_fence_token,
                    "status": terminal,
                    "result_json": result,
                    "exit_code": result.get("exitCode"),
                    "error_code": error_code,
                },
            )
        except Exception:
            logger.exception(
                "formal execution finalize failed tool=%s", command.tool_name
            )
            recovered = await run_in_threadpool(
                self._mark_unknown_after_finalize_failure,
                command,
                execution.execution_id,
            )
            if recovered:
                self._clear_inflight(execution.execution_id)
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None
        else:
            self._clear_inflight(execution.execution_id)
        return JSONResponse(status_code=200, content=result)

    def _execute_sync(
        self,
        command: InternalExecutionCommand,
        execution_id: str,
        workspace_id: str,
    ) -> tuple[dict[str, Any], str, str | None]:
        token = set_trace_id(command.trace_id)
        try:
            try:
                return self._execute_sync_with_trace(
                    command, execution_id, workspace_id
                )
            except Exception:
                logger.exception(
                    "formal execution runner failed tool=%s", command.tool_name
                )
                return (
                    {
                        "exitCode": -1,
                        "stdout": "",
                        "stderr": "execution failed",
                        "truncated": False,
                        "durationMs": 0.0,
                    },
                    SANDBOX_EXECUTION_STATUS_FAILED,
                    "EXECUTION_FAILED",
                )
        finally:
            reset_trace_id(token)

    def _execute_sync_with_trace(
        self,
        command: InternalExecutionCommand,
        execution_id: str,
        workspace_id: str,
    ) -> tuple[dict[str, Any], str, str | None]:
        physical_workspace = workspace_manager.init_workspace(workspace_id)
        physical_temp = workspace_manager.init_temp(workspace_id)
        context = SandboxExecutionContext(
            session_id=command.sandbox_session_id,
            workspace_id=workspace_id,
            temp_id=physical_temp.name,
            physical_workspace=physical_workspace,
            physical_temp=physical_temp,
            user_id=command.user_id,
        )
        if command.tool_name == "bash" and policy_checker.is_blocked_command(
            command.args["command"]
        ):
            result = {
                "exitCode": -1,
                "stdout": "",
                "stderr": "command denied by Sandbox policy",
                "truncated": False,
                "durationMs": 0.0,
            }
            return result, SANDBOX_EXECUTION_STATUS_FAILED, "COMMAND_BLOCKED"

        try:
            if command.tool_name == "bash":
                raw = self.manager.run_command(
                    session_id=command.sandbox_session_id,
                    command=command.args["command"],
                    timeout=command.args["timeoutSeconds"],
                    env_overrides=command.args["env"],
                    run_id=command.run_id,
                    context=context,
                    execution_id=execution_id,
                    formal_claimed=True,
                )
            else:
                raw = self.manager.run_python(
                    session_id=command.sandbox_session_id,
                    code=command.args["code"],
                    args=command.args["args"],
                    timeout=command.args["timeoutSeconds"],
                    run_id=command.run_id,
                    context=context,
                    execution_id=execution_id,
                    formal_claimed=True,
                )
        except Exception:
            logger.exception("formal execution runner failed tool=%s", command.tool_name)
            raw = {
                "status": ExecutionStatus.FAILED,
                "exit_code": -1,
                "stdout_preview": "",
                "stderr_preview": "execution failed",
                "truncated": False,
                "duration_ms": 0.0,
            }

        status_raw = raw.get("status") if isinstance(raw, Mapping) else None
        status = status_raw.value if hasattr(status_raw, "value") else str(status_raw or "")
        terminal = {
            ExecutionStatus.SUCCESS.value: SANDBOX_EXECUTION_STATUS_SUCCESS,
            ExecutionStatus.TIMEOUT.value: SANDBOX_EXECUTION_STATUS_TIMEOUT,
            ExecutionStatus.CANCELLED.value: SANDBOX_EXECUTION_STATUS_CANCELLED,
        }.get(status, SANDBOX_EXECUTION_STATUS_FAILED)
        result = {
            "exitCode": raw.get("exit_code", -1),
            "stdout": str(raw.get("stdout_preview") or ""),
            "stderr": str(raw.get("stderr_preview") or ""),
            "truncated": bool(raw.get("truncated")),
            "durationMs": float(raw.get("duration_ms") or 0.0),
        }
        if command.tool_name == "python":
            result.update(
                {
                    "materializedPath": raw.get("materialized_path"),
                    "pythonVersion": raw.get("python_version"),
                    "pythonMode": raw.get("python_mode"),
                }
            )
        error_code = None if terminal == SANDBOX_EXECUTION_STATUS_SUCCESS else status.upper() or "EXECUTION_FAILED"
        return result, terminal, error_code

    def _claim_input(self, command: InternalExecutionCommand) -> dict[str, Any]:
        return {
            "org_id": command.org_id,
            "user_id": command.user_id,
            "execution_id": self.id_factory(),
            "sandbox_session_id": command.sandbox_session_id,
            "run_id": command.run_id,
            "agent_session_id": command.agent_session_id,
            "conversation_id": command.conversation_id,
            "tool_execution_id": command.tool_execution_id,
            "tool_call_id": command.tool_call_id,
            "tool_name": command.tool_name,
            "kind": command.tool_name,
            "request_hash": command.request_hash,
            "request_hash_version": command.request_hash_version,
            "execution_fence_token": command.execution_fence_token,
            "trace_id": command.trace_id,
        }

    @staticmethod
    def _replay(execution: ExecutionRecord) -> JSONResponse:
        if execution.status in (
            SANDBOX_EXECUTION_STATUS_SUCCESS,
            SANDBOX_EXECUTION_STATUS_FAILED,
            SANDBOX_EXECUTION_STATUS_TIMEOUT,
        ) and isinstance(execution.result_json, dict):
            return JSONResponse(status_code=200, content=execution.result_json)
        code = {
            SANDBOX_EXECUTION_STATUS_RUNNING: "IN_PROGRESS",
            SANDBOX_EXECUTION_STATUS_CANCELLED: "CANCELLED",
            SANDBOX_EXECUTION_STATUS_UNKNOWN: "TOOL_OUTCOME_UNKNOWN",
        }.get(execution.status, "TOOL_OUTCOME_UNKNOWN")
        return JSONResponse(
            status_code=409,
            content={"error": {"code": code, "message": "Tool execution unavailable"}},
        )

    def _register_inflight(
        self, command: InternalExecutionCommand, execution: ExecutionRecord
    ) -> None:
        with self._inflight_lock:
            self._inflight[execution.execution_id] = {
                "org_id": command.org_id,
                "user_id": command.user_id,
                "execution_id": execution.execution_id,
                "execution_fence_token": command.execution_fence_token,
            }

    def _clear_inflight(self, execution_id: str) -> None:
        with self._inflight_lock:
            self._inflight.pop(execution_id, None)

    def _mark_unknown_after_finalize_failure(
        self, command: InternalExecutionCommand, execution_id: str
    ) -> bool:
        try:
            self.claim_validator.mark_unknown_for_crash_recovery(
                {
                    "org_id": command.org_id,
                    "user_id": command.user_id,
                    "execution_id": execution_id,
                    "execution_fence_token": command.execution_fence_token,
                    "error_code": "POST_EXECUTION_FINALIZE_FAILED",
                    "result_json": {
                        "unknown": True,
                        "reason": "POST_EXECUTION_FINALIZE_FAILED",
                    },
                }
            )
            return True
        except Exception as exc:
            logger.warning(
                "formal execution UNKNOWN recovery failed type=%s",
                type(exc).__name__,
            )
            return False

    def reconcile_inflight_as_unknown(self) -> int:
        with self._inflight_lock:
            pending = list(self._inflight.values())
        reconciled = 0
        for item in pending:
            try:
                self.claim_validator.mark_unknown_for_crash_recovery(
                    {
                        **item,
                        "error_code": "SHUTDOWN_DRAIN_TIMEOUT",
                        "result_json": {
                            "unknown": True,
                            "reason": "SHUTDOWN_DRAIN_TIMEOUT",
                        },
                    }
                )
                reconciled += 1
                self._clear_inflight(item["execution_id"])
            except Exception as exc:
                logger.warning(
                    "formal execution reconcile failed type=%s", type(exc).__name__
                )
        return reconciled


def set_formal_execution_runtime(app: Any, runtime: FormalExecutionRuntime | None) -> None:
    setattr(app.state, FORMAL_EXECUTION_RUNTIME_STATE_KEY, runtime)


def get_formal_execution_runtime(app: Any) -> FormalExecutionRuntime | None:
    return getattr(app.state, FORMAL_EXECUTION_RUNTIME_STATE_KEY, None)


__all__ = [
    "FormalExecutionRuntime",
    "get_formal_execution_runtime",
    "set_formal_execution_runtime",
]
