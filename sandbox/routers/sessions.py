"""Session API router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.models import SessionCreate, SessionResponse, SessionStatus
from sandbox.security.ownership import assert_session_owner, resolve_actor
from sandbox.services.audit_logger import audit_logger
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("", response_model=SessionResponse, status_code=201)
def create_session(body: SessionCreate, request: Request):
    actor = resolve_actor(request) if settings.auth_enabled else None
    # Prefer trusted actor identity over client-supplied user_id when auth is on
    user_id = body.user_id
    if actor is not None:
        user_id = actor.user_id

    session = session_manager.create(
        agent_session_id=body.agent_session_id,
        enterprise_session_id=body.enterprise_session_id,
        user_id=user_id,
        caller_id=body.caller_id,
        metadata=body.metadata,
        workspace_path_override=body.workspace_path,
    )
    if body.workspace_path:
        # Ensure physical path exists; optional presentation link is best-effort
        workspace_manager.activate_workspace(body.workspace_path)
    else:
        # Init empty physical workspace for this session (no skills seed)
        workspace_manager.init_workspace(session.session_id)

    meta = {"caller_id": body.caller_id}
    if actor is not None:
        meta["user_id"] = actor.user_id
        meta["organization_id"] = actor.organization_id
    elif user_id:
        meta["user_id"] = user_id

    audit_logger.log_session_lifecycle(
        session.session_id, "created",
        meta,
    )
    return session


@router.get("/by-agent/{agent_session_id}", response_model=SessionResponse)
def get_session_by_agent_session_id(agent_session_id: str, request: Request):
    session = session_manager.get_by_agent_session_id(agent_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return session


@router.get("/by-enterprise/{enterprise_session_id}", response_model=SessionResponse)
def get_session_by_enterprise_session_id(enterprise_session_id: str, request: Request):
    session = session_manager.get_by_enterprise_session_id(enterprise_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return session


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(session_id: str, request: Request):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return session


@router.get("", response_model=list[SessionResponse])
def list_sessions():
    """List all active sessions.

    Service token alone may list sessions (internal sandbox ops). End-user
    conversation listing is separately ownership-scoped.
    """
    return session_manager.list_active()


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: str, request: Request):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    session_manager.update_status(session_id, SessionStatus.COMPLETED)
    workspace_manager.remove_workspace(session_id)
    session_manager.delete(session_id)
    meta = None
    if actor is not None:
        meta = {"user_id": actor.user_id, "organization_id": actor.organization_id}
    audit_logger.log_session_lifecycle(session_id, "deleted", meta)
    return
