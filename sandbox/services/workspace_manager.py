"""Workspace Manager — initialise and clean up per-session workspaces.

Physical workspaces live under ``settings.workspaces_path / {session_id}``.
Agent-visible logical path is always ``/home/sandbox/workspace`` (see
``sandbox.paths.AGENT_WORKSPACE_PATH``).

A process-global presentation symlink is **optional** and best-effort for
single-session container compatibility.  Concurrent multi-session correctness
depends on physical paths only — never on the global link.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from sandbox.config import settings
from sandbox.paths import AGENT_WORKSPACE_PATH

logger = logging.getLogger("sandbox.workspace")

# Optional presentation link (agent-visible stable path). Not used as exec cwd.
WORKSPACE_LINK = Path(AGENT_WORKSPACE_PATH)


class WorkspaceManager:
    """Manage per-session workspace directories on disk."""

    # ── Optional presentation symlink (single-session compat only) ──

    def activate_workspace(self, target_dir: str | Path) -> Path:
        """Best-effort: point agent-visible workspace path → *target_dir*.

        Failures are swallowed so host tests and multi-session runs never
        depend on writing under ``/home/sandbox``.  Callers must use the
        returned physical path (or session metadata) for real I/O.
        """
        target = Path(target_dir).resolve()
        if not target.is_dir():
            target.mkdir(parents=True, exist_ok=True)

        try:
            if WORKSPACE_LINK.is_symlink():
                WORKSPACE_LINK.unlink()
            elif WORKSPACE_LINK.exists():
                # Only remove empty dirs / non-critical fallbacks
                if WORKSPACE_LINK.is_dir() and not any(WORKSPACE_LINK.iterdir()):
                    WORKSPACE_LINK.rmdir()
                elif WORKSPACE_LINK.is_file():
                    WORKSPACE_LINK.unlink()
                else:
                    return target

            WORKSPACE_LINK.parent.mkdir(parents=True, exist_ok=True)
            if not WORKSPACE_LINK.exists():
                WORKSPACE_LINK.symlink_to(target)
        except OSError as exc:
            logger.debug("activate_workspace skipped (%s): %s", WORKSPACE_LINK, exc)

        return target

    def get_unified_workspace(self) -> Path:
        """Return the resolved physical path behind the presentation link if any."""
        try:
            if WORKSPACE_LINK.exists() or WORKSPACE_LINK.is_symlink():
                return WORKSPACE_LINK.resolve()
        except (OSError, RuntimeError):
            pass
        return WORKSPACE_LINK

    # ── Physical directory management ────────────────────────────

    def init_workspace(self, session_id: str) -> Path:
        """Create an **empty** workspace directory for a sandbox session (P2).

        Does **not** add skills symlinks or seed folders. Skills are only
        available at the agent skill path (``/home/sandbox/skill``).
        """
        ws = settings.workspaces_path / session_id
        ws.mkdir(parents=True, exist_ok=True)
        # Optional single-session presentation — executions must not rely on it
        self.activate_workspace(ws)
        return ws

    def init_conversation_workspace(self, conversation_id: str) -> Path:
        """Create a persistent workspace directory for a conversation session.

        Physical path: ``<workspaces_root>/conv_<conversation_id>/``.
        Empty at init (P2). Presentation symlink is best-effort only.
        """
        ws = settings.workspaces_path / f"conv_{conversation_id}"
        ws.mkdir(parents=True, exist_ok=True)
        self.activate_workspace(ws)
        return ws

    def remove_workspace(self, session_id: str) -> None:
        """Remove a session's workspace directory tree."""
        ws = settings.workspaces_path / session_id
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)

    def remove_conversation_workspace(self, conversation_id: str) -> None:
        """Remove a conversation's persistent workspace."""
        ws = settings.workspaces_path / f"conv_{conversation_id}"
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)
        # Clean dangling presentation symlink if it pointed at removed path
        try:
            if WORKSPACE_LINK.is_symlink() and not WORKSPACE_LINK.exists():
                WORKSPACE_LINK.unlink()
        except OSError:
            pass

    def get_workspace_path(self, session_id: str) -> Path:
        """Return the physical workspace path for *session_id* (may not exist yet)."""
        return settings.workspaces_path / session_id

    def workspace_exists(self, session_id: str) -> bool:
        return (settings.workspaces_path / session_id).exists()

    def cleanup_stale(self) -> int:
        return 0

    @property
    def disk_free_mb(self) -> float:
        root = settings.workspaces_path
        root.mkdir(parents=True, exist_ok=True)
        st = os.statvfs(str(root))
        return (st.f_frsize * st.f_bavail) / (1024 * 1024)


workspace_manager = WorkspaceManager()
