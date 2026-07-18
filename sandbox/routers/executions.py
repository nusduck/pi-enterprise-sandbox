"""Execution API router — run python, commands, query/cancel."""

from __future__ import annotations

import hashlib
import json
import queue
import threading
from typing import Iterator

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse

from sandbox.models import (
    ApprovalCheckRequest,
    ApprovalResponse,
    CommandExecutionRequest,
    ExecutionEventResponse,
    ExecutionLogsResponse,
    ExecutionResponse,
    ExecutionStatus,
    NodeExecutionRequest,
    PythonExecutionRequest,
    ToolCallCheck,
)
from sandbox.security.ownership import require_owned_session
from sandbox.services.audit_logger import audit_logger
from sandbox.services.approval_manager import approval_manager
from sandbox.services.execution_manager import execution_manager
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.policy_checker import policy_checker

router = APIRouter(prefix="/sessions/{session_id}/executions", tags=["executions"])


def _approval_operation_fingerprint(session_id: str, body: ApprovalCheckRequest) -> str:
    """Hash the server-visible operation, excluding the client key itself."""
    canonical = json.dumps(
        {
            "session_id": session_id,
            "tool_name": body.tool_name,
            "command": body.command,
            "path": body.path,
            "timeout": body.timeout,
            "file_size": body.file_size,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _require_active_session(session_id: str, request: Request | None = None):
    session = require_owned_session(session_id, request)
    if session.status != "RUNNING":
        raise HTTPException(status_code=400, detail="Session is not active")
    return session


def _execution_context(session) -> SandboxExecutionContext:
    """Resolve physical roots only from the trusted session binding."""
    return SandboxExecutionContext.from_session(session)


@router.post("/python", response_model=ExecutionResponse, status_code=201)
def run_python(session_id: str, request: Request, body: PythonExecutionRequest):
    session = _require_active_session(session_id, request)
    context = _execution_context(session)
    result = execution_manager.run_python(
        session_id=session_id,
        code=body.code,
        context=context,
        timeout=body.timeout,
        env_overrides=body.env_overrides if body.env_overrides else None,
        args=list(body.args or []),
    )

    if result.get("status") == "conflict":
        raise HTTPException(status_code=409, detail=result["error"])
    if result.get("status") == "invalid":
        raise HTTPException(status_code=400, detail=result.get("error") or "invalid")

    audit_logger.log_execution(
        session_id=session_id,
        execution_id=result["execution_id"],
        run_type="python",
        exit_code=result.get("exit_code"),
        duration_ms=result.get("duration_ms", 0.0),
        truncated=result.get("truncated", False),
    )

    return ExecutionResponse(
        execution_id=result["execution_id"],
        session_id=result.get("session_id") or session_id,
        status=result.get("status", "failed"),
        stdout_preview=result.get("stdout_preview", ""),
        stderr_preview=result.get("stderr_preview", ""),
        exit_code=result.get("exit_code"),
        duration_ms=result.get("duration_ms", 0.0),
        truncated=result.get("truncated", False),
        trace_id=result.get("trace_id"),
        materialized_path=result.get("materialized_path"),
        python_version=result.get("python_version"),
        python_mode=result.get("python_mode"),
    )


@router.post("/command", response_model=ExecutionResponse, status_code=201)
def run_command(session_id: str, request: Request, body: CommandExecutionRequest):
    # Session is mandatory — service token alone cannot run without a live session.
    session = _require_active_session(session_id, request)

    # Independent hard-deny re-check (do not trust Agent/Extension conclusions).
    # Approval credentials and the approval mode never override hard_deny.
    if body.command and policy_checker.is_blocked_command(body.command):
        token = body.command.strip().split()[0] if body.command.strip() else "command"
        reason = f"blocked command: {token}"
        audit_logger.log_tool_call(
            session_id=session_id,
            tool_name="bash",
            caller_id=session.caller_id,
            allowed=False,
            risk_level="high",
            reason=reason,
            metadata={
                "hard_deny": True,
                "policy_version": policy_checker.policy_version,
                "path": "executions.command",
            },
        )
        raise HTTPException(status_code=403, detail=reason)

    context = _execution_context(session)
    result = execution_manager.run_command(
        session_id=session_id,
        command=body.command,
        context=context,
        timeout=body.timeout,
        env_overrides=body.env_overrides if body.env_overrides else None,
    )

    if result.get("status") == "conflict":
        raise HTTPException(status_code=409, detail=result["error"])
    if result.get("status") == "blocked":
        raise HTTPException(
            status_code=403,
            detail=result.get("error") or result.get("stderr_preview") or "blocked",
        )

    audit_logger.log_execution(
        session_id=session_id,
        execution_id=result["execution_id"],
        run_type="command",
        exit_code=result.get("exit_code"),
        duration_ms=result.get("duration_ms", 0.0),
        truncated=result.get("truncated", False),
    )

    return ExecutionResponse(**result)


@router.post("/node", response_model=ExecutionResponse, status_code=201)
def run_node(session_id: str, request: Request, body: NodeExecutionRequest):
    session = _require_active_session(session_id, request)
    context = _execution_context(session)
    result = execution_manager.run_node(
        session_id=session_id,
        code=body.code,
        context=context,
        timeout=body.timeout,
        env_overrides=body.env_overrides if body.env_overrides else None,
    )

    if result.get("status") == "conflict":
        raise HTTPException(status_code=409, detail=result["error"])

    audit_logger.log_execution(
        session_id=session_id,
        execution_id=result["execution_id"],
        run_type="node",
        exit_code=result.get("exit_code"),
        duration_ms=result.get("duration_ms", 0.0),
        truncated=result.get("truncated", False),
    )

    return ExecutionResponse(**result)


@router.post("/approval-check", response_model=ApprovalResponse, status_code=200)
def approval_check(session_id: str, request: Request, body: ApprovalCheckRequest, response: Response):
    from sandbox.config import settings
    from sandbox.services.policy_checker import POLICY_VERSION

    session = require_owned_session(session_id, request)

    decision = policy_checker.check(ToolCallCheck(
        session_id=session_id,
        caller_id=session.caller_id,
        user_id=session.user_id,
        tool_name=body.tool_name,
        command=body.command,
        path=body.path,
        timeout=body.timeout,
        file_size=body.file_size,
    ))
    # Prefer explicit three-tier field; fall back for older decision objects
    tier = getattr(decision, "decision", None) or (
        "allow" if decision.allowed else (
            "approval_required" if decision.risk_level.value == "high" else "hard_deny"
        )
    )
    policy_version = getattr(decision, "policy_version", None) or POLICY_VERSION

    # ── hard_deny: never pending, never bypassed ────────────────
    if tier == "hard_deny":
        audit_logger.log_tool_call(
            session_id=session_id,
            tool_name=body.tool_name,
            caller_id=session.caller_id,
            allowed=False,
            risk_level=decision.risk_level.value,
            reason=decision.reason,
            metadata={
                "approval_check": True,
                "decision": tier,
                "policy_version": policy_version,
                "hard_deny": True,
            },
        )
        return ApprovalResponse(
            status="rejected",
            idempotency_key=body.idempotency_key,
            risk_level=decision.risk_level,
            reason=decision.reason,
            decision=tier,
            policy_version=policy_version,
            approval_bypassed=False,
        )

    # ── allow ───────────────────────────────────────────────────
    if tier == "allow" or decision.allowed:
        audit_logger.log_tool_call(
            session_id=session_id,
            tool_name=body.tool_name,
            caller_id=session.caller_id,
            allowed=True,
            risk_level=decision.risk_level.value,
            reason=decision.reason,
            metadata={
                "approval_check": True,
                "decision": "allow",
                "policy_version": policy_version,
            },
        )
        return ApprovalResponse(
            status="approved",
            idempotency_key=body.idempotency_key,
            risk_level=decision.risk_level,
            reason=decision.reason,
            decision="allow",
            policy_version=policy_version,
            approval_bypassed=False,
        )

    # ── approval_required ───────────────────────────────────────
    approval_mode = str(getattr(settings, "approval_mode", "ask"))
    if approval_mode == "deny":
        deny_reason = (
            f"{decision.reason} (approval asking disabled: "
            "APPROVAL_MODE=deny)"
        )
        audit_logger.log_tool_call(
            session_id=session_id,
            tool_name=body.tool_name,
            caller_id=session.caller_id,
            allowed=False,
            risk_level=decision.risk_level.value,
            reason=deny_reason,
            metadata={
                "approval_check": True,
                "decision": "approval_required",
                "policy_version": policy_version,
                "approval_bypassed": False,
                "approval_mode": approval_mode,
                "approval_disabled": True,
            },
        )
        return ApprovalResponse(
            status="rejected",
            idempotency_key=body.idempotency_key,
            risk_level=decision.risk_level,
            reason=deny_reason,
            decision="approval_required",
            policy_version=policy_version,
            approval_bypassed=False,
        )

    if approval_mode == "auto_approve":
        bypass_reason = (
            f"{decision.reason} (approval auto-approved: "
            "APPROVAL_MODE=auto_approve)"
        )
        audit_logger.log_tool_call(
            session_id=session_id,
            tool_name=body.tool_name,
            caller_id=session.caller_id,
            allowed=True,
            risk_level=decision.risk_level.value,
            reason=bypass_reason,
            metadata={
                "approval_check": True,
                "decision": "approval_required",
                "policy_version": policy_version,
                "approval_bypassed": True,
                "approval_mode": approval_mode,
            },
        )
        return ApprovalResponse(
            status="approved",
            idempotency_key=body.idempotency_key,
            risk_level=decision.risk_level,
            reason=bypass_reason,
            decision="approval_required",
            policy_version=policy_version,
            approval_bypassed=True,
        )

    response.status_code = 202
    try:
        entry = approval_manager.create(
            session_id=session_id,
            tool_name=body.tool_name,
            risk_level=decision.risk_level,
            reason=decision.reason,
            payload=body.model_dump(),
            idempotency_key=body.idempotency_key,
            operation_fingerprint=_approval_operation_fingerprint(session_id, body),
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name=body.tool_name,
        caller_id=session.caller_id,
        allowed=False,
        risk_level=decision.risk_level.value,
        reason=decision.reason,
        metadata={
            "approval_check": True,
            "decision": "approval_required",
            "policy_version": policy_version,
            "approval_id": entry["approval_id"],
        },
    )
    existing_status = entry.get("status")
    if existing_status == "approved":
        response.status_code = 200
    elif existing_status == "rejected":
        response.status_code = 200
    return ApprovalResponse(
        approval_id=entry["approval_id"],
        idempotency_key=entry.get("idempotency_key"),
        status=existing_status or "pending_approval",
        risk_level=decision.risk_level,
        reason=entry.get("reason") or decision.reason,
        decision="approval_required",
        policy_version=policy_version,
        approval_bypassed=False,
    )


@router.post("/cancel-active")
def cancel_active_execution(session_id: str, request: Request):
    """Cancel the session's currently running execution, if any.

    Used by chat/SSE disconnect cleanup. Returns 404 when the session is
    unknown, and a small JSON body when idle (no active execution).

    Also cancels foreground managed processes for the session (B2 cascade).
    """
    session = require_owned_session(session_id, request)

    # B2: run cancel must stop associated managed processes (foreground).
    process_ids: list[str] = []
    try:
        from sandbox.services.process_manager import process_manager

        process_ids = process_manager.cancel_for_session(
            session_id, foreground_only=False
        )
    except Exception:
        process_ids = []

    result = execution_manager.cancel_active(session_id)
    if result is None:
        return {
            "cancelled": bool(process_ids),
            "reason": "no active execution",
            "processes_cancelled": process_ids,
        }
    payload = ExecutionResponse(**result).model_dump()
    payload["processes_cancelled"] = process_ids
    return payload


@router.get("/{execution_id}", response_model=ExecutionResponse)
def get_execution(session_id: str, request: Request, execution_id: str):
    session = require_owned_session(session_id, request)

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if result["session_id"] != session_id:
        raise HTTPException(status_code=400, detail="Execution does not belong to this session")

    return ExecutionResponse(**result)


@router.get("/{execution_id}/logs", response_model=ExecutionLogsResponse)
def get_execution_logs(
    session_id: str,
    request: Request,
    execution_id: str,
    offset: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=500_000),
):
    """Pageable execution logs (B3). Supports offset/limit pull after disconnect."""
    session = require_owned_session(session_id, request)

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if result["session_id"] != session_id:
        raise HTTPException(status_code=400, detail="Execution does not belong to this session")

    logs = execution_manager.logs(execution_id, offset=offset, limit=limit)
    if logs is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    return ExecutionLogsResponse(**logs)


@router.get(
    "/{execution_id}/events",
    response_model=list[ExecutionEventResponse],
)
def list_execution_events(
    session_id: str,
    request: Request,
    execution_id: str,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    session = require_owned_session(session_id, request)

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if result["session_id"] != session_id:
        raise HTTPException(status_code=400, detail="Execution does not belong to this session")

    events = execution_manager.list_events(
        execution_id, after_sequence=after_sequence, limit=limit
    )
    if events is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    return [ExecutionEventResponse(**e) for e in events]


@router.get("/{execution_id}/events/stream")
def stream_execution_events(
    session_id: str,
    execution_id: str,
    request: Request,
    after_sequence: int = Query(0, ge=0),
    last_event_id: str | None = Header(None, alias="Last-Event-ID"),
):
    """SSE stream of short-command execution events with sequence resume (B3)."""
    session = require_owned_session(session_id, request)

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if result["session_id"] != session_id:
        raise HTTPException(status_code=400, detail="Execution does not belong to this session")

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

    unsub = execution_manager.subscribe_events(execution_id, after, _on_event)
    if unsub is None:
        raise HTTPException(status_code=404, detail="Execution not found")

    def _generate() -> Iterator[str]:
        try:
            while not closed.is_set():
                try:
                    entry = q.get(timeout=15.0)
                except queue.Empty:
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


@router.post("/{execution_id}/cancel", response_model=ExecutionResponse)
def cancel_execution(session_id: str, request: Request, execution_id: str):
    session = require_owned_session(session_id, request)

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")

    if execution_manager.cancel(execution_id):
        # Re-read after cancel so race-resolved terminal status is returned
        result = execution_manager.get(execution_id) or result
        if result.get("status") not in (
            ExecutionStatus.CANCELLED,
            ExecutionStatus.CANCELLED.value,
            ExecutionStatus.SUCCESS,
            ExecutionStatus.SUCCESS.value,
            ExecutionStatus.FAILED,
            ExecutionStatus.FAILED.value,
            ExecutionStatus.TIMEOUT,
            ExecutionStatus.TIMEOUT.value,
        ):
            result["status"] = ExecutionStatus.CANCELLED
    return ExecutionResponse(**result)
