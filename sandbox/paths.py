"""Logical sandbox path contract and physical-root helpers.

Public contract (API / SSE / model context / tools / logs):

- Relative paths address the session workspace (e.g. ``notes/a.txt``).
- ``/home/sandbox/workspace/...`` is the accepted logical workspace form.
- ``/tmp/...`` addresses the conversation-owned persistent temp tree.
- Workspaces are identified only by opaque ``workspace_id``.
- Physical host paths must never appear on public surfaces; redact them to
  ``<workspace>``.

Internal only (service / repository):

- Physical roots live under ``settings.workspaces_path / {workspace_id}``.
- Resolve via :func:`get_session_physical_workspace` / metadata / WorkspaceRef.
- ``_physical_workspace`` may exist in stored session metadata for recovery but
  must be stripped before any external JSON response.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from pathlib import PurePosixPath
from typing import Any

# ── Public redaction tokens ─────────────────────────────────────────────

# Opaque stand-in for any physical workspace root in errors, logs, and docs.
PUBLIC_WORKSPACE_TOKEN = "<workspace>"

# Agent-visible skill tree (shared, not session workspace). Skill tools may
# still use this absolute root; session file tools do not.
AGENT_SKILL_PATH = "/home/sandbox/skill"

# Stable Agent-visible logical workspace path. The historical constant name is
# retained because several integrations already import it.
LEGACY_AGENT_WORKSPACE_PATH = "/home/sandbox/workspace"
AGENT_WORKSPACE_PATH = LEGACY_AGENT_WORKSPACE_PATH  # internal alias

# Agent-visible persistent temp root. Its physical backing is resolved from
# the current workspace identity and never appears on public surfaces.
AGENT_TEMP_PATH = "/tmp"

# Backward-compat alias used only for optional single-session presentation.
LEGACY_WORKSPACE_LINK = "/sandbox/workspace"

# Common physical-root prefixes that must never appear in public text.
_DEFAULT_PHYSICAL_PREFIXES = (
    "/var/sandbox/workspaces",
    "/sandbox/workspaces",
)

# Internal metadata keys stripped from public session/conversation JSON.
_INTERNAL_METADATA_PREFIX = "_"


def conversation_workspace_id(conversation_id: str) -> str:
    """Stable workspace_id for a conversation (1:1 ownership)."""
    return f"conv_{conversation_id}"


def temp_id_for_workspace_id(workspace_id: str) -> str:
    """Stable persistent-temp identity paired with an opaque workspace id."""
    if not workspace_id or "/" in workspace_id or "\\" in workspace_id:
        raise ValueError("Invalid workspace id for temp storage")
    return f"tmp_{workspace_id}"


class SandboxPathScope(str, Enum):
    WORKSPACE = "workspace"
    TEMP = "temp"


@dataclass(frozen=True)
class SandboxPath:
    """Validated logical path in the workspace or persistent temp tree."""

    scope: SandboxPathScope
    relative: PurePosixPath

    def as_public(self) -> str:
        """Canonical public form preserving legacy relative workspace paths."""
        relative = self.relative.as_posix()
        if self.scope == SandboxPathScope.WORKSPACE:
            return "." if relative == "." else relative
        return AGENT_TEMP_PATH if relative == "." else f"{AGENT_TEMP_PATH}/{relative}"

    def as_logical(self) -> str:
        root = (
            LEGACY_AGENT_WORKSPACE_PATH
            if self.scope == SandboxPathScope.WORKSPACE
            else AGENT_TEMP_PATH
        )
        relative = self.relative.as_posix()
        return root if relative == "." else f"{root}/{relative}"


def is_legacy_logical_workspace_path(path: str | None) -> bool:
    """Return True if *path* uses the accepted logical workspace root."""
    if not path:
        return False
    p = path.rstrip("/")
    return p == LEGACY_AGENT_WORKSPACE_PATH or p.startswith(
        LEGACY_AGENT_WORKSPACE_PATH + "/"
    )


# Backward-compat name used by older call sites during the cutover.
is_logical_workspace_path = is_legacy_logical_workspace_path


def is_logical_skill_path(path: str | None) -> bool:
    if not path:
        return False
    p = path.rstrip("/")
    return p == AGENT_SKILL_PATH or p.startswith(AGENT_SKILL_PATH + "/")


def public_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    """Return metadata safe for external JSON (strip internal ``_`` keys)."""
    if not metadata or not isinstance(metadata, dict):
        return {}
    return {
        k: v
        for k, v in metadata.items()
        if not str(k).startswith(_INTERNAL_METADATA_PREFIX)
    }


def get_session_workspace_id(session: Any) -> str | None:
    """Opaque workspace_id for a session object or dict-like entry."""
    metadata = getattr(session, "metadata", None)
    if metadata is None and isinstance(session, dict):
        metadata = session.get("metadata")
    if isinstance(metadata, dict):
        wid = metadata.get("workspace_id")
        if wid:
            return str(wid)
    # Fallback: session_id as private workspace key
    session_id = getattr(session, "session_id", None)
    if session_id is None and isinstance(session, dict):
        session_id = session.get("session_id")
    return str(session_id) if session_id else None


def to_public_workspace_path(path: str | None) -> str:
    """Deprecated: public surfaces no longer expose a workspace path.

    Returns the redaction token. Prefer :func:`get_session_workspace_id` /
    ``workspace_id`` fields on API models.
    """
    _ = path
    return PUBLIC_WORKSPACE_TOKEN


def get_session_physical_workspace(session: Any) -> str:
    """Return the physical on-disk workspace root for a session (internal).

    Preference order:
    1. ``session.metadata["_physical_workspace"]`` (set at create time)
    2. ``settings.workspaces_path / metadata["workspace_id"]``
    3. ``settings.workspaces_path / session.session_id``
    """
    from sandbox.config import settings

    metadata = getattr(session, "metadata", None) or {}
    if isinstance(metadata, dict):
        physical = metadata.get("_physical_workspace")
        if physical:
            return str(physical)
        workspace_id = metadata.get("workspace_id")
        if workspace_id:
            return str(settings.workspaces_path / workspace_id)

    session_id = getattr(session, "session_id", None)
    if session_id:
        return str(settings.workspaces_path / session_id)

    # Last resort — should not be hit for real sessions
    return str(settings.workspaces_path)


def get_session_temp_id(session: Any) -> str:
    """Return stable temp id derived from the session workspace identity."""
    metadata = getattr(session, "metadata", None)
    if metadata is None and isinstance(session, dict):
        metadata = session.get("metadata")
    if isinstance(metadata, dict):
        temp_id = metadata.get("_temp_id")
        if temp_id:
            return str(temp_id)
    workspace_id = get_session_workspace_id(session)
    if not workspace_id:
        raise ValueError("Session has no workspace identity")
    return temp_id_for_workspace_id(workspace_id)


def get_session_physical_temp(session: Any) -> str:
    """Return the internal physical persistent-temp root for a session."""
    from sandbox.config import settings

    metadata = getattr(session, "metadata", None)
    if metadata is None and isinstance(session, dict):
        metadata = session.get("metadata")
    if isinstance(metadata, dict):
        physical = metadata.get("_physical_temp")
        if physical:
            return str(physical)
    return str(settings.temp_path / get_session_temp_id(session))


def ensure_physical_workspace(session: Any) -> Path:
    """Resolve physical workspace and create the directory if missing."""
    path = Path(get_session_physical_workspace(session))
    path.mkdir(parents=True, exist_ok=True)
    return path


def ensure_physical_temp(session: Any) -> Path:
    """Resolve and create the persistent temp tree for a session."""
    path = Path(get_session_physical_temp(session))
    path.mkdir(parents=True, exist_ok=True)
    return path


def sanitize_path_error(
    message: str,
    *,
    physical_workspace: str | None = None,
    extra_roots: list[str] | None = None,
) -> str:
    """Strip host physical roots from error messages for API/audit hygiene.

    Replaces known physical prefixes with ``<workspace>`` so agents and
    clients never see host layout details.
    """
    if not message:
        return message

    from sandbox.config import settings

    roots: list[str] = []
    if physical_workspace:
        roots.append(str(physical_workspace))
    roots.append(str(settings.workspaces_path))
    roots.append(str(settings.workspaces_root))
    roots.append(str(settings.temp_path))
    roots.append(str(settings.temp_root))
    roots.extend(_DEFAULT_PHYSICAL_PREFIXES)
    if extra_roots:
        roots.extend(extra_roots)

    # Longest first so nested roots replace cleanly
    unique: list[str] = []
    for r in roots:
        r = str(r).rstrip("/")
        if r and r not in unique:
            unique.append(r)
    unique.sort(key=len, reverse=True)

    sanitized = message
    for root in unique:
        if root in sanitized:
            sanitized = sanitized.replace(root, PUBLIC_WORKSPACE_TOKEN)

    # Also redact legacy logical absolute paths if they leaked in
    if LEGACY_AGENT_WORKSPACE_PATH in sanitized:
        sanitized = sanitized.replace(
            LEGACY_AGENT_WORKSPACE_PATH, PUBLIC_WORKSPACE_TOKEN
        )

    # Collapse accidental double redaction tokens
    sanitized = re.sub(
        re.escape(PUBLIC_WORKSPACE_TOKEN) + r"{2,}",
        PUBLIC_WORKSPACE_TOKEN,
        sanitized,
    )
    return sanitized


def sanitize_physical_paths(
    text: str,
    *,
    physical_workspace: str | None = None,
    extra_roots: list[str] | None = None,
) -> str:
    """Public alias for path redaction (logs, SSE text, model-facing strings)."""
    return sanitize_path_error(
        text,
        physical_workspace=physical_workspace,
        extra_roots=extra_roots,
    )
