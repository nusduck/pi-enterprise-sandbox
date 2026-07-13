"""Session API router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.models import SessionCreate, SessionResponse, SessionStatus
from sandbox.paths import conversation_workspace_id
from sandbox.repositories import ConversationRepository
from sandbox.security.ownership import (
    assert_resource_owner,
    assert_session_owner,
    resolve_actor,
)
from sandbox.services.audit_logger import audit_logger
from sandbox.services.session_manager import public_session_response, session_manager
from sandbox.services.workspace_manager import (
    WorkspaceWriteConflict,
    workspace_manager,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])
conversation_repository = ConversationRepository()


@router.post("", response_model=SessionResponse, status_code=201)
def create_session(body: SessionCreate, request: Request):
    actor = resolve_actor(request) if settings.auth_enabled else None
    # Prefer trusted actor identity over client-supplied user_id when auth is on
    user_id = body.user_id
    if actor is not None:
        user_id = actor.user_id

    # Stamp organization_id into session metadata for trace/owner filtering.
    create_meta = dict(body.metadata or {})
    if actor is not None:
        create_meta.setdefault("organization_id", actor.organization_id)

    if body.workspace_id and not body.conversation_id:
        raise HTTPException(
            status_code=400,
            detail="workspace_id cannot be used without conversation_id",
        )
    if body.conversation_id:
        conversation = conversation_repository.get(body.conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if actor is not None:
            assert_resource_owner(
                conversation,
                actor,
                not_found_detail="Conversation not found",
            )
        expected_workspace = conversation_workspace_id(body.conversation_id)
        if body.workspace_id and body.workspace_id != expected_workspace:
            raise HTTPException(
                status_code=400,
                detail="workspace_id does not match conversation binding",
            )

    try:
        session = session_manager.create(
            agent_session_id=body.agent_session_id,
            enterprise_session_id=body.enterprise_session_id,
            user_id=user_id,
            caller_id=body.caller_id,
            metadata=create_meta,
            conversation_id=body.conversation_id,
            workspace_id=body.workspace_id,
        )
    except WorkspaceWriteConflict as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "Workspace write lease conflict: another session already holds "
                f"write access (holder={exc.holder_session_id})"
            ),
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    # Ensure physical directory exists. Never rely on the global symlink.
    physical = (session.metadata or {}).get("_physical_workspace")
    workspace_id = (session.metadata or {}).get("workspace_id") or session.workspace_id
    if physical:
        workspace_manager.activate_workspace(physical)  # no-op unless flag on
        if workspace_id:
            workspace_manager.init_temp(workspace_id)
    else:
        workspace_manager.init_workspace(session.session_id)

    meta = {"caller_id": body.caller_id}
    if actor is not None:
        meta["user_id"] = actor.user_id
        meta["organization_id"] = actor.organization_id
    elif user_id:
        meta["user_id"] = user_id
    if workspace_id:
        meta["workspace_id"] = workspace_id

    audit_logger.log_session_lifecycle(
        session.session_id, "created",
        meta,
    )
    return public_session_response(session)


@router.get("/by-agent/{agent_session_id}", response_model=SessionResponse)
def get_session_by_agent_session_id(agent_session_id: str, request: Request):
    session = session_manager.get_by_agent_session_id(agent_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return public_session_response(session)


@router.get("/by-enterprise/{enterprise_session_id}", response_model=SessionResponse)
def get_session_by_enterprise_session_id(enterprise_session_id: str, request: Request):
    session = session_manager.get_by_enterprise_session_id(enterprise_session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return public_session_response(session)


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(session_id: str, request: Request):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    return public_session_response(session)


@router.get("", response_model=list[SessionResponse])
def list_sessions():
    """List all active sessions.

    Service token alone may list sessions (internal sandbox ops). End-user
    conversation listing is separately ownership-scoped.
    """
    return [public_session_response(s) for s in session_manager.list_active()]


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: str, request: Request):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    actor = resolve_actor(request) if settings.auth_enabled else None
    assert_session_owner(session, actor)
    session_manager.update_status(session_id, SessionStatus.COMPLETED)
    from sandbox.services.execution_manager import execution_manager
    from sandbox.services.process_manager import process_manager

    execution_manager.cancel_active_workspace(session.workspace_id)
    process_manager.cancel_for_workspace(session.workspace_id)
    # Only remove session-private trees (workspace_id == session_id).
    # Conversation workspaces are retained for rebind.
    meta = session.metadata or {}
    wid = meta.get("workspace_id") or session.workspace_id
    if not wid or wid == session_id:
        workspace_manager.remove_workspace(session_id)
    session_manager.delete(session_id)
    meta_log = None
    if actor is not None:
        meta_log = {"user_id": actor.user_id, "organization_id": actor.organization_id}
    audit_logger.log_session_lifecycle(session_id, "deleted", meta_log)
    return
