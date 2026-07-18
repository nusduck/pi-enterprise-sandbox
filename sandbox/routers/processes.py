"""Process Control API — managed long-running processes (ADR §10)."""

from __future__ import annotations

import json
import queue
import threading
from typing import Iterator

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from sandbox.models import (
    ExecutionEventResponse,
    ProcessLogsResponse,
    ProcessReadRequest,
    ProcessReadResponse,
    ProcessResponse,
    ProcessSignalRequest,
    ProcessStartRequest,
    ProcessStartResponse,
    ProcessStdinRequest,
    ProcessWaitRequest,
)
from sandbox.security.ownership import require_owned_session
from sandbox.services.policy_checker import policy_checker
from sandbox.services.process_manager import process_manager
from sandbox.services.execution_context import SandboxExecutionContext

router = APIRouter(prefix="/processes", tags=["processes"])


def _require_session(session_id: str, request: Request | None = None):
    session = require_owned_session(session_id, request)
    if session.status != "RUNNING":
        raise HTTPException(status_code=400, detail="Session is not active")
    return session


def _require_process_owned(process_id: str, request: Request | None = None) -> dict:
    """Load process and enforce ownership of its parent session."""
    entry = process_manager.get(process_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Process not found")
    require_owned_session(entry.get("session_id") or "", request)
    return entry


def _to_response(entry: dict) -> ProcessResponse:
    return ProcessResponse(
        process_id=entry["process_id"],
        session_id=entry["session_id"],
        run_id=entry.get("run_id"),
        command=entry.get("command", ""),
        status=entry.get("status", "created"),
        pid=entry.get("pid"),
        exit_code=entry.get("exit_code"),
        background=bool(entry.get("background")),
        cwd=entry.get("cwd"),
        error=entry.get("error"),
        started_at=entry.get("started_at"),
        finished_at=entry.get("finished_at"),
        created_at=entry.get("created_at") or "",
        updated_at=entry.get("updated_at") or "",
        trace_id=entry.get("trace_id"),
    )


@router.post("", response_model=ProcessStartResponse, status_code=201)
def start_process(body: ProcessStartRequest, request: Request):
    session = _require_session(body.session_id, request)

    if body.command and policy_checker.is_blocked_command(body.command):
        token = body.command.strip().split()[0] if body.command.strip() else "command"
        raise HTTPException(status_code=403, detail=f"blocked command: {token}")

    context = SandboxExecutionContext.from_session(session)
    # Tenant binding from trusted session / actor — never from free-form body.
    org_id = None
    conversation_id = None
    meta = getattr(session, "metadata", None) or {}
    if isinstance(meta, dict):
        conversation_id = meta.get("conversation_id")
    actor_org = getattr(request.state, "organization_id", None)
    if actor_org:
        org_id = str(actor_org)
    result = process_manager.start(
        session_id=body.session_id,
        command=body.command,
        context=context,
        cwd=body.cwd,
        env=body.env or None,
        timeout=body.timeout,
        background=body.background,
        run_id=body.run_id,
        org_id=org_id,
        conversation_id=str(conversation_id) if conversation_id else None,
        sandbox_session_id=body.session_id,
    )

    if result.get("status") == "blocked":
        raise HTTPException(status_code=403, detail=result.get("error", "blocked"))
    if result.get("status") == "invalid":
        raise HTTPException(status_code=400, detail=result.get("error", "invalid"))
    if result.get("status") == "conflict":
        raise HTTPException(status_code=409, detail=result.get("error", "conflict"))
    if result.get("error") and result.get("status") == "failed" and not result.get("process_id"):
        raise HTTPException(status_code=500, detail=result["error"])

    return ProcessStartResponse(
        process_id=result["process_id"],
        status=result.get("status", "running"),
        started_at=result.get("started_at") or "",
        stdout_cursor=result.get("stdout_cursor") or "0-0",
        stderr_cursor=result.get("stderr_cursor") or "0-0",
    )


@router.get("/{process_id}", response_model=ProcessResponse)
def get_process(process_id: str, request: Request):
    entry = _require_process_owned(process_id, request)
    return _to_response(entry)


@router.get("/{process_id}/logs", response_model=ProcessLogsResponse)
def get_process_logs(
    process_id: str,
    request: Request,
    offset: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=500_000),
):
    _require_process_owned(process_id, request)
    result = process_manager.logs(process_id, offset=offset, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Process not found")
    return ProcessLogsResponse(**result)


@router.get("/{process_id}/read", response_model=ProcessReadResponse)
def read_process_stream(
    process_id: str,
    request: Request,
    stream: str = Query("stdout"),
    cursor: str = Query("0-0"),
    limit: int = Query(8192, ge=1, le=65536),
):
    """Incremental process_read by independent stream cursor (PR-08)."""
    _require_process_owned(process_id, request)
    result = process_manager.read_stream(
        process_id, stream=stream, cursor=cursor, limit=limit
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Process not found")
    if result.get("status") == "invalid":
        raise HTTPException(status_code=400, detail=result.get("error") or "invalid")
    return ProcessReadResponse(
        process_id=process_id,
        stream=result.get("stream") or stream,
        cursor=result.get("cursor") or cursor,
        next_cursor=result.get("next_cursor") or cursor,
        data=result.get("data") or "",
        truncated=bool(result.get("truncated")),
        completed=bool(result.get("completed")),
        status=result.get("status"),
    )


@router.post("/{process_id}/read", response_model=ProcessReadResponse)
def read_process_stream_post(
    process_id: str,
    request: Request,
    body: ProcessReadRequest,
):
    """POST variant of process_read (tool transport)."""
    _require_process_owned(process_id, request)
    result = process_manager.read_stream(
        process_id,
        stream=body.stream,
        cursor=body.cursor,
        limit=body.limit,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="Process not found")
    if result.get("status") == "invalid":
        raise HTTPException(status_code=400, detail=result.get("error") or "invalid")
    return ProcessReadResponse(
        process_id=process_id,
        stream=result.get("stream") or body.stream,
        cursor=result.get("cursor") or body.cursor,
        next_cursor=result.get("next_cursor") or body.cursor,
        data=result.get("data") or "",
        truncated=bool(result.get("truncated")),
        completed=bool(result.get("completed")),
        status=result.get("status"),
    )


@router.get(
    "/{process_id}/events",
    response_model=list[ExecutionEventResponse],
)
def list_process_events(
    process_id: str,
    request: Request,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    """Pull process execution events after a sequence (reconnect helper)."""
    _require_process_owned(process_id, request)
    events = process_manager.list_events(
        process_id, after_sequence=after_sequence, limit=limit
    )
    if events is None:
        raise HTTPException(status_code=404, detail="Process not found")
    return [ExecutionEventResponse(**e) for e in events]


@router.get("/{process_id}/events/stream")
def stream_process_events(
    process_id: str,
    request: Request,
    after_sequence: int = Query(0, ge=0),
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
):
    """SSE stream of process execution events with sequence resume (B3).

    Resume via ``?after_sequence=N`` or ``Last-Event-ID`` (SSE id = sequence).
    """
    _require_process_owned(process_id, request)

    after = after_sequence
    if last_event_id is not None:
        try:
            after = max(after, int(str(last_event_id).strip()))
        except (TypeError, ValueError):
            pass

    q: queue.Queue[dict | None] = queue.Queue()
    closed = threading.Event()

    def _on_event(entry: dict) -> None:
        if closed.is_set():
            return
        q.put(entry)

    unsub = process_manager.subscribe_events(process_id, after, _on_event)
    if unsub is None:
        raise HTTPException(status_code=404, detail="Process not found")

    def _generate() -> Iterator[str]:
        try:
            while not closed.is_set():
                if hasattr(request, "is_disconnected"):
                    # Starlette Request.is_disconnected is async; skip in sync gen
                    pass
                try:
                    entry = q.get(timeout=15.0)
                except queue.Empty:
                    # Keep-alive comment so proxies don't drop the stream
                    yield ": keepalive\n\n"
                    continue
                if entry is None:
                    break
                if entry.get("type") == "__stream_terminal__":
                    term = entry.get("terminal") or {}
                    yield (
                        f"event: end\ndata: {json.dumps({'status': (term.get('payload') or {}).get('status') or 'done', 'sequence': term.get('sequence')})}\n\n"
                    )
                    break
                seq = entry.get("sequence", 0)
                payload = {
                    "sequence": seq,
                    "event_id": entry.get("event_id"),
                    "type": entry.get("type"),
                    "payload": entry.get("payload") or {},
                    "source_type": entry.get("source_type"),
                    "source_id": entry.get("source_id"),
                    "created_at": entry.get("created_at"),
                }
                yield f"id: {seq}\nevent: {entry.get('type')}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
        finally:
            closed.set()
            try:
                unsub()
            except Exception:
                pass

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/{process_id}/stdin")
def write_process_stdin(process_id: str, request: Request, body: ProcessStdinRequest):
    _require_process_owned(process_id, request)
    result = process_manager.write_stdin(process_id, body.data, eof=body.eof)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Process not found")
    if result.get("status") in ("terminal", "unavailable", "failed"):
        raise HTTPException(
            status_code=400,
            detail=result.get("error") or result.get("status"),
        )
    return result


@router.post("/{process_id}/signal")
def signal_process(process_id: str, request: Request, body: ProcessSignalRequest):
    _require_process_owned(process_id, request)
    result = process_manager.signal_process(process_id, body.signal)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Process not found")
    if result.get("status") == "invalid":
        raise HTTPException(status_code=400, detail=result.get("error", "invalid signal"))
    # Identity mismatch / not delivered: conflict, not a silent success.
    if result.get("ok") is False or result.get("status") in (
        "unavailable",
        "failed",
    ):
        raise HTTPException(
            status_code=409,
            detail="Process signal not delivered",
        )
    if result.get("status") == "terminal":
        # Already terminal — treated as ok+idempotent by manager; keep 200 body.
        pass
    return result


@router.post("/{process_id}/cancel", response_model=ProcessResponse)
def cancel_process(process_id: str, request: Request):
    """Cancel a managed process.

    - 200: cancel delivered (or already terminal — idempotent).
    - 404: unknown / not owned (fail closed, no leak).
    - 409: cancel not delivered (identity unverifiable / process still live).
    """
    _require_process_owned(process_id, request)
    delivered = process_manager.cancel(process_id)
    if not delivered:
        current = process_manager.get(process_id)
        if current is None:
            raise HTTPException(status_code=404, detail="Process not found")
        # Terminal race: treat as idempotent success.
        status = str(current.get("status") or "").lower()
        if status in {
            "completed",
            "failed",
            "cancelled",
            "timeout",
            "orphaned",
            "lost",
        }:
            require_owned_session(current.get("session_id") or "", request)
            return _to_response(current)
        # Still active / cancel_requested without delivery — do not fake 200.
        raise HTTPException(
            status_code=409,
            detail="Process cancel not delivered",
        )
    # Brief wait for reaper to settle terminal status after delivered cancel.
    updated = process_manager.wait(process_id, timeout=2.0) or process_manager.get(
        process_id
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Process not found")
    # Re-check ownership after cancel (session must still be visible to actor).
    require_owned_session(updated.get("session_id") or "", request)
    return _to_response(updated)


@router.post("/{process_id}/wait", response_model=ProcessResponse)
def wait_process(process_id: str, request: Request, body: ProcessWaitRequest | None = None):
    _require_process_owned(process_id, request)
    timeout = body.timeout if body is not None else None
    entry = process_manager.wait(process_id, timeout=timeout)
    if entry is None:
        raise HTTPException(status_code=404, detail="Process not found")
    return _to_response(entry)


@router.post("/session/{session_id}/cancel")
def cancel_session_processes(
    session_id: str,
    request: Request,
    foreground_only: bool = Query(False),
):
    """Cancel processes for a session (run-cancel cascade / session end).

    ``cancelled`` lists only process ids for which cancel was **delivered**
    (or already terminal). ``failed`` lists active ids that could not be
    terminated (identity/handle failure). Never invents terminal success.
    """
    require_owned_session(session_id, request)
    result = process_manager.cancel_for_session(
        session_id, foreground_only=foreground_only, return_details=True
    )
    return {
        "cancelled": result["cancelled"],
        "count": len(result["cancelled"]),
        "failed": result["failed"],
        "failed_count": len(result["failed"]),
    }
