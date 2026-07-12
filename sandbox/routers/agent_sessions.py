"""Agent session persistence API (ADR 0002 §7 / §10).

GET  /agent-sessions/{session_id}
POST /agent-sessions/{session_id}/resume
GET  /agent-sessions/{session_id}/entries
POST /agent-sessions
POST /agent-sessions/{session_id}/entries
GET  /conversations/{conversation_id}/agent-session
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from sandbox.models import (
    AgentSessionCreate,
    AgentSessionEntriesAppend,
    AgentSessionEntryResponse,
    AgentSessionResponse,
    AgentSessionResumeResponse,
)
from sandbox.services.agent_session_manager import agent_session_manager

router = APIRouter(tags=["agent-sessions"])


@router.post("/agent-sessions", response_model=AgentSessionResponse, status_code=201)
def create_agent_session(body: AgentSessionCreate):
    """Create a logical Pi SDK session and bind it to the conversation."""
    return agent_session_manager.create_session(
        conversation_id=body.conversation_id,
        sdk_session_id=body.sdk_session_id,
        workspace_id=body.workspace_id,
        sandbox_session_id=body.sandbox_session_id,
        model_id=body.model_id,
        thinking_level=body.thinking_level,
        system_prompt_version=body.system_prompt_version,
        tool_registry_version=body.tool_registry_version,
        sdk_version=body.sdk_version,
        session_schema_version=body.session_schema_version,
        header_payload=body.header_payload,
        session_id=body.id,
        bind_conversation=True,
    )


@router.get("/agent-sessions/{session_id}", response_model=AgentSessionResponse)
def get_agent_session(session_id: str):
    session = agent_session_manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return session


@router.post(
    "/agent-sessions/{session_id}/resume",
    response_model=AgentSessionResumeResponse,
)
def resume_agent_session(session_id: str):
    """Return session + entries + materialised JSONL for SessionManager.open.

    On missing / unreadable session data the caller must fail closed
    (session_restore_failed) rather than inventing an empty session.
    """
    result = agent_session_manager.resume(session_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return result


@router.get(
    "/agent-sessions/{session_id}/entries",
    response_model=list[AgentSessionEntryResponse],
)
def list_agent_session_entries(
    session_id: str,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=10000),
):
    session = agent_session_manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    return agent_session_manager.list_entries(
        session_id, after_sequence=after_sequence, limit=limit
    )


@router.post(
    "/agent-sessions/{session_id}/entries",
    response_model=list[AgentSessionEntryResponse],
    status_code=201,
)
def append_agent_session_entries(session_id: str, body: AgentSessionEntriesAppend):
    """Live-persist new SDK entries during/after a run."""
    session = agent_session_manager.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Agent session not found")
    entries = [
        {
            "id": e.id,
            "entry_type": e.entry_type,
            "entry_payload": e.entry_payload,
            "parent_entry_id": e.parent_entry_id,
            "branch_id": e.branch_id,
            "sequence": e.sequence,
        }
        for e in body.entries
    ]
    return agent_session_manager.append_entries(
        session_id,
        entries,
        header_payload=body.header_payload,
        sdk_session_id=body.sdk_session_id,
        model_id=body.model_id,
        thinking_level=body.thinking_level,
        last_compacted_at=body.last_compacted_at,
        status=body.status,
    )


@router.get(
    "/conversations/{conversation_id}/agent-session",
    response_model=AgentSessionResponse,
)
def get_conversation_agent_session(conversation_id: str):
    session = agent_session_manager.get_for_conversation(conversation_id)
    if not session:
        raise HTTPException(
            status_code=404, detail="Agent session not found for conversation"
        )
    return session
