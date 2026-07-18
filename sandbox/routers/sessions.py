"""Session API router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.models import SessionCreate, SessionResponse, SessionStatus
from sandbox.security.ownership import (
    assert_legacy_session_binding_create_allowed,
    assert_resource_owner,
    assert_session_owner,
    require_end_user_actor,
    require_owned_session,
    resolve_actor,
    session_visible_to_actor,
)
from sandbox.services.audit_logger import audit_logger
from sandbox.services.session_manager import (
    WorkspaceBindingConflict,
    WorkspaceBindingRequired,
    public_session_response,
    session_manager,
)
from sandbox.services.workspace_manager import (
    WorkspaceCleanupError,
    workspace_manager,
)

router = APIRouter(prefix="/sessions", tags=["sessions"])


def _load_owned_session_or_404(loader, key: str, request: Request):
    """Actor-first load for lookup routes (no existence leak to service-token-alone)."""
    actor = require_end_user_actor(request)
    session = loader(key)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if actor is not None:
        assert_session_owner(session, actor)
    return session


@router.post("", response_model=SessionResponse, status_code=201)
def create_session(body: SessionCreate, request: Request):
    """Create a sandbox session bound to a formal AgentSession workspace.

    **Auth mode (production):** fail closed. Client-supplied
    ``agent_session_id`` / ``workspace_id`` / ``sandbox_session_id`` are not
    trustworthy under JWT, acting headers, or static API key until PR-07B
    HMAC/fence transport proves Agent preallocation.

    **Dev/test (``auth_enabled=false`` only):** local create remains available
    for offline suites. Never enable auth_disabled in production.
    """
    # Fail closed before any validation side effects when auth is on.
    assert_legacy_session_binding_create_allowed()

    actor = resolve_actor(request) if settings.auth_enabled else None
    # Prefer trusted actor identity over client-supplied user_id when auth is on
    user_id = body.user_id
    if actor is not None:
        user_id = actor.user_id

    # Stamp organization_id into session metadata for trace/owner filtering.
    create_meta = dict(body.metadata or {})
    if actor is not None:
        create_meta.setdefault("organization_id", actor.organization_id)

    # Workspace ownership is AgentSession-bound only (PR-07A). conversation_id
    # is optional metadata and never derives workspace_id.
    if not body.agent_session_id or not body.workspace_id:
        raise HTTPException(
            status_code=400,
            detail="agent_session_id and workspace_id are required",
        )

    if body.conversation_id:
        from sandbox.repositories import ConversationRepository
        from sandbox.security.path_validation import validate_conversation_id

        try:
            validate_conversation_id(body.conversation_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        conversation_repository = ConversationRepository()
        conversation = conversation_repository.get(body.conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        if actor is not None:
            assert_resource_owner(
                conversation,
                actor,
                not_found_detail="Conversation not found",
            )

    # Detect pre-existing binding so init failures do not destroy reactivations
    # and so we can init-before-create for brand-new rows (no orphan bindings).
    prior = session_manager.get_by_agent_session_id(body.agent_session_id)
    prior_session_id = prior.session_id if prior is not None else None

    if prior is None:
        # New binding: materialize directories first so a failed init never
        # leaves a permanent DB occupancy of agent_session_id/workspace_id.
        try:
            workspace_manager.init_workspace(body.workspace_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except PermissionError as exc:
            raise HTTPException(status_code=403, detail=str(exc)) from exc

    try:
        session = session_manager.create(
            agent_session_id=body.agent_session_id,
            enterprise_session_id=body.enterprise_session_id,
            user_id=user_id,
            caller_id=body.caller_id,
            metadata=create_meta,
            conversation_id=body.conversation_id,
            workspace_id=body.workspace_id,
            sandbox_session_id=body.sandbox_session_id,
        )
    except WorkspaceBindingRequired as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except WorkspaceBindingConflict as exc:
        # Fail closed without leaking physical roots or existence details.
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    workspace_id = session.workspace_id or (session.metadata or {}).get("workspace_id")
    if not workspace_id:
        # Should not happen after formal create; compensate brand-new rows only
        # after disk cleanup succeeds so the workspace id is not freed with data.
        if prior_session_id is None:
            try:
                workspace_manager.remove_workspace(session.workspace_id or body.workspace_id)
            except WorkspaceCleanupError:
                # Keep the incomplete row rather than free a dirty workspace id.
                raise HTTPException(
                    status_code=500,
                    detail="Session missing workspace binding; cleanup failed",
                )
            session_manager.delete(session.session_id)
        raise HTTPException(status_code=500, detail="Session missing workspace binding")

    # Ensure physical tree exists (idempotent). Reactivation path may reach here
    # without the pre-create init above.
    try:
        workspace_manager.init_workspace(workspace_id)
    except (ValueError, PermissionError, OSError) as exc:
        # Compensate only brand-new binding rows — never delete a prior session
        # that was merely reactivated. Clean disk before releasing the binding.
        if prior_session_id is None:
            try:
                workspace_manager.remove_workspace(workspace_id)
            except WorkspaceCleanupError:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Workspace initialization failed and cleanup could not "
                        "complete; binding retained"
                    ),
                ) from exc
            session_manager.delete(session.session_id)
        raise HTTPException(
            status_code=400 if isinstance(exc, ValueError) else 403,
            detail="Workspace initialization failed",
        ) from exc

    meta = {"caller_id": body.caller_id}
    if actor is not None:
        meta["user_id"] = actor.user_id
        meta["organization_id"] = actor.organization_id
    elif user_id:
        meta["user_id"] = user_id
    meta["workspace_id"] = workspace_id
    meta["agent_session_id"] = session.agent_session_id

    audit_logger.log_session_lifecycle(
        session.session_id, "created",
        meta,
    )
    return public_session_response(session)


@router.get("/by-agent/{agent_session_id}", response_model=SessionResponse)
def get_session_by_agent_session_id(agent_session_id: str, request: Request):
    session = _load_owned_session_or_404(
        session_manager.get_by_agent_session_id, agent_session_id, request
    )
    return public_session_response(session)


@router.get("/by-enterprise/{enterprise_session_id}", response_model=SessionResponse)
def get_session_by_enterprise_session_id(enterprise_session_id: str, request: Request):
    session = _load_owned_session_or_404(
        session_manager.get_by_enterprise_session_id,
        enterprise_session_id,
        request,
    )
    return public_session_response(session)


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(session_id: str, request: Request):
    session = require_owned_session(session_id, request)
    return public_session_response(session)


@router.get("", response_model=list[SessionResponse])
def list_sessions(request: Request):
    """List active sessions with ownership scope when auth is on.

    - ``auth_enabled=false`` (dev/test only): all active sessions.
    - End-user actor (JWT / service+acting): org-scoped; admin same-org only;
      user same org+user. Missing ownership metadata sessions are hidden.
    - Service token alone: **401** (not a trusted public-plane internal face).
    """
    actor = require_end_user_actor(request)
    sessions = session_manager.list_active()
    if actor is None:
        return [public_session_response(s) for s in sessions]
    return [
        public_session_response(s)
        for s in sessions
        if session_visible_to_actor(s, actor)
    ]


@router.delete("/{session_id}", status_code=204)
def delete_session(session_id: str, request: Request):
    session = require_owned_session(session_id, request)

    from sandbox.services.execution_manager import execution_manager
    from sandbox.services.process_manager import process_manager

    workspace_id = session.workspace_id or (session.metadata or {}).get("workspace_id")
    if workspace_id:
        execution_manager.cancel_active_workspace(workspace_id)
        process_manager.cancel_for_workspace(workspace_id)

    # Refuse to tear down the physical workspace while a runner still holds it.
    if execution_manager.is_session_busy(session_id) or (
        workspace_id and execution_manager.is_workspace_busy(workspace_id)
    ):
        raise HTTPException(
            status_code=409,
            detail="Session has an active execution; close refused",
        )

    session_manager.update_status(session_id, SessionStatus.COMPLETED)

    # Safety order: physical cleanup **before** releasing the binding.
    # If disk cleanup fails, keep the session/workspace binding so a different
    # AgentSession cannot be assigned the same workspace_id and read residual data.
    if workspace_id:
        try:
            workspace_manager.remove_workspace(workspace_id)
        except WorkspaceCleanupError as exc:
            raise HTTPException(
                status_code=500,
                detail=(
                    "Workspace cleanup failed; session binding retained to prevent "
                    "cross-session data reuse"
                ),
            ) from exc

    session_manager.delete(session_id)

    actor = resolve_actor(request) if settings.auth_enabled else None
    meta_log = None
    if actor is not None:
        meta_log = {"user_id": actor.user_id, "organization_id": actor.organization_id}
    audit_logger.log_session_lifecycle(session_id, "deleted", meta_log)
    return
