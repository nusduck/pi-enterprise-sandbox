"""Stable agent-visible path constants and physical-workspace helpers.

Agent-facing tools, prompts, and docs must use only these logical paths:

- ``/home/sandbox/workspace`` — current session workspace (R/W)
- ``/home/sandbox/skill`` — shared skills directory (R/O)

Physical storage lives under ``settings.workspaces_path / session_id`` (and
``settings.skills_path``).  Execution / file / artifact operations always use
the session's physical workspace, never a process-global symlink.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# ── Agent-visible stable paths (P3) ──────────────────────────────────────

AGENT_WORKSPACE_PATH = "/home/sandbox/workspace"
AGENT_SKILL_PATH = "/home/sandbox/skill"

# Backward-compat alias used only for optional single-session presentation.
# Must not be used as the execution cwd for multi-session correctness.
LEGACY_WORKSPACE_LINK = "/sandbox/workspace"


def get_session_physical_workspace(session: Any) -> str:
    """Return the physical on-disk workspace root for a session.

    Preference order:
    1. ``session.metadata["_physical_workspace"]`` (set at create time)
    2. ``settings.workspaces_path / session.session_id``
    """
    from sandbox.config import settings

    metadata = getattr(session, "metadata", None) or {}
    if isinstance(metadata, dict):
        physical = metadata.get("_physical_workspace")
        if physical:
            return str(physical)

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
