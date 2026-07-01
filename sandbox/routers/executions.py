"""Execution API router — run python, commands, query/cancel."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sandbox.models import (
    CommandExecutionRequest,
    ExecutionResponse,
    ExecutionStatus,
    PythonExecutionRequest,
)
from sandbox.services.audit_logger import audit_logger
from sandbox.services.execution_manager import execution_manager
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/sessions/{session_id}/executions", tags=["executions"])


@router.post("/python", response_model=ExecutionResponse, status_code=201)
def run_python(session_id: str, body: PythonExecutionRequest):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "RUNNING":
        raise HTTPException(status_code=400, detail="Session is not active")

    ws = workspace_manager.get_workspace_path(session_id)
    result = execution_manager.run_python(
        session_id=session_id,
        code=body.code,
        workspace_path=str(ws),
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
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.status != "RUNNING":
        raise HTTPException(status_code=400, detail="Session is not active")

    ws = workspace_manager.get_workspace_path(session_id)
    result = execution_manager.run_command(
        session_id=session_id,
        command=body.command,
        workspace_path=str(ws),
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
