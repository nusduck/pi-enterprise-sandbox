"""Session Manager — CRUD for sandbox sessions."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sandbox.config import settings
from sandbox.database import Database, database as default_database
from sandbox.models import SessionResponse, SessionStatus
from sandbox.paths import (
    AGENT_WORKSPACE_PATH,
    conversation_workspace_id,
    is_logical_workspace_path,
)
from sandbox.repositories import SessionRepository
from sandbox.services.workspace_manager import WorkspaceWriteConflict, write_lease


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
        conversation_id: str | None = None,
        workspace_id: str | None = None,
        *,
        claim_write: bool = True,
    ) -> SessionResponse:
        """Create a sandbox session bound to a physical workspace.

        Workspace binding preference:
        1. Explicit ``workspace_id``
        2. ``conversation_id`` → ``conv_<id>`` (conversation-owned workspace)
        3. ``workspace_path_override`` when it is a physical path (not logical)
        4. Else session-private ``sandbox_<id>`` directory

        When the workspace is conversation-owned (or any shared workspace_id),
        a single-writer lease is claimed. Concurrent claims raise
        :class:`WorkspaceWriteConflict`.
        """
        session_id = f"sandbox_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        meta = dict(metadata or {})

        resolved_workspace_id, physical = self._resolve_workspace_binding(
            session_id=session_id,
            conversation_id=conversation_id,
            workspace_id=workspace_id,
            workspace_path_override=workspace_path_override,
        )
        meta["workspace_id"] = resolved_workspace_id
        meta["_physical_workspace"] = physical
        if conversation_id:
            meta["conversation_id"] = conversation_id

        if claim_write:
            self._claim_write_lease(resolved_workspace_id, session_id)

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

    def _resolve_workspace_binding(
        self,
        *,
        session_id: str,
        conversation_id: str | None,
        workspace_id: str | None,
        workspace_path_override: str | None,
    ) -> tuple[str, str]:
        """Return (workspace_id, physical_path)."""
        # 1. Explicit workspace_id
        if workspace_id:
            physical = str(settings.workspaces_path / workspace_id)
            return workspace_id, physical

        # 2. conversation_id → conv_<id> (1:1 conversation-owned workspace)
        if conversation_id:
            from sandbox.security.path_validation import validate_conversation_id

            safe = validate_conversation_id(conversation_id)
            wid = conversation_workspace_id(safe)
            return wid, str(settings.workspaces_path / wid)

        # 3. Physical path override (legacy rebind to existing workspace dir)
        if workspace_path_override and not is_logical_workspace_path(
            workspace_path_override
        ):
            physical = str(Path(workspace_path_override))
            # Derive workspace_id from last path component when under root
            try:
                root = settings.workspaces_path.resolve()
                p = Path(physical).resolve()
                if p.is_relative_to(root) and p != root:
                    return p.name, str(p)
            except (OSError, ValueError, AttributeError):
                pass
            # Fallback: use basename as workspace_id for lease keying
            return Path(physical).name or session_id, physical

        # 4. Session-private workspace
        return session_id, str(settings.workspaces_path / session_id)

    def _claim_write_lease(self, workspace_id: str, session_id: str) -> None:
        def _alive(holder_id: str) -> bool:
            holder = self.get(holder_id)
            if holder is None:
                return False
            status = holder.status
            value = status.value if hasattr(status, "value") else str(status)
            return value == SessionStatus.RUNNING.value

        write_lease.claim_with_liveness(
            workspace_id,
            session_id,
            is_holder_alive=_alive,
        )

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
        session = self.get(session_id)
        if session is not None:
            meta = session.metadata or {}
            wid = meta.get("workspace_id")
            if wid:
                write_lease.release(wid, session_id)
            else:
                write_lease.release(session_id, session_id)
        if self.repository:
            return self.repository.delete(session_id)
        return self._sessions.pop(session_id, None) is not None

    def update_status(self, session_id: str, status: SessionStatus) -> SessionResponse | None:
        # Release write lease when leaving RUNNING
        if status != SessionStatus.RUNNING:
            session = self.get(session_id)
            if session is not None:
                meta = session.metadata or {}
                wid = meta.get("workspace_id") or session_id
                write_lease.release(wid, session_id)
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
            # Release leases for sessions about to expire
            active = self.repository.list_active()
            now = datetime.now(timezone.utc)
            for s in active:
                # ttl is not on SessionResponse — re-check via cleanup
                pass
            count = self.repository.cleanup_expired(now.isoformat())
            # Best-effort: release leases for non-RUNNING holders
            # (holders validated on next claim via liveness)
            return count
        now = datetime.now(timezone.utc)
        count = 0
        for entry in list(self._sessions.values()):
            if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < now:
                entry["status"] = SessionStatus.EXPIRED
                entry["updated_at"] = now.isoformat()
                wid = (entry.get("metadata") or {}).get("workspace_id") or entry["session_id"]
                write_lease.release(wid, entry["session_id"])
                count += 1
        return count

    @staticmethod
    def _maybe_expire_entry(entry: dict) -> None:
        if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < datetime.now(timezone.utc):
            entry["status"] = SessionStatus.EXPIRED
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()
            wid = (entry.get("metadata") or {}).get("workspace_id") or entry["session_id"]
            write_lease.release(wid, entry["session_id"])


session_manager = SessionManager(database=default_database)

# Re-export for routers
__all__ = ["SessionManager", "session_manager", "WorkspaceWriteConflict"]
