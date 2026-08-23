"""Session-scoped managed-process control for the operator surface.

The model drives processes through the internal HMAC plane
(``/internal/v1/processes/*``), where every call is a claimed ToolExecution
bound to a Run. A person watching that process in the browser has none of that:
no tool_execution_id, no request hash, no execution fence. They have a session
they own and a process id, which is exactly what these routes take — the same
JWT / service+acting-header auth as the other public session routes, ownership
enforced by :func:`require_owned_session` plus the process's own owner check.

Cross-tenant access is a 404 throughout, never a 403: whether a process id
exists in another tenant is not something a caller may learn.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from sandbox.security.ownership import require_owned_session
from sandbox.services.process_manager import process_manager

router = APIRouter(prefix="/sessions/{session_id}/processes", tags=["processes"])

_NOT_FOUND = "Process not found"
# Signals an operator may deliver. Anything else is a client error, not a
# silently-substituted SIGTERM.
_ALLOWED_SIGNALS = frozenset({"SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"})
_MAX_STDIN_BYTES = 64 * 1024


class SignalBody(BaseModel):
    signal: str = Field(default="SIGTERM", max_length=16)


class StdinBody(BaseModel):
    data: str = Field(default="", max_length=_MAX_STDIN_BYTES)
    eof: bool = False


def _owner(session_id: str, request: Request) -> dict[str, str]:
    """Owner scope for a session the caller provably owns (404 otherwise)."""
    session = require_owned_session(session_id, request)
    metadata = getattr(session, "metadata", None) or {}
    org_id = metadata.get("organization_id")
    if not org_id:
        # A session without an organization stamp cannot be ownership-checked
        # against the process ledger; refuse rather than widen the scope.
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return {
        "org_id": str(org_id),
        "user_id": str(session.user_id),
        "sandbox_session_id": str(session.session_id),
    }


def _control_result(result: dict[str, Any]) -> dict[str, Any]:
    """Map a ProcessManager control result onto an HTTP outcome."""
    status = str(result.get("status") or "")
    if status == "not_found":
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if status == "unavailable":
        # The row survived a restart but the live handle did not, so the
        # process can be observed and never controlled again.
        raise HTTPException(
            status_code=409,
            detail="Process control unavailable after restart",
        )
    return result


@router.get("/{process_id}")
def get_process(session_id: str, process_id: str, request: Request) -> dict[str, Any]:
    owner = _owner(session_id, request)
    entry = process_manager.get_owned(process_id, **owner)
    if entry is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return entry


@router.get("/{process_id}/logs")
def get_process_logs(
    session_id: str,
    process_id: str,
    request: Request,
    offset: int = 0,
    limit: int | None = None,
) -> dict[str, Any]:
    if offset < 0:
        raise HTTPException(status_code=400, detail="offset must be >= 0")
    if limit is not None and limit <= 0:
        raise HTTPException(status_code=400, detail="limit must be > 0")
    owner = _owner(session_id, request)
    logs = process_manager.logs_owned(
        process_id, offset=offset, limit=limit, **owner
    )
    if logs is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return {"process_id": process_id, **logs}


@router.get("/{process_id}/read")
def read_process_stream(
    session_id: str,
    process_id: str,
    request: Request,
    stream: str = "stdout",
    cursor: str = "0-0",
    limit: int = 8192,
) -> dict[str, Any]:
    if stream not in ("stdout", "stderr"):
        raise HTTPException(status_code=400, detail="stream must be stdout or stderr")
    if not 1 <= limit <= 65_536:
        raise HTTPException(status_code=400, detail="limit must be 1..65536")
    if not cursor or len(cursor) > 128:
        raise HTTPException(status_code=400, detail="cursor must be 1..128 chars")
    owner = _owner(session_id, request)
    result = process_manager.read_stream_owned(
        process_id, stream=stream, cursor=cursor, limit=limit, **owner
    )
    if result is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return result


@router.post("/{process_id}/signal")
def signal_process(
    session_id: str, process_id: str, body: SignalBody, request: Request
) -> dict[str, Any]:
    sig = (body.signal or "SIGTERM").strip().upper()
    if sig not in _ALLOWED_SIGNALS:
        raise HTTPException(
            status_code=400,
            detail=f"signal must be one of {', '.join(sorted(_ALLOWED_SIGNALS))}",
        )
    owner = _owner(session_id, request)
    return _control_result(process_manager.signal_process_owned(process_id, sig, **owner))


@router.post("/{process_id}/stdin")
def write_process_stdin(
    session_id: str, process_id: str, body: StdinBody, request: Request
) -> dict[str, Any]:
    if len(body.data.encode("utf-8")) > _MAX_STDIN_BYTES:
        raise HTTPException(status_code=413, detail="stdin data too large")
    owner = _owner(session_id, request)
    return _control_result(
        process_manager.write_stdin_owned(
            process_id, body.data, eof=body.eof, **owner
        )
    )


@router.post("/{process_id}/cancel")
def cancel_process(
    session_id: str, process_id: str, request: Request
) -> dict[str, Any]:
    owner = _owner(session_id, request)
    return _control_result(process_manager.cancel_owned(process_id, **owner))


__all__ = ["router"]
