"""Claim/finalize orchestration for formal files.write and files.edit."""

from __future__ import annotations

import logging
import re
import threading
from collections.abc import Mapping
from typing import Any, Callable

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.internal_files_write_contract import (
    EditCommand,
    FilesWriteContractError,
    WriteCommand,
    parse_and_bind_files_edit,
    parse_and_bind_files_write,
)
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.app.persistence.errors import (
    ConflictError,
    IdempotencyKeyReuseError,
    NotFoundError,
)
from sandbox.security.path_validation import validate_formal_id
from sandbox.services.internal_execution_supervisor import (
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.internal_file_writer import (
    InternalFileWriteError,
    InternalFileWriter,
)

logger = logging.getLogger("sandbox.services.files_write_runtime")

FILES_WRITE_RUNTIME_STATE_KEY = "files_write_runtime"

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_ERROR_MESSAGE_MAX_LENGTH = 256
_ERROR_HTTP_STATUS = {
    "FILE_NOT_FOUND": 404,
    "PERMISSION_DENIED": 403,
    "FILE_TOO_LARGE": 413,
    "WORKSPACE_QUOTA_EXCEEDED": 413,
    "WORKSPACE_QUOTA_ENFORCEMENT_FAILED": 500,
    "FILE_VERSION_CONFLICT": 409,
    "FILE_CHANGED_DURING_EDIT": 409,
    "FILE_TEXT_NOT_FOUND": 400,
    "FILE_MULTIPLE_MATCH": 400,
    "PATH_INVALID": 400,
    "SYMLINK_REJECTED": 400,
    "NOT_REGULAR_FILE": 400,
    "INVALID_ENCODING": 400,
    "INVALID_ARGUMENT": 400,
    "FILE_OPERATION_FAILED": 500,
}


def _filter_success_result(
    result: Mapping[str, Any], *, tool: str, expected_path: str
) -> dict[str, Any]:
    keys = (
        ("path", "size", "hash", "version")
        if tool == "write"
        else ("path", "hash", "version", "beforeHash")
    )
    if not all(key in result for key in keys):
        raise ValueError("file result fields missing")
    filtered = {key: result[key] for key in keys}
    if filtered["path"] != expected_path:
        raise ValueError("file result path mismatch")
    if tool == "write" and (
        type(filtered["size"]) is not int or filtered["size"] < 0
    ):
        raise ValueError("file result size invalid")
    digest_keys = (
        ("hash", "version")
        if tool == "write"
        else ("hash", "version", "beforeHash")
    )
    for key in digest_keys:
        value = filtered[key]
        if type(value) is not str or _SHA256_RE.fullmatch(value) is None:
            raise ValueError("file result digest invalid")
    return filtered


def _filter_error_result(result: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
    error = result.get("error")
    if not isinstance(error, Mapping):
        raise ValueError("file error envelope missing")
    code = error.get("code")
    message = error.get("message")
    if type(code) is not str or code not in _ERROR_HTTP_STATUS:
        raise ValueError("file error code invalid")
    if type(message) is not str or not message or len(message) > _ERROR_MESSAGE_MAX_LENGTH:
        raise ValueError("file error message invalid")
    return _ERROR_HTTP_STATUS[code], {"error": {"code": code, "message": message}}


def _response_for_result(
    result: Mapping[str, Any],
    *,
    tool: str,
    expected_path: str,
    failed: bool,
) -> JSONResponse:
    if failed:
        status, body = _filter_error_result(result)
    else:
        status = 200
        body = _filter_success_result(result, tool=tool, expected_path=expected_path)
    return JSONResponse(status_code=status, content=body)


def _replay(
    execution: ExecutionRecord, *, tool: str, expected_path: str
) -> JSONResponse:
    try:
        if execution.status == SANDBOX_EXECUTION_STATUS_SUCCESS and isinstance(
            execution.result_json, Mapping
        ):
            return _response_for_result(
                execution.result_json,
                tool=tool,
                expected_path=expected_path,
                failed=False,
            )
        if execution.status == SANDBOX_EXECUTION_STATUS_FAILED and isinstance(
            execution.result_json, Mapping
        ):
            return _response_for_result(
                execution.result_json,
                tool=tool,
                expected_path=expected_path,
                failed=True,
            )
    except ValueError:
        logger.exception("files.%s persisted replay result is invalid", tool)
        raise HTTPException(status_code=500, detail="Internal error") from None

    code = {
        SANDBOX_EXECUTION_STATUS_RUNNING: "IN_PROGRESS",
        SANDBOX_EXECUTION_STATUS_UNKNOWN: "TOOL_OUTCOME_UNKNOWN",
    }.get(execution.status, "TOOL_OPERATION_UNAVAILABLE")
    return JSONResponse(
        status_code=409,
        content={
            "error": {"code": code, "message": "Tool execution unavailable"}
        },
    )


class FilesWriteRuntime:
    """One-shot claim -> mutate once -> finalize orchestration."""

    def __init__(
        self,
        *,
        claim_validator: Any,
        writer: Any | None = None,
        id_factory: Callable[[], str],
        supervisor: InternalExecutionSupervisor | None = None,
    ) -> None:
        self.claim_validator = claim_validator
        self.writer = writer or InternalFileWriter()
        self.id_factory = id_factory
        self.supervisor = supervisor or InternalExecutionSupervisor()
        self._inflight_lock = threading.Lock()
        self._inflight: dict[str, dict[str, Any]] = {}

    async def handle(
        self, *, tool: str, claims: Mapping[str, Any], raw_body: bytes
    ) -> JSONResponse:
        try:
            if tool == "write":
                command = parse_and_bind_files_write(raw_body, claims)
            elif tool == "edit":
                command = parse_and_bind_files_edit(raw_body, claims)
            else:
                raise FilesWriteContractError("FILES_WRITE_TOOL", "tool invalid")
        except FilesWriteContractError as exc:
            logger.warning("files.%s contract rejected code=%s", tool, exc.code)
            raise HTTPException(status_code=400, detail="Invalid request") from None

        try:
            return await self.supervisor.run_shielded(
                self._orchestrate(command, tool)
            )
        except SupervisorAdmissionError:
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

    async def _orchestrate(
        self, command: WriteCommand | EditCommand, tool: str
    ) -> JSONResponse:
        identity = command.identity
        try:
            claimed = await run_in_threadpool(
                self.claim_validator.claim, self._claim_input(command, tool)
            )
        except NotFoundError:
            raise HTTPException(status_code=404, detail="Not found") from None
        except (ConflictError, IdempotencyKeyReuseError):
            raise HTTPException(status_code=409, detail="Conflict") from None
        except Exception:
            logger.exception("files.%s claim failed", tool)
            raise HTTPException(
                status_code=503, detail="Service temporarily unavailable"
            ) from None

        created = claimed.get("created") if isinstance(claimed, Mapping) else None
        execution = (
            claimed.get("execution") if isinstance(claimed, Mapping) else None
        )
        workspace_id = (
            claimed.get("workspace_id") if isinstance(claimed, Mapping) else None
        )
        if type(created) is not bool or not isinstance(execution, ExecutionRecord):
            raise HTTPException(status_code=500, detail="Internal error")
        if created is False:
            return _replay(execution, tool=tool, expected_path=command.path)
        try:
            workspace_id = validate_formal_id(
                str(workspace_id or ""), "workspace_id"
            )
        except ValueError:
            raise HTTPException(status_code=500, detail="Internal error") from None

        inflight = {
            "org_id": identity["orgId"],
            "user_id": identity["userId"],
            "execution_id": execution.execution_id,
            "execution_fence_token": identity["executionFenceToken"],
        }
        self._register_inflight(execution.execution_id, inflight)
        terminal_confirmed = False
        try:
            result, status, error_code = await run_in_threadpool(
                self._execute, command, tool, workspace_id
            )
            try:
                await run_in_threadpool(
                    self.claim_validator.finalize,
                    {
                        **inflight,
                        "status": status,
                        "result_json": result,
                        "exit_code": None,
                        "error_code": error_code,
                    },
                )
            except Exception:
                logger.exception("files.%s finalize failed", tool)
                terminal_confirmed = await run_in_threadpool(
                    self._mark_unknown_after_finalize_failure, inflight, tool
                )
                raise HTTPException(
                    status_code=503, detail="Service temporarily unavailable"
                ) from None

            terminal_confirmed = True
            return _response_for_result(
                result,
                tool=tool,
                expected_path=command.path,
                failed=status == SANDBOX_EXECUTION_STATUS_FAILED,
            )
        finally:
            if terminal_confirmed:
                self._clear_inflight(execution.execution_id)

    def _execute(
        self,
        command: WriteCommand | EditCommand,
        tool: str,
        workspace_id: str,
    ) -> tuple[dict[str, Any], str, str | None]:
        try:
            if tool == "write" and isinstance(command, WriteCommand):
                raw = self.writer.write(
                    workspace_id=workspace_id,
                    path=command.path,
                    content=command.content,
                    encoding=command.encoding,
                )
            elif tool == "edit" and isinstance(command, EditCommand):
                raw = self.writer.edit(
                    workspace_id=workspace_id,
                    path=command.path,
                    old_text=command.old_text,
                    new_text=command.new_text,
                    expected_hash=command.expected_hash,
                    expected_version=command.expected_version,
                )
            else:
                raise ValueError("tool/command binding invalid")
            if not isinstance(raw, Mapping):
                raise ValueError("writer result must be a mapping")
            result = _filter_success_result(
                raw, tool=tool, expected_path=command.path
            )
            return result, SANDBOX_EXECUTION_STATUS_SUCCESS, None
        except InternalFileWriteError as exc:
            code = (
                exc.code
                if exc.code in _ERROR_HTTP_STATUS
                else "FILE_OPERATION_FAILED"
            )
            return (
                {
                    "error": {
                        "code": code,
                        "message": str(exc)[:_ERROR_MESSAGE_MAX_LENGTH],
                    },
                    "_httpStatus": _ERROR_HTTP_STATUS[code],
                },
                SANDBOX_EXECUTION_STATUS_FAILED,
                code,
            )
        except Exception:
            logger.exception("files.%s execution failed", tool)
            return (
                {
                    "error": {
                        "code": "FILE_OPERATION_FAILED",
                        "message": "file operation failed",
                    },
                    "_httpStatus": 500,
                },
                SANDBOX_EXECUTION_STATUS_FAILED,
                "FILE_OPERATION_FAILED",
            )

    def _claim_input(
        self, command: WriteCommand | EditCommand, tool: str
    ) -> dict[str, Any]:
        identity = command.identity
        return {
            "org_id": identity["orgId"],
            "user_id": identity["userId"],
            "execution_id": validate_formal_id(
                self.id_factory(), "execution_id"
            ),
            "sandbox_session_id": identity["sandboxSessionId"],
            "run_id": identity["runId"],
            "agent_session_id": identity["agentSessionId"],
            "conversation_id": identity["conversationId"],
            "tool_execution_id": command.tool_execution_id,
            "tool_call_id": command.tool_call_id,
            "tool_name": tool,
            "kind": tool,
            "request_hash": command.request_hash,
            "request_hash_version": command.request_hash_version,
            "execution_fence_token": identity["executionFenceToken"],
            "trace_id": identity["traceId"],
        }

    def _mark_unknown_after_finalize_failure(
        self, inflight: Mapping[str, Any], tool: str
    ) -> bool:
        try:
            self.claim_validator.mark_unknown_for_crash_recovery(
                {
                    **inflight,
                    "error_code": "POST_EXECUTION_FINALIZE_FAILED",
                    "result_json": {
                        "unknown": True,
                        "reason": "POST_EXECUTION_FINALIZE_FAILED",
                    },
                }
            )
            return True
        except Exception:
            logger.exception("files.%s UNKNOWN recovery failed", tool)
            return False

    def _register_inflight(
        self, execution_id: str, value: dict[str, Any]
    ) -> None:
        with self._inflight_lock:
            self._inflight[execution_id] = value

    def _clear_inflight(self, execution_id: str) -> None:
        with self._inflight_lock:
            self._inflight.pop(execution_id, None)

    def inflight_claim_count(self) -> int:
        with self._inflight_lock:
            return len(self._inflight)

    def reconcile_inflight_as_unknown(self) -> int:
        with self._inflight_lock:
            pending = list(self._inflight.values())
        count = 0
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
            except Exception:
                logger.exception("files write shutdown reconcile failed")
                continue
            self._clear_inflight(item["execution_id"])
            count += 1
        return count


def get_files_write_runtime(app: Any) -> FilesWriteRuntime | None:
    return getattr(app.state, FILES_WRITE_RUNTIME_STATE_KEY, None)


def set_files_write_runtime(app: Any, runtime: FilesWriteRuntime | None) -> None:
    setattr(app.state, FILES_WRITE_RUNTIME_STATE_KEY, runtime)


__all__ = [
    "FILES_WRITE_RUNTIME_STATE_KEY",
    "FilesWriteRuntime",
    "get_files_write_runtime",
    "set_files_write_runtime",
]
