"""Session Manager — CRUD for sandbox sessions."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from sandbox.config import settings
from sandbox.models import SessionResponse, SessionStatus


class SessionManager:
    """In-memory session registry (v1; swap to SQLite/PostgreSQL in v2).

    Thread-safety note: called from async endpoints in the same event loop.
    For v1 the GIL + single-threaded FastAPI prevents races; if async executors
    are used, wrap writes with an ``asyncio.Lock``.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, dict] = {}

    # ── CRUD ──────────────────────────────────────────────────────────

    def create(
        self,
        agent_session_id: str | None = None,
        user_id: str | None = None,
        caller_id: str = "unknown",
        metadata: dict | None = None,
    ) -> SessionResponse:
        session_id = f"sandbox_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        ws_path = str(settings.workspaces_path / session_id)

        entry = {
            "session_id": session_id,
            "agent_session_id": agent_session_id,
            "user_id": user_id,
            "caller_id": caller_id,
            "status": SessionStatus.RUNNING,
            "workspace_path": ws_path,
            "created_at": now,
            "updated_at": now,
            "metadata": metadata or {},
            "ttl_until": datetime.now(timezone.utc)
            + timedelta(minutes=settings.session_ttl_minutes),
        }
        self._sessions[session_id] = entry
        return SessionResponse(**entry)

    def get(self, session_id: str) -> SessionResponse | None:
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        self._maybe_expire(entry)
        return SessionResponse(**entry)

    def delete(self, session_id: str) -> bool:
        entry = self._sessions.pop(session_id, None)
        return entry is not None

    def update_status(
        self, session_id: str, status: SessionStatus
    ) -> SessionResponse | None:
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        entry["status"] = status
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        return SessionResponse(**entry)

    def list_active(self) -> list[SessionResponse]:
        results = []
        for entry in list(self._sessions.values()):
            self._maybe_expire(entry)
            if entry["status"] == SessionStatus.RUNNING:
                results.append(SessionResponse(**entry))
        return results

    def count_active(self) -> int:
        return len(self.list_active())

    # ── TTL / Cleanup ────────────────────────────────────────────────

    def cleanup_expired(self) -> int:
        """Mark expired sessions as EXPIRED and return count cleaned."""
        now = datetime.now(timezone.utc)
        count = 0
        for entry in list(self._sessions.values()):
            if (
                entry["status"] == SessionStatus.RUNNING
                and entry["ttl_until"] < now
            ):
                entry["status"] = SessionStatus.EXPIRED
                entry["updated_at"] = now.isoformat()
                count += 1
        return count

    def _maybe_expire(self, entry: dict) -> None:
        if (
            entry["status"] == SessionStatus.RUNNING
            and entry["ttl_until"] < datetime.now(timezone.utc)
        ):
            entry["status"] = SessionStatus.EXPIRED
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()


# Module-level singleton
session_manager = SessionManager()
