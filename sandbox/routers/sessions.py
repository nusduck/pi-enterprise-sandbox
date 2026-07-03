"""Session API router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sandbox.models import SessionCreate, SessionResponse, SessionStatus
from sandbox.services.audit_logger import audit_logger
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", response_model=SessionResponse, status_code=201)
def create_session(body: SessionCreate):
    session = session_manager.create(
        agent_session_id=body.agent_session_id,
        enterprise_session_id=body.enterprise_session_id,
        user_id=body.user_id,
        caller_id=body.caller_id,
        metadata=body.metadata,
    )
    workspace_manager.init_workspace(session.session_id)
    audit_logger.log_session_lifecycle(
        session.session_id, "created",
        {"caller_id": body.caller_id},
    )
    return session


@router.get("/by-agent/{agent_session_id}", response_model=SessionResponse)
def get_session_by_agent_session_id(agent_session_id: str):
    session = session_manager.get_by_agent_session_id(agent_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get("/by-enterprise/{enterprise_session_id}", response_model=SessionResponse)
def get_session_by_enterprise_session_id(enterprise_session_id: str):
    session = session_manager.get_by_enterprise_session_id(enterprise_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session_manager.update_status(session_id, SessionStatus.COMPLETED)
    workspace_manager.remove_workspace(session_id)
    audit_logger.log_session_lifecycle(session_id, "deleted")
    return
