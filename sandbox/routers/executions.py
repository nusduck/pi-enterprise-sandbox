"""Execution API router — run python, commands, query/cancel."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from sandbox.models import (
    ApprovalCheckRequest,
    ApprovalResponse,
    CommandExecutionRequest,
    ExecutionResponse,
    ExecutionStatus,
    NodeExecutionRequest,
    PythonExecutionRequest,
    ToolCallCheck,
)
from sandbox.paths import ensure_physical_workspace
from sandbox.services.audit_logger import audit_logger
from sandbox.services.approval_manager import approval_manager
from sandbox.services.execution_manager import execution_manager
from sandbox.services.policy_checker import policy_checker
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/sessions/{session_id}/executions", tags=["executions"])


def _require_active_session(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "RUNNING":
        raise HTTPException(status_code=400, detail="Session is not active")
    return session


def _execution_cwd(session) -> str:
    """Always return the physical workspace path for concurrent-safe execution.

    Never use the process-global presentation symlink as cwd — concurrent
    sessions would race on that link. Global activate is disabled by default.
    """
    physical = ensure_physical_workspace(session)
    # No-op unless SANDBOX_ENABLE_GLOBAL_WORKSPACE_SYMLINK=true
    workspace_manager.activate_workspace(physical)
    return str(physical)


@router.post("/python", response_model=ExecutionResponse, status_code=201)
def run_python(session_id: str, body: PythonExecutionRequest):
    session = _require_active_session(session_id)
    ws = _execution_cwd(session)
    result = execution_manager.run_python(
        session_id=session_id,
        code=body.code,
        workspace_path=ws,
        timeout=body.timeout,
        env_overrides=body.env_overrides if body.env_overrides else None,
    )

    if result.get("status") == "conflict":
        raise HTTPException(status_code=409, detail=result["error"])

    audit_logger.log_execution(
        session_id=session_id,
        execution_id=result["execution_id"],
        run_type="python",
        exit_code=result.get("exit_code"),
        duration_ms=result.get("duration_ms", 0.0),
        truncated=result.get("truncated", False),
    )

    return ExecutionResponse(**result)


@router.post("/command", response_model=ExecutionResponse, status_code=201)
def run_command(session_id: str, body: CommandExecutionRequest):
    # Session is mandatory — service token alone cannot run without a live session.
    session = _require_active_session(session_id)

    # Independent hard-deny re-check (do not trust Agent/Extension conclusions).
    # Approval credentials and APPROVAL_ENABLED never override hard_deny.
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

    ws = _execution_cwd(session)
    result = execution_manager.run_command(
        session_id=session_id,
        command=body.command,
        workspace_path=ws,
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
def run_node(session_id: str, body: NodeExecutionRequest):
    session = _require_active_session(session_id)
    ws = _execution_cwd(session)
    result = execution_manager.run_node(
        session_id=session_id,
        code=body.code,
        workspace_path=ws,
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
def approval_check(session_id: str, body: ApprovalCheckRequest, response: Response):
    from sandbox.config import settings
    from sandbox.services.policy_checker import POLICY_VERSION

    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

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
            risk_level=decision.risk_level,
            reason=decision.reason,
            decision="allow",
            policy_version=policy_version,
            approval_bypassed=False,
        )

    # ── approval_required ───────────────────────────────────────
    approval_enabled = bool(getattr(settings, "approval_enabled", True))
    if not approval_enabled:
        bypass_reason = f"{decision.reason} (approval bypassed: APPROVAL_ENABLED=false)"
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
                "approval_enabled": False,
            },
        )
        return ApprovalResponse(
            status="approved",
            risk_level=decision.risk_level,
            reason=bypass_reason,
            decision="approval_required",
            policy_version=policy_version,
            approval_bypassed=True,
        )

    response.status_code = 202
    entry = approval_manager.create(
        session_id=session_id,
        tool_name=body.tool_name,
        risk_level=decision.risk_level,
        reason=decision.reason,
        payload=body.model_dump(),
    )
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
    return ApprovalResponse(
        approval_id=entry["approval_id"],
        status="pending_approval",
        risk_level=decision.risk_level,
        reason=decision.reason,
        decision="approval_required",
        policy_version=policy_version,
        approval_bypassed=False,
    )


@router.post("/cancel-active")
def cancel_active_execution(session_id: str):
    """Cancel the session's currently running execution, if any.

    Used by chat/SSE disconnect cleanup. Returns 404 when the session is
    unknown, and a small JSON body when idle (no active execution).
    """
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    result = execution_manager.cancel_active(session_id)
    if result is None:
        return {"cancelled": False, "reason": "no active execution"}
    return ExecutionResponse(**result)


@router.get("/{execution_id}", response_model=ExecutionResponse)
def get_execution(session_id: str, execution_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    result = execution_manager.get(execution_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    if result["session_id"] != session_id:
        raise HTTPException(status_code=400, detail="Execution does not belong to this session")

    return ExecutionResponse(**result)


@router.post("/{execution_id}/cancel", response_model=ExecutionResponse)
def cancel_execution(session_id: str, execution_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

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
