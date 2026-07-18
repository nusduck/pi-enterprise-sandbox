"""Session Manager — CRUD for sandbox sessions.

Workspace ownership is 1:1 with AgentSession (plan §2.6 / PR-07A):

- Binding comes only from trusted preallocated ``agent_session_id`` +
  ``workspace_id`` (and optional ``sandbox_session_id``).
- Never derive workspace identity from ``conversation_id``.
- Same AgentSession multi-turn rebinds only to the same workspace.
- Different AgentSessions never share a workspace.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from sandbox.config import settings
from sandbox.database import Database, database as default_database
from sandbox.models import SessionResponse, SessionStatus
from sandbox.paths import (
    public_metadata,
    temp_id_for_workspace_id,
)
from sandbox.repositories import SessionRepository
from sandbox.security.path_validation import validate_formal_id


class WorkspaceBindingConflict(Exception):
    """AgentSession / workspace binding mismatch (no physical path leakage)."""

    def __init__(self, message: str = "Workspace binding conflict") -> None:
        self.message = message
        super().__init__(message)


class WorkspaceBindingRequired(Exception):
    """Raised when create cannot prove an AgentSession workspace binding."""

    def __init__(
        self,
        message: str = "agent_session_id and workspace_id are required",
    ) -> None:
        self.message = message
        super().__init__(message)


def public_session_response(session: SessionResponse) -> SessionResponse:
    """Return a copy safe for external JSON (no physical path leakage)."""
    meta = public_metadata(session.metadata)
    workspace_id = session.workspace_id or meta.get("workspace_id")
    if not workspace_id and isinstance(session.metadata, dict):
        workspace_id = session.metadata.get("workspace_id")
    return SessionResponse(
        session_id=session.session_id,
        agent_session_id=session.agent_session_id,
        enterprise_session_id=session.enterprise_session_id,
        user_id=session.user_id,
        caller_id=session.caller_id,
        status=session.status,
        workspace_id=workspace_id,
        created_at=session.created_at,
        updated_at=session.updated_at,
        metadata=meta,
    )


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
        conversation_id: str | None = None,
        workspace_id: str | None = None,
        sandbox_session_id: str | None = None,
        *,
        # Internal-only physical override for unit tests; never from public API.
        workspace_path_override: str | None = None,
    ) -> SessionResponse:
        """Create a sandbox session bound to a preallocated AgentSession workspace.

        Requires formal ``agent_session_id`` + ``workspace_id``. Optional
        ``sandbox_session_id`` is used as the session primary id when provided.
        ``conversation_id`` is recorded as metadata only and never owns the
        workspace. Fail closed when binding proof is missing.
        """
        if not agent_session_id or not workspace_id:
            raise WorkspaceBindingRequired(
                "agent_session_id and workspace_id are required"
            )

        try:
            agent_session_id = validate_formal_id(
                agent_session_id, "agent_session_id"
            )
            workspace_id = validate_formal_id(workspace_id, "workspace_id")
            if sandbox_session_id:
                sandbox_session_id = validate_formal_id(
                    sandbox_session_id, "sandbox_session_id"
                )
        except ValueError as exc:
            raise WorkspaceBindingRequired(str(exc)) from exc

        # Same AgentSession may only bind one workspace forever (1:1).
        prior = self.get_by_agent_session_id(agent_session_id)
        if prior is not None:
            prior_wid = prior.workspace_id or (prior.metadata or {}).get(
                "workspace_id"
            )
            if prior_wid and prior_wid != workspace_id:
                raise WorkspaceBindingConflict(
                    "Agent session is already bound to a different workspace"
                )
            # Multi-turn rebind: always renew RUNNING + TTL (even if already RUNNING).
            if prior_wid == workspace_id or not prior_wid:
                reactivated = self.reactivate_for_rebind(prior.session_id)
                return reactivated or prior

        # Different AgentSessions never share a workspace.
        holder = self._find_by_workspace_id(workspace_id)
        if holder is not None and holder.agent_session_id != agent_session_id:
            raise WorkspaceBindingConflict(
                "Workspace is already bound to a different agent session"
            )

        session_id = sandbox_session_id or f"sandbox_{uuid.uuid4().hex[:12]}"
        if sandbox_session_id:
            existing = self.get(session_id)
            if existing is not None:
                if (
                    existing.agent_session_id == agent_session_id
                    and existing.workspace_id == workspace_id
                ):
                    reactivated = self.reactivate_for_rebind(existing.session_id)
                    return reactivated or existing
                raise WorkspaceBindingConflict(
                    "sandbox_session_id is already bound"
                )

        now = datetime.now(timezone.utc).isoformat()
        meta = dict(metadata or {})

        physical = self._physical_for_workspace(
            workspace_id, workspace_path_override
        )
        meta["workspace_id"] = workspace_id
        # Internal recovery key — stripped by public_session_response.
        meta["_physical_workspace"] = physical
        temp_id = temp_id_for_workspace_id(workspace_id)
        meta["_temp_id"] = temp_id
        meta["_physical_temp"] = str(settings.temp_path / temp_id)
        if conversation_id:
            # Metadata only — never workspace ownership authority.
            meta["conversation_id"] = conversation_id

        entry = {
            "session_id": session_id,
            "agent_session_id": agent_session_id,
            "enterprise_session_id": enterprise_session_id,
            "user_id": user_id,
            "caller_id": caller_id,
            "status": SessionStatus.RUNNING,
            "workspace_id": workspace_id,
            # DB column name is historical; value is opaque workspace_id.
            "workspace_path": workspace_id,
            "created_at": now,
            "updated_at": now,
            "metadata": meta,
            "ttl_until": datetime.now(timezone.utc)
            + timedelta(minutes=settings.session_ttl_minutes),
        }
        if self.repository:
            self.repository.upsert(entry)
        else:
            self._sessions[session_id] = entry
        return SessionResponse(
            session_id=session_id,
            agent_session_id=agent_session_id,
            enterprise_session_id=enterprise_session_id,
            user_id=user_id,
            caller_id=caller_id,
            status=SessionStatus.RUNNING,
            workspace_id=workspace_id,
            created_at=now,
            updated_at=now,
            metadata=meta,
        )

    def _physical_for_workspace(
        self,
        workspace_id: str,
        workspace_path_override: str | None,
    ) -> str:
        if workspace_path_override:
            if str(workspace_path_override).startswith("/home/sandbox/workspace"):
                return str(settings.workspaces_path / workspace_id)
            physical = str(Path(workspace_path_override))
            try:
                root = settings.workspaces_path.resolve()
                p = Path(physical).resolve()
                if p.is_relative_to(root) and p != root:
                    return str(p)
            except (OSError, ValueError, AttributeError):
                pass
            return physical
        return str(settings.workspaces_path / workspace_id)

    def _find_by_workspace_id(self, workspace_id: str) -> SessionResponse | None:
        """Return any known session bound to *workspace_id* (any status).

        Must include COMPLETED/EXPIRED rows so a failed cleanup that retains
        the binding still blocks reassignment of residual workspace data.
        """
        if self.repository:
            find = getattr(self.repository, "get_by_workspace_id", None)
            if callable(find):
                return find(workspace_id)
            list_all = getattr(self.repository, "list_all", None)
            if callable(list_all):
                for session in list_all():
                    wid = session.workspace_id or (session.metadata or {}).get(
                        "workspace_id"
                    )
                    if wid == workspace_id:
                        return session
            # Fall back: active list only (may miss retained COMPLETED bindings).
            for session in self.repository.list_active():
                wid = session.workspace_id or (session.metadata or {}).get(
                    "workspace_id"
                )
                if wid == workspace_id:
                    return session
            return None
        for entry in self._sessions.values():
            wid = entry.get("workspace_id") or (entry.get("metadata") or {}).get(
                "workspace_id"
            )
            if wid == workspace_id:
                return self._entry_to_response(entry)
        return None

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
        return self._entry_to_response(entry)

    def get_by_agent_session_id(self, agent_session_id: str) -> SessionResponse | None:
        if self.repository:
            return self.repository.get_by_agent_session_id(agent_session_id)
        for entry in self._sessions.values():
            if entry.get("agent_session_id") == agent_session_id:
                return self._entry_to_response(entry)
        return None

    def get_by_enterprise_session_id(self, enterprise_session_id: str) -> SessionResponse | None:
        if self.repository:
            return self.repository.get_by_enterprise_session_id(enterprise_session_id)
        for entry in self._sessions.values():
            if entry.get("enterprise_session_id") == enterprise_session_id:
                return self._entry_to_response(entry)
        return None

    def delete(self, session_id: str) -> bool:
        if self.repository:
            return self.repository.delete(session_id)
        return self._sessions.pop(session_id, None) is not None

    def update_status(self, session_id: str, status: SessionStatus) -> SessionResponse | None:
        """Set status only — does **not** renew TTL (use reactivate_for_rebind)."""
        if self.repository:
            return self.repository.update_status(session_id, status)
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        entry["status"] = status
        entry["updated_at"] = datetime.now(timezone.utc).isoformat()
        return self._entry_to_response(entry)

    def reactivate_for_rebind(self, session_id: str) -> SessionResponse | None:
        """Idempotent multi-turn rebind for the same AgentSession + workspace.

        Atomically sets status=RUNNING, updated_at=now, and
        ttl_until=now+session_ttl_minutes. Used for RUNNING (TTL refresh),
        COMPLETED, and EXPIRED rebinds. Ordinary :meth:`update_status` must
        not renew TTL.
        """
        now = datetime.now(timezone.utc)
        ttl_until = now + timedelta(minutes=settings.session_ttl_minutes)
        if self.repository:
            return self.repository.reactivate_for_rebind(
                session_id,
                now_iso=now.isoformat(),
                ttl_until_iso=ttl_until.isoformat(),
            )
        entry = self._sessions.get(session_id)
        if entry is None:
            return None
        entry["status"] = SessionStatus.RUNNING
        entry["updated_at"] = now.isoformat()
        entry["ttl_until"] = ttl_until
        return self._entry_to_response(entry)

    def list_active(self) -> list[SessionResponse]:
        if self.repository:
            self.cleanup_expired()
            return self.repository.list_active()
        results = []
        for entry in list(self._sessions.values()):
            self._maybe_expire_entry(entry)
            if entry["status"] == SessionStatus.RUNNING:
                results.append(self._entry_to_response(entry))
        return results

    def count_active(self) -> int:
        return len(self.list_active())

    def cleanup_expired(self) -> int:
        if self.repository:
            now = datetime.now(timezone.utc)
            count = self.repository.cleanup_expired(now.isoformat())
            return count
        now = datetime.now(timezone.utc)
        count = 0
        for entry in list(self._sessions.values()):
            if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < now:
                entry["status"] = SessionStatus.EXPIRED
                entry["updated_at"] = now.isoformat()
                count += 1
        return count

    @staticmethod
    def _entry_to_response(entry: dict) -> SessionResponse:
        meta = entry.get("metadata") or {}
        return SessionResponse(
            session_id=entry["session_id"],
            agent_session_id=entry.get("agent_session_id"),
            enterprise_session_id=entry.get("enterprise_session_id"),
            user_id=entry.get("user_id"),
            caller_id=entry.get("caller_id", "unknown"),
            status=entry["status"],
            workspace_id=entry.get("workspace_id") or meta.get("workspace_id"),
            created_at=entry.get("created_at", ""),
            updated_at=entry.get("updated_at", ""),
            metadata=meta,
        )

    @staticmethod
    def _maybe_expire_entry(entry: dict) -> None:
        if entry["status"] == SessionStatus.RUNNING and entry["ttl_until"] < datetime.now(timezone.utc):
            entry["status"] = SessionStatus.EXPIRED
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()


session_manager = SessionManager(database=default_database)

# Re-export for routers
__all__ = [
    "SessionManager",
    "session_manager",
    "WorkspaceBindingConflict",
    "WorkspaceBindingRequired",
    "public_session_response",
]
