"""Agent internal plane runtime for the read-only workspace search tools.

`ls` / `find` / `grep` follow the same claim -> run once -> finalize pipeline as
every other formal tool, so a search is an auditable ToolExecution and a retry
replays instead of re-running. They differ from the process tools in one way
that matters: they never mutate the workspace, so a failure is always an
ordinary FAILED with a code — never TOOL_OUTCOME_UNKNOWN. The caller can just
ask again.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Mapping

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.internal_search_contract import (
    InternalSearchCommand,
    InternalSearchContractError,
    parse_and_bind_internal_search,
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
from sandbox.services.internal_execution_supervisor import (
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.workspace_manager import workspace_manager
from sandbox.trace import reset_trace_id, set_trace_id

logger = logging.getLogger("sandbox.services.formal_search_runtime")

FORMAL_SEARCH_RUNTIME_STATE_KEY = "formal_search_runtime"

SEARCH_TOOL_NAMES = ("ls", "find", "grep")


class FormalSearchRuntime:
    """Injectable claim/search/finalize runtime for ls, find and grep."""

    def __init__(
        self,
        *,
        claim_validator: Any,
        supervisor: InternalExecutionSupervisor,
        id_factory: Callable[[], str],
        search_service: Any | None = None,
    ) -> None:
        self.claim_validator = claim_validator
        self.supervisor = supervisor
        self.id_factory = id_factory
        if search_service is None:
            from sandbox.services.file_search import file_search_service

            search_service = file_search_service
        self.search_service = search_service
        self._inflight: dict[str, dict[str, Any]] = {}
        self._inflight_lock = threading.Lock()

    async def handle(
        self, *, claims: Mapping[str, Any], raw_body: bytes, tool_name: str
    ) -> JSONResponse:
        try:
            command = parse_and_bind_internal_search(raw_body, claims, tool_name=tool_name)
        except InternalSearchContractError as exc:
            logger.warning(
                "formal search contract rejected tool=%s code=%s", tool_name, exc.code
            )
            raise HTTPException(status_code=400, detail="Invalid request") from None
        try:
            return await self.supervisor.run_shielded(self._orchestrate(command))
        except SupervisorAdmissionError:
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

    async def _orchestrate(self, command: InternalSearchCommand) -> JSONResponse:
        try:
            claimed = await run_in_threadpool(
                self.claim_validator.claim, self._claim_input(command)
            )
        except NotFoundError:
            raise HTTPException(status_code=404, detail="Not found") from None
        except (ConflictError, IdempotencyKeyReuseError):
            raise HTTPException(status_code=409, detail="Conflict") from None
        except Exception:
            logger.exception("formal search claim failed tool=%s", command.tool_name)
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

        created = claimed.get("created") if isinstance(claimed, Mapping) else None
        execution = claimed.get("execution") if isinstance(claimed, Mapping) else None
        workspace_id = claimed.get("workspace_id") if isinstance(claimed, Mapping) else None
        if (
            type(created) is not bool
            or not isinstance(execution, ExecutionRecord)
            or type(workspace_id) is not str
        ):
            raise HTTPException(status_code=500, detail="Internal error")
        if created is False:
            return self._replay(execution)

        inflight = {
            "org_id": command.org_id,
            "user_id": command.user_id,
            "execution_id": execution.execution_id,
            "execution_fence_token": command.execution_fence_token,
        }
        with self._inflight_lock:
            self._inflight[execution.execution_id] = inflight

        try:
            result, terminal, error_code = await run_in_threadpool(
                self._run_sync, command, workspace_id
            )
        except Exception:
            logger.exception("formal search operation failed tool=%s", command.tool_name)
            # Read-only: nothing was mutated, so record an honest FAILED rather
            # than UNKNOWN. Re-running the same search is always safe.
            await self._finalize_or_unknown(
                command,
                execution.execution_id,
                {
                    "error": {
                        "code": "SEARCH_FAILED",
                        "message": "Workspace search failed",
                    }
                },
                SANDBOX_EXECUTION_STATUS_FAILED,
                "SEARCH_FAILED",
            )
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

        finalized = await self._finalize_or_unknown(
            command, execution.execution_id, result, terminal, error_code
        )
        if not finalized:
            raise HTTPException(status_code=503, detail="Service temporarily unavailable")

        response = dict(result)
        status_code = int(response.pop("_httpStatus", 200))
        return JSONResponse(status_code=status_code, content=response)

    async def _finalize_or_unknown(
        self,
        command: InternalSearchCommand,
        execution_id: str,
        result: dict[str, Any],
        terminal: str,
        error_code: str | None,
    ) -> bool:
        try:
            await run_in_threadpool(
                self.claim_validator.finalize,
                {
                    "org_id": command.org_id,
                    "user_id": command.user_id,
                    "execution_id": execution_id,
                    "execution_fence_token": command.execution_fence_token,
                    "status": terminal,
                    "result_json": result,
                    "exit_code": None,
                    "error_code": error_code,
                },
            )
        except Exception:
            logger.exception("formal search finalize failed tool=%s", command.tool_name)
            await run_in_threadpool(self._mark_unknown, command, execution_id)
            with self._inflight_lock:
                self._inflight.pop(execution_id, None)
            return False
        with self._inflight_lock:
            self._inflight.pop(execution_id, None)
        return True

    def _run_sync(
        self, command: InternalSearchCommand, workspace_id: str
    ) -> tuple[dict[str, Any], str, str | None]:
        token = set_trace_id(command.trace_id)
        try:
            return self._run_sync_with_trace(command, workspace_id)
        finally:
            reset_trace_id(token)

    def _run_sync_with_trace(
        self, command: InternalSearchCommand, workspace_id: str
    ) -> tuple[dict[str, Any], str, str | None]:
        workspace = workspace_manager.init_workspace(workspace_id)
        temp = workspace_manager.init_temp(workspace_id)
        args = command.args
        try:
            if command.tool_name == "ls":
                found = self.search_service.ls(
                    str(workspace),
                    path=args["path"],
                    depth=args["depth"],
                    include_hidden=args["includeHidden"],
                    temp_path=str(temp),
                )
            elif command.tool_name == "find":
                found = self.search_service.find(
                    str(workspace),
                    path=args["path"],
                    pattern=args["pattern"],
                    type=args["type"],
                    max_depth=args["maxDepth"],
                    limit=args["limit"],
                    temp_path=str(temp),
                )
            else:
                found = self.search_service.grep(
                    str(workspace),
                    path=args["path"],
                    query=args["query"],
                    glob=args["glob"],
                    regex=args["regex"],
                    case_sensitive=args["caseSensitive"],
                    context=args["context"],
                    limit=args["limit"],
                    temp_path=str(temp),
                )
        except PermissionError:
            # Path escaped the workspace/temp roots. Same shape as a bad path so
            # the caller cannot probe what exists outside.
            return (
                {
                    "error": {
                        "code": "PATH_INVALID",
                        "message": "path must resolve inside the workspace",
                    },
                    "_httpStatus": 400,
                },
                SANDBOX_EXECUTION_STATUS_FAILED,
                "PATH_INVALID",
            )
        except ValueError as exc:
            return (
                {
                    "error": {
                        "code": "SEARCH_ARGUMENT_INVALID",
                        "message": str(exc)[:256] or "invalid search argument",
                    },
                    "_httpStatus": 400,
                },
                SANDBOX_EXECUTION_STATUS_FAILED,
                "SEARCH_ARGUMENT_INVALID",
            )

        payload = found.model_dump(mode="json")
        payload["tool"] = command.tool_name
        return payload, SANDBOX_EXECUTION_STATUS_SUCCESS, None

    def _claim_input(self, c: InternalSearchCommand) -> dict[str, Any]:
        return {
            "org_id": c.org_id,
            "user_id": c.user_id,
            "execution_id": self.id_factory(),
            "sandbox_session_id": c.sandbox_session_id,
            "run_id": c.run_id,
            "agent_session_id": c.agent_session_id,
            "conversation_id": c.conversation_id,
            "tool_execution_id": c.tool_execution_id,
            "tool_call_id": c.tool_call_id,
            "tool_name": c.tool_name,
            "kind": c.tool_name,
            "request_hash": c.request_hash,
            "request_hash_version": c.request_hash_version,
            "execution_fence_token": c.execution_fence_token,
            "trace_id": c.trace_id,
        }

    @staticmethod
    def _replay(execution: ExecutionRecord) -> JSONResponse:
        if execution.status in (
            SANDBOX_EXECUTION_STATUS_SUCCESS,
            SANDBOX_EXECUTION_STATUS_FAILED,
            SANDBOX_EXECUTION_STATUS_TIMEOUT,
        ) and isinstance(execution.result_json, dict):
            result = dict(execution.result_json)
            status_code = int(result.pop("_httpStatus", 200))
            return JSONResponse(status_code=status_code, content=result)
        code = {
            SANDBOX_EXECUTION_STATUS_RUNNING: "IN_PROGRESS",
            SANDBOX_EXECUTION_STATUS_CANCELLED: "CANCELLED",
            SANDBOX_EXECUTION_STATUS_UNKNOWN: "TOOL_OUTCOME_UNKNOWN",
        }.get(execution.status, "TOOL_OUTCOME_UNKNOWN")
        return JSONResponse(
            status_code=409,
            content={"error": {"code": code, "message": "Tool execution unavailable"}},
        )

    def _mark_unknown(self, c: InternalSearchCommand, execution_id: str) -> bool:
        try:
            self.claim_validator.mark_unknown_for_crash_recovery(
                {
                    "org_id": c.org_id,
                    "user_id": c.user_id,
                    "execution_id": execution_id,
                    "execution_fence_token": c.execution_fence_token,
                    "error_code": "POST_SEARCH_FINALIZE_FAILED",
                    "result_json": {
                        "unknown": True,
                        "reason": "POST_SEARCH_FINALIZE_FAILED",
                    },
                }
            )
            return True
        except Exception:
            logger.exception("formal search UNKNOWN recovery failed")
            return False

    def reconcile_inflight_as_unknown(self) -> int:
        count = 0
        with self._inflight_lock:
            pending = list(self._inflight.values())
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
                with self._inflight_lock:
                    self._inflight.pop(item["execution_id"], None)
                count += 1
            except Exception:
                logger.exception("formal search reconcile failed")
        return count


def set_formal_search_runtime(app: Any, runtime: FormalSearchRuntime | None) -> None:
    setattr(app.state, FORMAL_SEARCH_RUNTIME_STATE_KEY, runtime)


def get_formal_search_runtime(app: Any) -> FormalSearchRuntime | None:
    return getattr(app.state, FORMAL_SEARCH_RUNTIME_STATE_KEY, None)


__all__ = [
    "SEARCH_TOOL_NAMES",
    "FormalSearchRuntime",
    "get_formal_search_runtime",
    "set_formal_search_runtime",
]
