"""Conversation API router — persists conversations via the sandbox DB.

Enables the webui conversation-manager to read/write conversations directly
through the sandbox REST API instead of using a local JSON file.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sandbox.models import ConversationCreate, ConversationResponse
from sandbox.repositories import ConversationRepository
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/conversations", tags=["conversations"])
repo = ConversationRepository()


@router.get("", response_model=list[ConversationResponse])
def list_conversations():
    """Return all conversations, newest first."""
    return repo.list_all()


@router.post("", response_model=ConversationResponse, status_code=201)
def create_conversation(body: ConversationCreate):
    """Create a new conversation (or upsert if id is provided).

    Initializes a persistent workspace directory tied to the conversation.
    """
    import uuid
    conv_id = body.id or str(uuid.uuid4())
    # Initialize persistent workspace for this conversation
    ws_path = str(workspace_manager.init_conversation_workspace(conv_id))
    entry = {
        "id": conv_id,
        "title": body.title,
        "sandbox_session_id": body.sandbox_session_id,
        "workspace_path": ws_path,
        "messages": [m for m in body.messages],
    }
    return repo.upsert(entry)


@router.get("/{conversation_id}", response_model=ConversationResponse)
def get_conversation(conversation_id: str):
    conv = repo.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.patch("/{conversation_id}", response_model=ConversationResponse)
def update_conversation(conversation_id: str, body: ConversationCreate):
    existing = repo.get(conversation_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Conversation not found")
    entry = {
        "id": conversation_id,
        "title": body.title or existing.title,
        "sandbox_session_id": body.sandbox_session_id or existing.sandbox_session_id,
        "workspace_path": body.workspace_path or existing.workspace_path,
        "messages": [m for m in (body.messages or existing.messages)],
        "created_at": existing.created_at,
    }
    return repo.upsert(entry)


@router.delete("/{conversation_id}", status_code=204)
def delete_conversation(conversation_id: str):
    conv = repo.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    repo.delete(conversation_id)
    workspace_manager.remove_conversation_workspace(conversation_id)


@router.get("/{conversation_id}/messages", response_model=list[dict])
def get_conversation_messages(conversation_id: str):
    conv = repo.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv.messages


@router.patch("/{conversation_id}/title", response_model=ConversationResponse)
def update_conversation_title(conversation_id: str, body: dict):
    title = body.get("title")
    if not title:
        raise HTTPException(status_code=400, detail="title is required")
    updated = repo.update_title(conversation_id, title)
    if not updated:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return updated


@router.get("/{conversation_id}/workspace", response_model=dict)
def get_conversation_workspace(conversation_id: str):
    """Return the persistent workspace path for a conversation."""
    conv = repo.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {"conversation_id": conversation_id, "workspace_path": conv.workspace_path}
