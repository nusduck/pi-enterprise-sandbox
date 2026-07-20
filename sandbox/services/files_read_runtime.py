"""One-shot orchestration for POST /internal/v1/files/read.

After strict body parse, the full pipeline claim → (created) read once →
finalize SUCCESS/FAILED runs as one strong-referenced supervisor task
(awaited under shield). Replay (created=false) never re-reads. Client
disconnect never finalizes CANCELLED. Supervisor capacity/closing rejects
with 503 and zero claim/read/finalize. Finalize failures leave the ledger
RUNNING (503 to client).
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from sandbox.app.domain.files_read_contract import (
    FilesReadContractError,
    ReadCommand,
    parse_and_bind_files_read,
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
from sandbox.security.path_validation import validate_formal_id
from sandbox.services.internal_execution_supervisor import (
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.internal_file_reader import (
    InternalFileReadError,
    InternalFileReader,
)

logger = logging.getLogger("sandbox.services.files_read_runtime")

# Client-facing details — no claims, keys, physical paths, or stacks.
_DETAIL_BAD_REQUEST = "Invalid request"
_DETAIL_UNAVAILABLE = "Service temporarily unavailable"
_DETAIL_INTERNAL = "Internal error"
_DETAIL_IN_PROGRESS = "Tool execution in progress"
_DETAIL_TIMEOUT = "Tool execution timed out"
_DETAIL_CANCELLED = "Tool execution cancelled"
_DETAIL_UNKNOWN = "Tool outcome unknown"
_DETAIL_NOT_FOUND = "Not found"
_DETAIL_CONFLICT = "Conflict"

# app.state slot — production injects a real runtime; import-time is None.
FILES_READ_RUNTIME_STATE_KEY = "files_read_runtime"
SKILLS_READ_RUNTIME_STATE_KEY = "skills_read_runtime"

# Success result keys allowed on the wire / in ledger (no physical paths).
_SUCCESS_TEXT_KEYS = frozenset(
    {
        "path",
        "binary",
        "content",
        "truncated",
        "offset",
        "limit",
        "size",
        "returnedLines",
        "nextOffset",
        "mimeType",
    }
)
_SUCCESS_BINARY_KEYS = frozenset({"path", "binary", "size", "mimeType"})

_READER_HTTP_STATUS: dict[str, int] = {
    "FILE_NOT_FOUND": 404,
    "PATH_INVALID": 400,
    "INVALID_ARGUMENT": 400,
    "PERMISSION_DENIED": 403,
    "NOT_REGULAR_FILE": 400,
    "FILE_TOO_LARGE": 413,
    "FILE_LINE_TOO_LARGE": 413,
    "FILE_CHANGED_DURING_READ": 409,
    "READ_FAILED": 500,
}


_ERROR_MESSAGE_MAX_LEN = 512


@dataclass(frozen=True, slots=True)
class _ErrorEnvelope:
    code: str
    message: str
    http_status: int

    def as_result_json(self) -> dict[str, Any]:
        return {
            "error": {"code": self.code, "message": self.message},
            "httpStatus": self.http_status,
        }

    def client_body(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message}}


def _is_nonneg_int(value: Any) -> bool:
    return type(value) is int and not isinstance(value, bool) and value >= 0  # noqa: E721


def _safe_error_message(message: Any) -> str | None:
    """Bounded safe error message; reject host paths / control chars."""
    if type(message) is not str:  # noqa: E721
        return None
    if not message or len(message) > _ERROR_MESSAGE_MAX_LEN:
        return None
    # Reject C0 controls (incl. newline/tab) and DEL.
    for ch in message:
        o = ord(ch)
        if o < 0x20 or o == 0x7F:
            return None
    # Reject absolute / host-ish / physical-root leakage in persisted messages.
    if (
        message.startswith("/")
        or "\\" in message
        or "/Users/" in message
        or "/var/" in message
        or "workspaces/" in message
    ):
        return None
    return message


def filter_success_result(
    raw: Mapping[str, Any],
    command: ReadCommand,
    *,
    enforce_max_bytes: bool = False,
) -> dict[str, Any]:
    """Rebuild SUCCESS result_json rebound to *command* (no arbitrary pass-through)."""
    if not isinstance(raw, Mapping):
        raise ValueError("success result must be a mapping")
    binary = raw.get("binary")
    if binary is True:
        out: dict[str, Any] = {}
        for k in _SUCCESS_BINARY_KEYS:
            if k not in raw:
                raise ValueError(f"missing binary result field {k}")
            out[k] = raw[k]
        if type(out["path"]) is not str or out["path"] != command.path:  # noqa: E721
            raise ValueError("binary path must equal command.path")
        if not _is_nonneg_int(out["size"]):
            raise ValueError("binary size invalid")
        if type(out["mimeType"]) is not str:  # noqa: E721
            raise ValueError("binary mimeType invalid")
        return out
    if binary is False:
        out = {}
        for k in _SUCCESS_TEXT_KEYS:
            if k not in raw:
                raise ValueError(f"missing text result field {k}")
            out[k] = raw[k]
        if type(out["path"]) is not str or out["path"] != command.path:  # noqa: E721
            raise ValueError("text path must equal command.path")
        if type(out["content"]) is not str:  # noqa: E721
            raise ValueError("text content invalid")
        if type(out["truncated"]) is not bool:  # noqa: E721
            raise ValueError("text truncated invalid")
        if type(out["offset"]) is not int or isinstance(out["offset"], bool):  # noqa: E721
            raise ValueError("text offset invalid")
        if out["offset"] != command.offset:
            raise ValueError("text offset must equal command.offset")
        if type(out["limit"]) is not int or isinstance(out["limit"], bool):  # noqa: E721
            raise ValueError("text limit invalid")
        if out["limit"] != command.limit:
            raise ValueError("text limit must equal command.limit")
        if not _is_nonneg_int(out["size"]):
            raise ValueError("text size invalid")
        if type(out["returnedLines"]) is not int or isinstance(  # noqa: E721
            out["returnedLines"], bool
        ):
            raise ValueError("text returnedLines invalid")
        if out["returnedLines"] < 0 or out["returnedLines"] > command.limit:
            raise ValueError("text returnedLines out of range")
        no = out["nextOffset"]
        if no is not None:
            if type(no) is not int or isinstance(no, bool):  # noqa: E721
                raise ValueError("text nextOffset invalid")
            if no < command.offset:
                raise ValueError("text nextOffset must be >= offset")
        if type(out["mimeType"]) is not str:  # noqa: E721
            raise ValueError("text mimeType invalid")
        if enforce_max_bytes:
            try:
                content_bytes = len(out["content"].encode("utf-8"))
            except UnicodeEncodeError as exc:
                raise ValueError("text content is not UTF-8 encodable") from exc
            if content_bytes > command.max_bytes:
                raise ValueError("text content exceeds command.max_bytes")
        return out
    raise ValueError("result binary flag must be strict bool")


def parse_failed_envelope(result_json: Any) -> _ErrorEnvelope | None:
    """Strict FAILED result envelope; None if corrupted / unknown code."""
    if not isinstance(result_json, Mapping):
        return None
    err = result_json.get("error")
    http_status = result_json.get("httpStatus")
    if not isinstance(err, Mapping):
        return None
    if frozenset(err) != frozenset({"code", "message"}):
        return None
    if frozenset(result_json) != frozenset({"error", "httpStatus"}):
        return None
    code = err.get("code")
    message = err.get("message")
    if type(code) is not str or not code:  # noqa: E721
        return None
    # Only known reader codes with exact fixed HTTP status mapping.
    if code not in _READER_HTTP_STATUS:
        return None
    if type(http_status) is not int or isinstance(http_status, bool):  # noqa: E721
        return None
    if http_status != _READER_HTTP_STATUS[code]:
        return None
    safe_msg = _safe_error_message(message)
    if safe_msg is None:
        return None
    return _ErrorEnvelope(code=code, message=safe_msg, http_status=http_status)


def _envelope_for_reader_error(exc: InternalFileReadError) -> _ErrorEnvelope:
    raw_code = str(exc.code or "READ_FAILED")
    # Unknown codes normalize to READ_FAILED / 500 — never write arbitrary codes.
    if raw_code not in _READER_HTTP_STATUS:
        return _envelope_for_unexpected()
    code = raw_code
    status = _READER_HTTP_STATUS[code]
    raw_message = str(exc) or "read failed"
    safe_msg = _safe_error_message(raw_message)
    if safe_msg is None:
        safe_msg = "read failed"
    return _ErrorEnvelope(code=code, message=safe_msg, http_status=status)


def _envelope_for_unexpected() -> _ErrorEnvelope:
    return _ErrorEnvelope(
        code="READ_FAILED",
        message="read failed",
        http_status=_READER_HTTP_STATUS["READ_FAILED"],
    )


class FilesReadRuntime:
    """Injectable claim/read/finalize runtime for files.read.

    Construct with fakes for offline tests. Production wiring injects MySQL
    claim validator + real reader; ``main`` only sets the app.state slot to
    None at import time.
    """

    def __init__(
        self,
        *,
        claim_validator: Any,
        reader: InternalFileReader | Any,
        id_factory: Callable[[], str],
        supervisor: InternalExecutionSupervisor | None = None,
        parse_command: Callable[[bytes, Mapping[str, Any]], ReadCommand] = parse_and_bind_files_read,
    ) -> None:
        self.claim_validator = claim_validator
        self.reader = reader
        self.id_factory = id_factory
        self.supervisor = supervisor or InternalExecutionSupervisor()
        self.parse_command = parse_command
        # Test counters (also useful for orchestration assertions).
        self.read_calls = 0
        self.finalize_calls = 0
        self.claim_calls = 0
        # Process-local inflight claims (created=True, not yet terminal finalize).
        # Used on drain-timeout shutdown to mark UNKNOWN instead of leaving RUNNING.
        self._inflight_lock = threading.Lock()
        self._inflight: dict[str, dict[str, Any]] = {}

    async def handle(
        self,
        *,
        claims: Mapping[str, Any],
        raw_body: bytes,
    ) -> JSONResponse:
        """Full orchestration. Auth/replay already applied by the dependency.

        Strict body parse stays on the request task. On success, the entire
        ``claim → (created) read → finalize`` pipeline is admitted as one
        strong-referenced supervisor task and awaited under shield so client
        disconnect cannot drop a created claim without finalize.
        """
        try:
            command = self.parse_command(raw_body, claims)
        except FilesReadContractError as exc:
            logger.warning(
                "files.read contract rejected code=%s",
                exc.code,
            )
            raise HTTPException(
                status_code=400, detail=_DETAIL_BAD_REQUEST
            ) from None

        try:
            return await self.supervisor.run_shielded(
                self._orchestrate(command)
            )
        except SupervisorAdmissionError:
            # Capacity or closing — fail closed with zero side effects.
            logger.warning("files.read supervisor admission rejected")
            raise HTTPException(
                status_code=503, detail=_DETAIL_UNAVAILABLE
            ) from None

    async def _orchestrate(self, command: ReadCommand) -> JSONResponse:
        """Claim once; created=true reads+finalizes once; created=false replays only."""
        try:
            claim_input = self._claim_input(command)
            claim_out = await run_in_threadpool(
                self._claim_sync, claim_input
            )
        except NotFoundError:
            raise HTTPException(status_code=404, detail=_DETAIL_NOT_FOUND) from None
        except IdempotencyKeyReuseError:
            raise HTTPException(status_code=409, detail=_DETAIL_CONFLICT) from None
        except ConflictError:
            raise HTTPException(status_code=409, detail=_DETAIL_CONFLICT) from None
        except HTTPException:
            raise
        except Exception:
            logger.exception("files.read claim failed")
            raise HTTPException(
                status_code=503, detail=_DETAIL_UNAVAILABLE
            ) from None

        created = claim_out.get("created") if isinstance(claim_out, Mapping) else None
        # Strict bool only — never bool("false") / truthy coercion.
        if type(created) is not bool:  # noqa: E721
            logger.error("files.read claim created is not a strict bool")
            raise HTTPException(status_code=500, detail=_DETAIL_INTERNAL)

        execution = claim_out.get("execution") if isinstance(claim_out, Mapping) else None
        if not isinstance(execution, ExecutionRecord):
            logger.error("files.read claim returned non-ExecutionRecord")
            raise HTTPException(status_code=500, detail=_DETAIL_INTERNAL)

        try:
            workspace_id = validate_formal_id(
                str(claim_out.get("workspace_id") or ""), "workspace_id"
            )
        except ValueError:
            logger.error("files.read claim workspace_id not formal ULID")
            raise HTTPException(status_code=500, detail=_DETAIL_INTERNAL) from None

        if created is False:
            # Replay only — never read or finalize.
            return self._replay_existing(execution, command)

        # created is True: track until terminal finalize for shutdown recovery.
        self._register_inflight(command, execution)
        response = await self._run_created(command, execution, workspace_id)
        # Only a confirmed terminal finalize may leave the recovery set.
        self._clear_inflight(execution.execution_id)
        return response

    def _register_inflight(
        self, command: ReadCommand, execution: ExecutionRecord
    ) -> None:
        with self._inflight_lock:
            self._inflight[str(execution.execution_id)] = {
                "org_id": command.org_id,
                "user_id": command.user_id,
                "execution_id": str(execution.execution_id),
                "execution_fence_token": command.execution_fence_token,
            }

    def _clear_inflight(self, execution_id: str) -> None:
        with self._inflight_lock:
            self._inflight.pop(str(execution_id), None)

    def inflight_claim_count(self) -> int:
        with self._inflight_lock:
            return len(self._inflight)

    def reconcile_inflight_as_unknown(self) -> int:
        """Best-effort RUNNING → UNKNOWN for claims still open at drain timeout.

        Sync; call via to_thread. Never raises on per-row failures (logs type only).
        Returns number of successful reconciliations.
        """
        with self._inflight_lock:
            pending = list(self._inflight.values())
        ok = 0
        for item in pending:
            try:
                self.claim_validator.mark_unknown_for_crash_recovery(
                    {
                        "org_id": item["org_id"],
                        "user_id": item["user_id"],
                        "execution_id": item["execution_id"],
                        "execution_fence_token": item["execution_fence_token"],
                        "error_code": "SHUTDOWN_DRAIN_TIMEOUT",
                        "result_json": {
                            "unknown": True,
                            "reason": "SHUTDOWN_DRAIN_TIMEOUT",
                        },
                    }
                )
                ok += 1
                self._clear_inflight(str(item["execution_id"]))
            except Exception as exc:
                logger.warning(
                    "files.read shutdown reconcile failed type=%s",
                    type(exc).__name__,
                )
        return ok

    def _claim_sync(self, claim_input: dict[str, Any]) -> dict[str, Any]:
        self.claim_calls += 1
        return self.claim_validator.claim(claim_input)

    def _finalize_sync(self, finalize_input: dict[str, Any]) -> dict[str, Any]:
        self.finalize_calls += 1
        return self.claim_validator.finalize(finalize_input)

    def _read_sync(
        self, *, workspace_id: str, command: ReadCommand
    ) -> dict[str, Any]:
        self.read_calls += 1
        return self.reader.read(
            workspace_id=workspace_id,
            path=command.path,
            offset=command.offset,
            limit=command.limit,
            max_bytes=command.max_bytes,
        )

    def _claim_input(self, command: ReadCommand) -> dict[str, Any]:
        raw_id = self.id_factory()
        try:
            # Formal ULID only; use canonical uppercase. Invalid → fail before claim.
            execution_id = validate_formal_id(raw_id, "execution_id")
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "id_factory must return a formal ULID"
            ) from exc
        return {
            "org_id": command.org_id,
            "user_id": command.user_id,
            "execution_id": execution_id,
            "sandbox_session_id": command.sandbox_session_id,
            "run_id": command.run_id,
            "agent_session_id": command.agent_session_id,
            "conversation_id": command.conversation_id,
            "tool_execution_id": command.tool_execution_id,
            "tool_call_id": command.tool_call_id,
            "tool_name": "read",
            "kind": "read",
            "request_hash": command.request_hash,
            "request_hash_version": 1,
            "execution_fence_token": command.execution_fence_token,
            "trace_id": command.trace_id,
        }

    def _replay_existing(
        self, execution: ExecutionRecord, command: ReadCommand
    ) -> JSONResponse:
        status = execution.status
        if status == SANDBOX_EXECUTION_STATUS_SUCCESS:
            try:
                filtered = filter_success_result(
                    execution.result_json or {},
                    command,
                    enforce_max_bytes=False,
                )
            except (TypeError, ValueError):
                logger.error("files.read SUCCESS result_json corrupt; fail closed")
                raise HTTPException(
                    status_code=500, detail=_DETAIL_INTERNAL
                ) from None
            return JSONResponse(status_code=200, content=filtered)

        if status == SANDBOX_EXECUTION_STATUS_RUNNING:
            raise HTTPException(
                status_code=409,
                detail={"code": "IN_PROGRESS", "message": _DETAIL_IN_PROGRESS},
            )

        if status == SANDBOX_EXECUTION_STATUS_FAILED:
            env = parse_failed_envelope(execution.result_json)
            if env is None:
                logger.error("files.read FAILED result_json corrupt; fail closed")
                raise HTTPException(
                    status_code=500, detail=_DETAIL_INTERNAL
                ) from None
            return JSONResponse(
                status_code=env.http_status, content=env.client_body()
            )

        if status == SANDBOX_EXECUTION_STATUS_TIMEOUT:
            raise HTTPException(status_code=504, detail=_DETAIL_TIMEOUT)

        if status == SANDBOX_EXECUTION_STATUS_CANCELLED:
            raise HTTPException(
                status_code=409,
                detail={"code": "CANCELLED", "message": _DETAIL_CANCELLED},
            )

        if status == SANDBOX_EXECUTION_STATUS_UNKNOWN:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "TOOL_OUTCOME_UNKNOWN",
                    "message": _DETAIL_UNKNOWN,
                },
            )

        logger.error("files.read unknown execution status=%r", status)
        raise HTTPException(status_code=500, detail=_DETAIL_INTERNAL)

    async def _run_created(
        self,
        command: ReadCommand,
        execution: ExecutionRecord,
        workspace_id: str,
    ) -> JSONResponse:
        envelope: _ErrorEnvelope | None = None
        filtered: dict[str, Any] | None = None
        try:
            raw_result = await run_in_threadpool(
                self._read_sync, workspace_id=workspace_id, command=command
            )
            try:
                filtered = filter_success_result(
                    raw_result,
                    command,
                    enforce_max_bytes=True,
                )
            except (TypeError, ValueError):
                # Inconsistent with command — never finalize SUCCESS.
                logger.error("files.read reader returned non-filterable result")
                envelope = _envelope_for_unexpected()
        except InternalFileReadError as exc:
            envelope = _envelope_for_reader_error(exc)
        except Exception:
            logger.exception("files.read reader unexpected failure")
            envelope = _envelope_for_unexpected()

        if filtered is not None:
            try:
                await run_in_threadpool(
                    self._finalize_sync,
                    {
                        "org_id": command.org_id,
                        "user_id": command.user_id,
                        "execution_id": execution.execution_id,
                        "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                        "execution_fence_token": command.execution_fence_token,
                        "result_json": filtered,
                        "exit_code": None,
                        "error_code": None,
                    },
                )
            except Exception:
                logger.exception(
                    "files.read finalize SUCCESS failed; ledger stays RUNNING"
                )
                raise HTTPException(
                    status_code=503, detail=_DETAIL_UNAVAILABLE
                ) from None
            return JSONResponse(status_code=200, content=filtered)

        assert envelope is not None
        try:
            await run_in_threadpool(
                self._finalize_sync,
                {
                    "org_id": command.org_id,
                    "user_id": command.user_id,
                    "execution_id": execution.execution_id,
                    "status": SANDBOX_EXECUTION_STATUS_FAILED,
                    "execution_fence_token": command.execution_fence_token,
                    "result_json": envelope.as_result_json(),
                    "exit_code": None,
                    "error_code": envelope.code,
                },
            )
        except Exception:
            logger.exception(
                "files.read finalize FAILED failed; ledger stays RUNNING"
            )
            raise HTTPException(
                status_code=503, detail=_DETAIL_UNAVAILABLE
            ) from None
        return JSONResponse(
            status_code=envelope.http_status, content=envelope.client_body()
        )


def get_files_read_runtime(app: Any) -> FilesReadRuntime | None:
    return getattr(app.state, FILES_READ_RUNTIME_STATE_KEY, None)


def set_files_read_runtime(app: Any, runtime: FilesReadRuntime | None) -> None:
    setattr(app.state, FILES_READ_RUNTIME_STATE_KEY, runtime)


def get_skills_read_runtime(app: Any) -> FilesReadRuntime | None:
    return getattr(app.state, SKILLS_READ_RUNTIME_STATE_KEY, None)


def set_skills_read_runtime(app: Any, runtime: FilesReadRuntime | None) -> None:
    setattr(app.state, SKILLS_READ_RUNTIME_STATE_KEY, runtime)


__all__ = [
    "FILES_READ_RUNTIME_STATE_KEY",
    "SKILLS_READ_RUNTIME_STATE_KEY",
    "FilesReadRuntime",
    "filter_success_result",
    "get_files_read_runtime",
    "get_skills_read_runtime",
    "parse_failed_envelope",
    "set_files_read_runtime",
    "set_skills_read_runtime",
]
