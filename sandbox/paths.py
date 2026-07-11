"""Stable agent-visible path constants and physical-workspace helpers.

Agent-facing tools, prompts, and docs must use only these logical paths:

- ``/home/sandbox/workspace`` — current conversation/session workspace (R/W)
- ``/home/sandbox/skill`` — shared skills directory (R/O)

Physical storage lives under ``settings.workspaces_path / {workspace_id}``
(and ``settings.skills_path``). Execution / file / artifact operations always
use the session's physical workspace, never a process-global symlink.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

# ── Agent-visible stable paths (single source of truth) ─────────────────

AGENT_WORKSPACE_PATH = "/home/sandbox/workspace"
AGENT_SKILL_PATH = "/home/sandbox/skill"

# Backward-compat alias used only for optional single-session presentation.
# Must not be used as the execution cwd for multi-session correctness.
LEGACY_WORKSPACE_LINK = "/sandbox/workspace"

# Common physical-root prefixes that must never appear in agent-facing text.
_DEFAULT_PHYSICAL_PREFIXES = (
    "/var/sandbox/workspaces",
    "/sandbox/workspaces",
)


def conversation_workspace_id(conversation_id: str) -> str:
    """Stable workspace_id for a conversation (1:1 ownership)."""
    return f"conv_{conversation_id}"


def is_logical_workspace_path(path: str | None) -> bool:
    """Return True if *path* is the logical workspace root or under it."""
    if not path:
        return False
    p = path.rstrip("/")
    return p == AGENT_WORKSPACE_PATH or p.startswith(AGENT_WORKSPACE_PATH + "/")


def is_logical_skill_path(path: str | None) -> bool:
    if not path:
        return False
    p = path.rstrip("/")
    return p == AGENT_SKILL_PATH or p.startswith(AGENT_SKILL_PATH + "/")


def to_public_workspace_path(path: str | None) -> str:
    """Map any stored workspace path to the agent-visible logical root.

    Conversations historically stored physical paths; API responses must
    always expose the stable logical path when a workspace exists.
    """
    if not path:
        return AGENT_WORKSPACE_PATH
    if is_logical_workspace_path(path):
        return AGENT_WORKSPACE_PATH
    # Any non-empty stored path represents an existing workspace.
    return AGENT_WORKSPACE_PATH


def get_session_physical_workspace(session: Any) -> str:
    """Return the physical on-disk workspace root for a session.

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


def ensure_physical_workspace(session: Any) -> Path:
    """Resolve physical workspace and create the directory if missing."""
    path = Path(get_session_physical_workspace(session))
    path.mkdir(parents=True, exist_ok=True)
    return path


def sanitize_path_error(
    message: str,
    *,
    physical_workspace: str | None = None,
    extra_roots: list[str] | None = None,
) -> str:
    """Strip host physical roots from error messages for API/audit hygiene.

    Replaces known physical prefixes with the logical workspace path so
    agents and clients never see host layout details.
    """
    if not message:
        return message

    from sandbox.config import settings

    roots: list[str] = []
    if physical_workspace:
        roots.append(str(physical_workspace))
    roots.append(str(settings.workspaces_path))
    roots.append(str(settings.workspaces_root))
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
            sanitized = sanitized.replace(root, AGENT_WORKSPACE_PATH)

    # Collapse accidental double logical prefixes
    sanitized = re.sub(
        re.escape(AGENT_WORKSPACE_PATH) + r"{2,}",
        AGENT_WORKSPACE_PATH,
        sanitized,
    )
    return sanitized
