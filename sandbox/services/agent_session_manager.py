"""Logical Pi SDK Agent Session manager (ADR 0002 §7).

Owns create / resume / append-entry flows. Materializes temporary JSONL for
``SessionManager.open`` on the Node Agent side.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sandbox.models import (
    AgentSessionEntryResponse,
    AgentSessionResponse,
    AgentSessionResumeResponse,
    AgentSessionStatus,
)
from sandbox.repositories import AgentSessionRepository, ConversationRepository


class AgentSessionManager:
    def __init__(
        self,
        sessions: AgentSessionRepository | None = None,
        conversations: ConversationRepository | None = None,
    ) -> None:
        self.sessions = sessions or AgentSessionRepository()
        self.conversations = conversations or ConversationRepository()

    def create_session(
        self,
        *,
        conversation_id: str,
        sdk_session_id: str | None = None,
        workspace_id: str | None = None,
        sandbox_session_id: str | None = None,
        model_id: str | None = None,
        thinking_level: str | None = None,
        system_prompt_version: str | None = None,
        tool_registry_version: str | None = None,
        sdk_version: str | None = None,
        session_schema_version: int = 3,
        header_payload: dict[str, Any] | None = None,
        session_id: str | None = None,
        bind_conversation: bool = True,
    ) -> AgentSessionResponse:
        """Create a logical agent session and optionally bind the conversation."""
        now = datetime.now(timezone.utc).isoformat()
        sid = session_id or f"asess_{uuid.uuid4().hex}"
        header = dict(header_payload or {})
        if not header:
            header = {
                "type": "session",
                "version": session_schema_version,
                "id": sdk_session_id or sid,
                "timestamp": now,
                "cwd": "/tmp",
            }
        session = self.sessions.create(
            {
                "id": sid,
                "conversation_id": conversation_id,
                "sdk_session_id": sdk_session_id or header.get("id") or sid,
                "workspace_id": workspace_id,
                "sandbox_session_id": sandbox_session_id,
                "status": AgentSessionStatus.ACTIVE.value,
                "model_id": model_id,
                "thinking_level": thinking_level,
                "system_prompt_version": system_prompt_version,
                "tool_registry_version": tool_registry_version,
                "sdk_version": sdk_version,
                "session_schema_version": session_schema_version,
                "header_payload": header,
                "created_at": now,
                "updated_at": now,
            }
        )
        if bind_conversation:
            self.conversations.set_agent_session_id(conversation_id, session.id)
        return session

    def get(self, agent_session_id: str) -> AgentSessionResponse | None:
        return self.sessions.get(agent_session_id)

    def get_for_conversation(
        self, conversation_id: str
    ) -> AgentSessionResponse | None:
        conv = self.conversations.get(conversation_id)
        if conv and conv.agent_session_id:
            session = self.sessions.get(conv.agent_session_id)
            if session is not None:
                return session
        return self.sessions.get_by_conversation(conversation_id)

    def list_entries(
        self,
        agent_session_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[AgentSessionEntryResponse]:
        return self.sessions.list_entries(
            agent_session_id, after_sequence=after_sequence, limit=limit
        )

    def append_entries(
        self,
        agent_session_id: str,
        entries: list[dict[str, Any]],
        *,
        header_payload: dict[str, Any] | None = None,
        sdk_session_id: str | None = None,
        model_id: str | None = None,
        thinking_level: str | None = None,
        last_compacted_at: str | None = None,
        status: str | None = None,
    ) -> list[AgentSessionEntryResponse]:
        """Live-persist new SDK entries and optionally refresh session meta."""
        created = self.sessions.append_entries(agent_session_id, entries)
        if any(
            v is not None
            for v in (
                header_payload,
                sdk_session_id,
                model_id,
                thinking_level,
                last_compacted_at,
                status,
            )
        ):
            self.sessions.update_meta(
                agent_session_id,
                header_payload=header_payload,
                sdk_session_id=sdk_session_id,
                model_id=model_id,
                thinking_level=thinking_level,
                last_compacted_at=last_compacted_at,
                status=status,
            )
        # Mark compacted when a compaction entry arrives
        if last_compacted_at is None:
            for item in entries:
                if item.get("entry_type") == "compaction":
                    self.sessions.update_meta(
                        agent_session_id,
                        last_compacted_at=datetime.now(timezone.utc).isoformat(),
                        status=AgentSessionStatus.COMPACTED.value,
                    )
                    break
        return created

    def resume(self, agent_session_id: str) -> AgentSessionResumeResponse | None:
        """Load session + entries and materialize JSONL for SessionManager.open."""
        session = self.sessions.get(agent_session_id)
        if session is None:
            return None
        entries = self.sessions.list_entries(agent_session_id)
        try:
            jsonl = self.sessions.build_jsonl(agent_session_id)
        except KeyError:
            return None
        # Refresh entry_count on session model
        session = session.model_copy(update={"entry_count": len(entries)})
        return AgentSessionResumeResponse(
            session=session,
            entries=entries,
            jsonl=jsonl,
        )


agent_session_manager = AgentSessionManager()
