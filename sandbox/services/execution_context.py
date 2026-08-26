"""Server-resolved filesystem context for sandbox tool execution.

Callers provide only a session id. Physical workspace/temp paths are derived
from the trusted session binding and are never accepted from API or model
arguments.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sandbox.config import settings

from sandbox.paths import (
    AGENT_TEMP_PATH,
    LEGACY_AGENT_WORKSPACE_PATH,
    ensure_physical_temp,
    ensure_physical_workspace,
    get_session_temp_id,
    get_session_workspace_id,
)


# Identity segments become path components, so they must not traverse.
_IDENTITY_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")


def user_skill_dir_for(org_id: str | None, user_id: str | None) -> Path | None:
    """Physical skill directory owned by ``org_id``/``user_id``, or None.

    The single definition of the user-tier tenant boundary: every surface that
    reaches into the user skill tree — an execution's bwrap binds, an internal
    read, a search — must locate the directory through this function so the
    three cannot drift apart. Returns None when identity is missing or is not a
    safe path segment; callers then see the system tier only, never a shared
    view of every tenant's packages.
    """
    if not org_id or not user_id:
        return None
    if not _IDENTITY_SEGMENT.fullmatch(org_id):
        return None
    if not _IDENTITY_SEGMENT.fullmatch(user_id):
        return None
    return Path(settings.user_skills_root) / org_id / user_id


def _owner_field(session: Any, key: str) -> str | None:
    """Read an owner id from a session record or dict, normalizing empties."""
    value = getattr(session, key, None)
    if value is None and isinstance(session, dict):
        value = session.get(key)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


@dataclass(frozen=True)
class SandboxExecutionContext:
    session_id: str
    workspace_id: str
    temp_id: str
    physical_workspace: Path
    physical_temp: Path
    logical_workspace: str = LEGACY_AGENT_WORKSPACE_PATH
    logical_temp: str = AGENT_TEMP_PATH
    # Authoritative end-user id from the trusted session binding
    # (``SessionResponse.user_id``). Never taken from process API bodies.
    # Optional so legacy/unit tests may omit it (workspace fallback for quotas).
    user_id: str | None = None
    # Authoritative owning org, same trust path as ``user_id``. Together they
    # locate the caller's own skill directory, which is the only part of the
    # user skill tier an execution may see.
    org_id: str | None = None

    @property
    def user_skill_dir(self) -> Path | None:
        """Physical directory holding this caller's installed skills.

        None when identity is unknown; the caller then gets the system skill
        tier only rather than a shared view of every tenant's packages.
        """
        return user_skill_dir_for(self.org_id, self.user_id)

    @classmethod
    def from_session(cls, session: Any) -> "SandboxExecutionContext":
        session_id = getattr(session, "session_id", None)
        if session_id is None and isinstance(session, dict):
            session_id = session.get("session_id")
        workspace_id = get_session_workspace_id(session)
        if not session_id or not workspace_id:
            raise ValueError("Session is missing filesystem identity")
        user_id = _owner_field(session, "user_id")
        # Formal public sessions expose organization_id; some records use org_id.
        org_id = _owner_field(session, "org_id") or _owner_field(
            session, "organization_id"
        )
        if org_id is None and isinstance(getattr(session, "metadata", None), dict):
            meta = session.metadata
            org_id = _owner_field(meta, "org_id") or _owner_field(
                meta, "organization_id"
            )
        elif org_id is None and isinstance(session, dict):
            meta = session.get("metadata")
            if isinstance(meta, dict):
                org_id = _owner_field(meta, "org_id") or _owner_field(
                    meta, "organization_id"
                )
        return cls(
            session_id=str(session_id),
            workspace_id=str(workspace_id),
            temp_id=get_session_temp_id(session),
            physical_workspace=ensure_physical_workspace(session).resolve(),
            physical_temp=ensure_physical_temp(session).resolve(),
            user_id=user_id,
            org_id=org_id,
        )
