"""Claim/finalize orchestration for the internal ``submit_artifact`` tool."""

from __future__ import annotations

import logging
import threading
from collections.abc import Mapping
from typing import Any, Callable

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.internal_artifact_contract import (
    InternalArtifactCommand,
    InternalArtifactContractError,
    parse_and_bind_internal_artifact,
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
from sandbox.services.artifact_manager import ArtifactError, ArtifactManager, artifact_manager
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor, SupervisorAdmissionError
from sandbox.services.workspace_manager import workspace_manager

logger = logging.getLogger("sandbox.services.formal_artifact_runtime")
FORMAL_ARTIFACT_RUNTIME_STATE_KEY = "formal_artifact_runtime"


class FormalArtifactRuntime:
    def __init__(self, *, claim_validator: Any, supervisor: InternalExecutionSupervisor, id_factory: Callable[[], str], manager: ArtifactManager = artifact_manager) -> None:
        self.claim_validator = claim_validator
        self.supervisor = supervisor
        self.id_factory = id_factory
        self.manager = manager
        self._inflight: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    async def handle(self, *, claims: Mapping[str, Any], raw_body: bytes) -> JSONResponse:
        try:
            command = parse_and_bind_internal_artifact(raw_body, claims)
        except InternalArtifactContractError:
            raise HTTPException(status_code=400, detail="Invalid request") from None
        try:
            return await self.supervisor.run_shielded(self._orchestrate(command))
        except SupervisorAdmissionError:
            raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None

    async def _orchestrate(self, command: InternalArtifactCommand) -> JSONResponse:
        try:
            claimed = await run_in_threadpool(self.claim_validator.claim, self._claim_input(command))
        except NotFoundError:
            raise HTTPException(status_code=404, detail="Not found") from None
        except (ConflictError, IdempotencyKeyReuseError):
            raise HTTPException(status_code=409, detail="Conflict") from None
        except Exception:
            logger.exception("formal artifact claim failed")
            raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
        created = claimed.get("created") if isinstance(claimed, Mapping) else None
        execution = claimed.get("execution") if isinstance(claimed, Mapping) else None
        workspace_id = claimed.get("workspace_id") if isinstance(claimed, Mapping) else None
        if type(created) is not bool or not isinstance(execution, ExecutionRecord) or type(workspace_id) is not str or not workspace_id:
            raise HTTPException(status_code=500, detail="Internal error")
        if not created:
            return self._replay(execution)
        with self._lock:
            self._inflight[execution.execution_id] = {"org_id": command.org_id, "user_id": command.user_id, "execution_id": execution.execution_id, "execution_fence_token": command.execution_fence_token}
        try:
            try:
                result, terminal, error_code = await run_in_threadpool(self._execute_sync, command, execution.execution_id, workspace_id)
            except Exception:
                logger.exception("formal artifact operation failed")
                recovered = await run_in_threadpool(self._mark_unknown, command, execution.execution_id)
                if recovered: self._clear(execution.execution_id)
                raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
            try:
                await run_in_threadpool(self.claim_validator.finalize, {"org_id": command.org_id, "user_id": command.user_id, "execution_id": execution.execution_id, "execution_fence_token": command.execution_fence_token, "status": terminal, "result_json": result, "exit_code": result.get("exitCode"), "error_code": error_code})
            except Exception:
                logger.exception("formal artifact finalize failed")
                recovered = await run_in_threadpool(self._mark_unknown, command, execution.execution_id)
                if recovered: self._clear(execution.execution_id)
                raise HTTPException(status_code=503, detail="Service temporarily unavailable") from None
            self._clear(execution.execution_id)
            status_code = int(result.pop("_httpStatus", 200))
            return JSONResponse(status_code=status_code, content=result)
        except HTTPException:
            raise

    def _execute_sync(self, command: InternalArtifactCommand, execution_id: str, workspace_id: str) -> tuple[dict[str, Any], str, str | None]:
        workspace = workspace_manager.init_workspace(workspace_id)
        temp = workspace_manager.init_temp(workspace_id)
        context = SandboxExecutionContext(session_id=command.sandbox_session_id, workspace_id=workspace_id, temp_id=temp.name, physical_workspace=workspace, physical_temp=temp, user_id=command.user_id)
        try:
            response = self.manager.submit(session_id=command.sandbox_session_id, path=command.path, name=command.display_name, mime_type=None, source_execution_id=execution_id, physical_workspace=context.physical_workspace, physical_temp=context.physical_temp, org_id=command.org_id, user_id=command.user_id, conversation_id=command.conversation_id, agent_session_id=command.agent_session_id, run_id=command.run_id, workspace_id=workspace_id)
            return {"artifactId": response.artifact_id, "path": command.path, "name": response.name, "displayName": response.name, "mimeType": response.mime_type, "sha256": response.sha256, "size": response.size, "status": response.status}, SANDBOX_EXECUTION_STATUS_SUCCESS, None
        except ArtifactError as exc:
            return {"error": {"code": exc.code, "message": exc.message}, "_httpStatus": exc.status}, SANDBOX_EXECUTION_STATUS_FAILED, exc.code

    def _claim_input(self, c: InternalArtifactCommand) -> dict[str, Any]:
        return {"org_id": c.org_id, "user_id": c.user_id, "execution_id": self.id_factory(), "sandbox_session_id": c.sandbox_session_id, "run_id": c.run_id, "agent_session_id": c.agent_session_id, "conversation_id": c.conversation_id, "tool_execution_id": c.tool_execution_id, "tool_call_id": c.tool_call_id, "tool_name": "submit_artifact", "kind": "submit_artifact", "request_hash": c.request_hash, "request_hash_version": c.request_hash_version, "execution_fence_token": c.execution_fence_token, "trace_id": c.trace_id}

    @staticmethod
    def _replay(execution: ExecutionRecord) -> JSONResponse:
        if execution.status in (SANDBOX_EXECUTION_STATUS_SUCCESS, SANDBOX_EXECUTION_STATUS_FAILED, SANDBOX_EXECUTION_STATUS_TIMEOUT) and isinstance(execution.result_json, dict):
            result = dict(execution.result_json)
            return JSONResponse(status_code=int(result.pop("_httpStatus", 200)), content=result)
        code = {SANDBOX_EXECUTION_STATUS_RUNNING: "IN_PROGRESS", SANDBOX_EXECUTION_STATUS_CANCELLED: "CANCELLED", SANDBOX_EXECUTION_STATUS_UNKNOWN: "TOOL_OUTCOME_UNKNOWN"}.get(execution.status, "TOOL_OUTCOME_UNKNOWN")
        return JSONResponse(status_code=409, content={"error": {"code": code, "message": "Tool execution unavailable"}})

    def _mark_unknown(self, c: InternalArtifactCommand, execution_id: str) -> bool:
        try:
            self.claim_validator.mark_unknown_for_crash_recovery({"org_id": c.org_id, "user_id": c.user_id, "execution_id": execution_id, "execution_fence_token": c.execution_fence_token, "error_code": "POST_ARTIFACT_FINALIZE_FAILED", "result_json": {"unknown": True, "reason": "POST_ARTIFACT_FINALIZE_FAILED"}})
            return True
        except Exception:
            logger.exception("formal artifact UNKNOWN recovery failed")
            return False

    def _clear(self, execution_id: str) -> None:
        with self._lock: self._inflight.pop(execution_id, None)

    def reconcile_inflight_as_unknown(self) -> int:
        with self._lock: pending = list(self._inflight.values())
        count = 0
        for item in pending:
            try:
                self.claim_validator.mark_unknown_for_crash_recovery({**item, "error_code": "SHUTDOWN_DRAIN_TIMEOUT", "result_json": {"unknown": True, "reason": "SHUTDOWN_DRAIN_TIMEOUT"}})
                self._clear(item["execution_id"]); count += 1
            except Exception: logger.exception("formal artifact reconcile failed")
        return count


def set_formal_artifact_runtime(app: Any, runtime: FormalArtifactRuntime | None) -> None: setattr(app.state, FORMAL_ARTIFACT_RUNTIME_STATE_KEY, runtime)
def get_formal_artifact_runtime(app: Any) -> FormalArtifactRuntime | None: return getattr(app.state, FORMAL_ARTIFACT_RUNTIME_STATE_KEY, None)

__all__ = ["FormalArtifactRuntime", "get_formal_artifact_runtime", "set_formal_artifact_runtime"]
