"""Workspace Manager — initialise and clean up per-session workspaces."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from sandbox.config import settings


class WorkspaceManager:
    """Manage per-session workspace directories on disk."""

    def init_workspace(self, session_id: str) -> Path:
        """Create the workspace directory tree for a session."""
        ws = settings.workspaces_path / session_id
        ws.mkdir(parents=True, exist_ok=True)

        for sub in ("input", "output", "tmp", "logs", "artifacts"):
            (ws / sub).mkdir(parents=True, exist_ok=True)

        (ws / "state.json").write_text("{}")
        return ws

    def remove_workspace(self, session_id: str) -> None:
        """Remove a session's workspace directory tree."""
        ws = settings.workspaces_path / session_id
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)

    def get_workspace_path(self, session_id: str) -> Path:
        return settings.workspaces_path / session_id

    def workspace_exists(self, session_id: str) -> bool:
        return (settings.workspaces_path / session_id).exists()

    def cleanup_stale(self) -> int:
        """Remove workspaces without an active session (orphan cleanup).
        Returns count removed.
        """
        # For v1 this is a no-op since session manager holds the source of
        # truth. Stale workspace detection requires a session registry query.
        return 0

    @property
    def disk_free_mb(self) -> float:
        """Return free disk space on the workspace volume in MB."""
        st = os.statvfs(str(settings.workspaces_path))
        return (st.f_frsize * st.f_bavail) / (1024 * 1024)


workspace_manager = WorkspaceManager()
