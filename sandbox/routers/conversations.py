"""Conversation API router — persists conversations via the sandbox DB.

Enables the webui conversation-manager to read/write conversations directly
through the sandbox REST API instead of using a local JSON file.

When ``SANDBOX_AUTH_ENABLED`` is true, list/create/get/update/delete are scoped
to the resolved actor (JWT or service+acting headers). Cross-user access is 404.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.models import ConversationCreate, ConversationResponse
from sandbox.paths import AGENT_WORKSPACE_PATH, conversation_workspace_id, to_public_workspace_path
from sandbox.repositories import ConversationRepository
from sandbox.security.ownership import require_actor
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/conversations", tags=["conversations"])
repo = ConversationRepository()


def _public_conversation(conv: ConversationResponse) -> ConversationResponse:
    """Ensure API responses never expose host physical workspace paths."""
    conv.workspace_path = to_public_workspace_path(conv.workspace_path)
    return conv


def _get_owned_or_404(conversation_id: str, request: Request) -> ConversationResponse:
    """Load conversation and enforce ownership when auth is on."""
    if not settings.auth_enabled:
        conv = repo.get(conversation_id)
        if not conv:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return _public_conversation(conv)

    actor = require_actor(request)
    conv = repo.get_for_owner(
        conversation_id,
        user_id=actor.user_id,
        organization_id=actor.organization_id,
        is_admin=actor.is_admin,
    )
    if not conv:
        # Fall back to generic not-found (no existence leak)
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _public_conversation(conv)


@router.get("", response_model=list[ConversationResponse])
def list_conversations(request: Request):
    """Return conversations visible to the actor, newest first.

    Auth off: all conversations (dev open mode).
    Auth on: owner-scoped; admin sees all in organization.
    Service token alone (no acting user / JWT) → 401.
    """
    if not settings.auth_enabled:
        return [_public_conversation(c) for c in repo.list_all()]

    actor = require_actor(request)
    return [
        _public_conversation(c)
        for c in repo.list_for_user(
            user_id=actor.user_id,
            organization_id=actor.organization_id,
            is_admin=actor.is_admin,
        )
    ]


@router.post("", response_model=ConversationResponse, status_code=201)
def create_conversation(body: ConversationCreate, request: Request):
    """Create a new conversation (or upsert if id is provided).

    Initializes a persistent workspace directory tied to the conversation.
    Client-supplied ids are validated so they cannot escape workspaces_root.
    Stamps owner_user_id / organization_id from the resolved actor.
    """
    import uuid

    from sandbox.security.path_validation import validate_conversation_id

    actor = require_actor(request) if settings.auth_enabled else None

    if body.id is not None:
        try:
            conv_id = validate_conversation_id(body.id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        conv_id = str(uuid.uuid4())
    # Initialize persistent workspace for this conversation.
    # Store workspace_id key in DB; API always returns logical path.
    try:
        workspace_manager.init_conversation_workspace(conv_id)
    except (ValueError, PermissionError) as exc:
        raise HTTPException(
            status_code=400 if isinstance(exc, ValueError) else 403,
            detail=str(exc),
        )
    # Persist a stable workspace key (not host absolute path) for rebind.
    stored_workspace = conversation_workspace_id(conv_id)

    owner_user_id = None
    organization_id = None
    if actor is not None:
        owner_user_id = actor.user_id
        organization_id = actor.organization_id
    elif not settings.auth_enabled:
        # Dev open mode: stamp bootstrap ownership so columns are never null going forward
        from sandbox.security.ownership import BOOTSTRAP_ORG_ID, BOOTSTRAP_USER_ID

        owner_user_id = BOOTSTRAP_USER_ID
        organization_id = BOOTSTRAP_ORG_ID

    entry = {
        "id": conv_id,
        "title": body.title or "New conversation",
        "sandbox_session_id": body.sandbox_session_id,
        "workspace_path": stored_workspace,
        "messages": list(body.messages or []),
        "owner_user_id": owner_user_id,
        "organization_id": organization_id,
    }
    return _public_conversation(repo.upsert(entry))


@router.get("/{conversation_id}", response_model=ConversationResponse)
def get_conversation(conversation_id: str, request: Request):
    return _get_owned_or_404(conversation_id, request)


@router.patch("/{conversation_id}", response_model=ConversationResponse)
def update_conversation(conversation_id: str, body: ConversationCreate, request: Request):
    existing = _get_owned_or_404(conversation_id, request)
    # Only replace fields that were explicitly provided (None = leave unchanged)
    entry = {
        "id": conversation_id,
        "title": body.title if body.title is not None else existing.title,
        "sandbox_session_id": (
            body.sandbox_session_id
            if body.sandbox_session_id is not None
            else existing.sandbox_session_id
        ),
        # Always persist the stable workspace_id key (never host absolute paths).
        "workspace_path": conversation_workspace_id(conversation_id),
        "messages": (
            list(body.messages)
            if body.messages is not None
            else list(existing.messages)
        ),
        "owner_user_id": existing.owner_user_id,
        "organization_id": existing.organization_id,
        "created_at": existing.created_at,
    }
    return _public_conversation(repo.upsert(entry))


def _cleanup_linked_session(sandbox_session_id: str) -> None:
    """Mark linked sandbox session completed and delete when safe.

    Safe means: no in-flight execution for that session. Session workspace is
    removed only after a successful delete of the session record.
    """
    from sandbox.models import SessionStatus
    from sandbox.services.execution_manager import execution_manager
    from sandbox.services.session_manager import session_manager

    session = session_manager.get(sandbox_session_id)
    if session is None:
        return

    session_manager.update_status(sandbox_session_id, SessionStatus.COMPLETED)

    if execution_manager.is_session_busy(sandbox_session_id):
        return

    if session_manager.delete(sandbox_session_id):
        workspace_manager.remove_workspace(sandbox_session_id)


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, request: Request):
    conv = _get_owned_or_404(conversation_id, request)

    # If a sandbox session is linked, complete it and delete when idle.
    if conv.sandbox_session_id:
        _cleanup_linked_session(conv.sandbox_session_id)

    repo.delete(conversation_id)
    workspace_manager.remove_conversation_workspace(conversation_id)


@router.get("/{conversation_id}/messages", response_model=list[dict])
def get_conversation_messages(conversation_id: str, request: Request):
    conv = _get_owned_or_404(conversation_id, request)
    return conv.messages


@router.patch("/{conversation_id}/title", response_model=ConversationResponse)
def update_conversation_title(conversation_id: str, body: dict, request: Request):
    title = body.get("title")
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    _get_owned_or_404(conversation_id, request)
    updated = repo.update_title(conversation_id, title)
    if not updated:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return _public_conversation(updated)


@router.get("/{conversation_id}/workspace", response_model=dict)
def get_conversation_workspace(conversation_id: str, request: Request):
    """Return the persistent workspace path for a conversation.

    ``workspace_path`` is always the agent-visible logical root.
    ``workspace_id`` is the stable conversation-owned storage key.
    """
    conv = _get_owned_or_404(conversation_id, request)
    return {
        "conversation_id": conversation_id,
        "workspace_path": AGENT_WORKSPACE_PATH,
        "workspace_id": conversation_workspace_id(conversation_id),
    }
