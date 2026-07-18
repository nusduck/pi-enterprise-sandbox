"""Conversation API router — persists conversations via the sandbox DB.

Enables the webui conversation-manager to read/write conversations directly
through the sandbox REST API instead of using a local JSON file.

When ``SANDBOX_AUTH_ENABLED`` is true, list/create/get/update/delete are scoped
to the resolved actor (JWT or service+acting headers). Cross-user access is 404.

PR-07A: Conversation lifecycle does **not** create or delete Workspace.
Workspace ownership follows AgentSession / Sandbox Session only.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.models import ConversationCreate, ConversationResponse
from sandbox.repositories import ConversationRepository
from sandbox.security.ownership import require_actor

router = APIRouter(prefix="/conversations", tags=["conversations"])
repo = ConversationRepository()


def _public_conversation(conv: ConversationResponse) -> ConversationResponse:
    """Ensure API responses never expose host physical workspace paths."""
    wid = conv.workspace_id
    # Reject absolute physical paths if they ever leaked into storage.
    if wid and str(wid).startswith("/"):
        wid = None
    return ConversationResponse(
        id=conv.id,
        title=conv.title,
        sandbox_session_id=conv.sandbox_session_id,
        agent_session_id=conv.agent_session_id,
        workspace_id=wid,
        messages=list(conv.messages or []),
        owner_user_id=conv.owner_user_id,
        organization_id=conv.organization_id,
        interrupted=conv.interrupted,
        last_run_id=conv.last_run_id,
        legal_hold=conv.legal_hold,
        created_at=conv.created_at,
        updated_at=conv.updated_at,
    )


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

    Does **not** create a Workspace. Workspace binding is owned by AgentSession
    and established when a Sandbox Session is created with preallocated ids.
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

    # Optional client-supplied workspace_id is stored as a pointer only when
    # provided; Conversation never invents or owns workspace identity.
    stored_workspace = body.workspace_id if getattr(body, "workspace_id", None) else None
    if stored_workspace and str(stored_workspace).startswith("/"):
        stored_workspace = None

    entry = {
        "id": conv_id,
        "title": body.title or "New conversation",
        "sandbox_session_id": body.sandbox_session_id,
        "agent_session_id": body.agent_session_id,
        "workspace_id": stored_workspace,
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
    # Only replace fields that were explicitly provided (None = leave unchanged).
    # Never invent conversation-owned workspace ids.
    next_workspace = existing.workspace_id
    if body.workspace_id is not None:
        next_workspace = body.workspace_id
        if next_workspace and str(next_workspace).startswith("/"):
            next_workspace = existing.workspace_id
    entry = {
        "id": conversation_id,
        "title": body.title if body.title is not None else existing.title,
        "sandbox_session_id": (
            body.sandbox_session_id
            if body.sandbox_session_id is not None
            else existing.sandbox_session_id
        ),
        "agent_session_id": (
            body.agent_session_id
            if body.agent_session_id is not None
            else existing.agent_session_id
        ),
        "workspace_id": next_workspace,
        "workspace_path": next_workspace,
        "messages": (
            list(body.messages)
            if body.messages is not None
            else list(existing.messages)
        ),
        "owner_user_id": existing.owner_user_id,
        "organization_id": existing.organization_id,
        "interrupted": (
            body.interrupted
            if body.interrupted is not None
            else existing.interrupted
        ),
        "last_run_id": (
            body.last_run_id
            if body.last_run_id is not None
            else existing.last_run_id
        ),
        "legal_hold": (
            body.legal_hold if body.legal_hold is not None else existing.legal_hold
        ),
        "created_at": existing.created_at,
    }
    return _public_conversation(repo.upsert(entry))


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str, request: Request):
    """Delete conversation metadata only.

    Conversation does **not** own Workspace or SandboxSession (plan §2.6 /
    PR-07A). Linked sessions, executions, and workspace/temp trees are left
    intact; lifecycle cleanup remains Session / AgentSession close.
    """
    _get_owned_or_404(conversation_id, request)
    # Conversation repository delete only — no session cancel/close/workspace remove.
    repo.delete(conversation_id)


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
    """Return the opaque workspace identity linked to a conversation, if any.

    Public contract: ``workspace_id`` only — never physical host paths.
    Conversation does not own or invent workspace identity.
    """
    conv = _get_owned_or_404(conversation_id, request)
    return {
        "conversation_id": conversation_id,
        "workspace_id": conv.workspace_id,
        "agent_session_id": conv.agent_session_id,
        "sandbox_session_id": conv.sandbox_session_id,
    }
