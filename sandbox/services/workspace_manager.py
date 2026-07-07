"""Workspace Manager — initialise and clean up per-session workspaces.

The unified workspace path ``/sandbox/workspace`` is a **symlink** that always
points to the active conversation's physical directory (e.g.
``/var/sandbox/workspaces/conv_xxx/``).  Agent and user only ever see
``/sandbox/workspace`` — no IDs leak into the visible path.

The parent directory ``/var/sandbox/workspaces/`` has **0311** permissions
(execute-only for owner=sandbox), so the agent cannot ``ls`` it or discover
other conversation workspaces.  ``cd /sandbox/workspace/..`` lands in the
restricted parent, where ``ls`` returns ``Permission denied``.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from sandbox.config import settings

WORKSPACE_LINK = Path("/sandbox/workspace")


class WorkspaceManager:
    """Manage per-session workspace directories on disk."""

    # ── Unified symlink ──────────────────────────────────────────

    def activate_workspace(self, target_dir: str | Path) -> Path:
        """Point ``/sandbox/workspace`` → *target_dir*.

        *target_dir* must already exist.  Returns the resolved physical path.
        Removes the fallback directory and replaces it with a symlink.
        """
        target = Path(target_dir).resolve()
        if not target.is_dir():
            target.mkdir(parents=True, exist_ok=True)

        # Remove old link/directory
        if WORKSPACE_LINK.is_symlink():
            WORKSPACE_LINK.unlink()
        elif WORKSPACE_LINK.exists():
            shutil.rmtree(str(WORKSPACE_LINK))

        WORKSPACE_LINK.symlink_to(target)
        return target

    def get_unified_workspace(self) -> Path:
        """Return the resolved physical path behind ``/sandbox/workspace``."""
        try:
            return WORKSPACE_LINK.resolve()
        except (OSError, RuntimeError):
            return WORKSPACE_LINK

    # ── Physical directory management ────────────────────────────

    def init_workspace(self, session_id: str) -> Path:
        """Create a clean workspace directory for an ephemeral sandbox session.

        Also updates the unified symlink so the agent always sees ``/sandbox/workspace``.
        """
        ws = settings.workspaces_path / session_id
        ws.mkdir(parents=True, exist_ok=True)
        self._add_skills_symlink(ws)
        self.activate_workspace(ws)
        return ws

    def init_conversation_workspace(self, conversation_id: str) -> Path:
        """Create a persistent workspace directory for a conversation session.

        Physical path: ``<workspaces_root>/conv_<conversation_id>/``.
        Updates the unified symlink so the agent sees ``/sandbox/workspace``.
        """
        ws = settings.workspaces_path / f"conv_{conversation_id}"
        ws.mkdir(parents=True, exist_ok=True)
        self._add_skills_symlink(ws)
        self.activate_workspace(ws)
        return ws

    def remove_workspace(self, session_id: str) -> None:
        """Remove a session's workspace directory tree."""
        ws = settings.workspaces_path / session_id
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)

    def remove_conversation_workspace(self, conversation_id: str) -> None:
        """Remove a conversation's persistent workspace.

        Also cleans up the unified symlink if it points to the removed workspace.
        """
        ws = settings.workspaces_path / f"conv_{conversation_id}"
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)
        # Restore /sandbox/workspace as empty directory
        if WORKSPACE_LINK.is_symlink() and not WORKSPACE_LINK.exists():
            WORKSPACE_LINK.unlink()
            WORKSPACE_LINK.mkdir(parents=True, exist_ok=True)

    def get_workspace_path(self, session_id: str) -> Path:
        return settings.workspaces_path / session_id

    def workspace_exists(self, session_id: str) -> bool:
        return (settings.workspaces_path / session_id).exists()

    def cleanup_stale(self) -> int:
        return 0

    @property
    def disk_free_mb(self) -> float:
        st = os.statvfs(str(settings.workspaces_path))
        return (st.f_frsize * st.f_bavail) / (1024 * 1024)

    # ── Internal helpers ─────────────────────────────────────────

    @staticmethod
    def _add_skills_symlink(ws: Path) -> None:
        """Add a ``skills`` symlink so workspace-relative skill paths resolve."""
        skills_link = ws / "skills"
        if not skills_link.exists():
            skills_link.symlink_to(settings.skills_path)


workspace_manager = WorkspaceManager()
