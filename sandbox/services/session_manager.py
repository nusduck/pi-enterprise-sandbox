"""Session Manager — CRUD for sandbox sessions."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sandbox.config import settings
from sandbox.database import Database, database as default_database
from sandbox.models import SessionResponse, SessionStatus
from sandbox.paths import AGENT_WORKSPACE_PATH
from sandbox.repositories import SessionRepository


class SessionManager:
    """Session registry.

    Uses in-memory storage by default for isolated unit tests and lightweight
    callers. The module-level singleton is wired to SQLite for service runtime.
    """

    def __init__(self, database: Database | None = None) -> None:
        self.repository = SessionRepository(database) if database is not None else None
        self._sessions: dict[str, dict] = {}

    def create(
        self,
        agent_session_id: str | None = None,
        enterprise_session_id: str | None = None,
        user_id: str | None = None,
        caller_id: str = "unknown",
        metadata: dict | None = None,
        workspace_path_override: str | None = None,
    ) -> SessionResponse:
        session_id = f"sandbox_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        # Expose stable agent-visible path; store physical root in metadata.
        # All exec/file/artifact ops use _physical_workspace, never a global link.
        meta = dict(metadata or {})
        if workspace_path_override:
            meta["_physical_workspace"] = workspace_path_override
        else:
            meta["_physical_workspace"] = str(settings.workspaces_path / session_id)
        entry = {
            "session_id": session_id,
            "agent_session_id": agent_session_id,
            "enterprise_session_id": enterprise_session_id,
            "user_id": user_id,
            "caller_id": caller_id,
            "status": SessionStatus.RUNNING,
            "workspace_path": AGENT_WORKSPACE_PATH,
            "created_at": now,
            "updated_at": now,
            "metadata": meta,
            "ttl_until": datetime.now(timezone.utc) + timedelta(minutes=settings.session_ttl_minutes),
        }
        if self.repository:
            self.repository.upsert(entry)
        else:
            self._sessions[session_id] = entry
        return SessionResponse(**entry)

    def get(self, session_id: str) -> SessionResponse | None:
        if self.repository:
            session = self.repository.get(session_id)
            if session:
                self.cleanup_expired()
                return self.repository.get(session_id)
            return None
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        self._maybe_expire_entry(entry)
        return SessionResponse(**entry)

    def get_by_agent_session_id(self, agent_session_id: str) -> SessionResponse | None:
        if self.repository:
            return self.repository.get_by_agent_session_id(agent_session_id)
        for entry in self._sessions.values():
            if entry.get("agent_session_id") == agent_session_id:
                return SessionResponse(**entry)
        return None

    def get_by_enterprise_session_id(self, enterprise_session_id: str) -> SessionResponse | None:
        if self.repository:
            return self.repository.get_by_enterprise_session_id(enterprise_session_id)
        for entry in self._sessions.values():
            if entry.get("enterprise_session_id") == enterprise_session_id:
                return SessionResponse(**entry)
        return None

    def delete(self, session_id: str) -> bool:
        if self.repository:
            return self.repository.delete(session_id)
        return self._sessions.pop(session_id, None) is not None

    def update_status(self, session_id: str, status: SessionStatus) -> SessionResponse | None:
        if self.repository:
            return self.repository.update_status(session_id, status)
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        entry["status"] = status
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        return SessionResponse(**entry)

    def list_active(self) -> list[SessionResponse]:
        if self.repository:
            self.cleanup_expired()
            return self.repository.list_active()
        results = []
        for entry in list(self._sessions.values()):
            self._maybe_expire_entry(entry)
            if entry["status"] == SessionStatus.RUNNING:
                results.append(SessionResponse(**entry))
        return results

    def count_active(self) -> int:
        return len(self.list_active())

    def cleanup_expired(self) -> int:
        if self.repository:
            return self.repository.cleanup_expired(datetime.now(timezone.utc).isoformat())
        now = datetime.now(timezone.utc)
        count = 0
        for entry in list(self._sessions.values()):
            if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < now:
                entry["status"] = SessionStatus.EXPIRED
                entry["updated_at"] = now.isoformat()
                count += 1
        return count

    @staticmethod
    def _maybe_expire_entry(entry: dict) -> None:
        if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < datetime.now(timezone.utc):
            entry["status"] = SessionStatus.EXPIRED
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()


session_manager = SessionManager(database=default_database)
