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
    sessions would race on that link. Activate remains best-effort for
    single-session presentation only and is never used as the exec cwd.
    """
    physical = ensure_physical_workspace(session)
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
    session = _require_active_session(session_id)
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
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name=body.tool_name,
        caller_id=session.caller_id,
        allowed=decision.allowed,
        risk_level=decision.risk_level.value,
        reason=decision.reason,
        metadata={"approval_check": True},
    )
    if decision.allowed:
        return ApprovalResponse(
            status="approved",
            risk_level=decision.risk_level,
            reason=decision.reason,
        )

    if decision.risk_level.value == "high":
        response.status_code = 202
        entry = approval_manager.create(
            session_id=session_id,
            tool_name=body.tool_name,
            risk_level=decision.risk_level,
            reason=decision.reason,
            payload=body.model_dump(),
        )
        return ApprovalResponse(
            approval_id=entry["approval_id"],
            status="pending_approval",
            risk_level=decision.risk_level,
            reason=decision.reason,
        )

    return ApprovalResponse(
        status="rejected",
        risk_level=decision.risk_level,
        reason=decision.reason,
    )


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
        result["status"] = ExecutionStatus.CANCELLED
    return ExecutionResponse(**result)
