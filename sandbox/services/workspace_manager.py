"""Workspace Manager — initialise and clean up conversation/session workspaces.

Physical workspaces live under ``settings.workspaces_path / {workspace_id}``.
Agent-visible logical path is always ``/home/sandbox/workspace`` (see
``sandbox.paths.AGENT_WORKSPACE_PATH``).

A process-global presentation symlink is **disabled by default** because it
races under concurrent multi-session load. Execution uses physical cwd;
agent/API surfaces use logical paths only.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from collections.abc import Callable
from pathlib import Path

from sandbox.config import settings
from sandbox.paths import (
    AGENT_WORKSPACE_PATH,
    conversation_workspace_id,
)

logger = logging.getLogger("sandbox.workspace")

# Optional presentation link (agent-visible stable path). Not used as exec cwd.
WORKSPACE_LINK = Path(AGENT_WORKSPACE_PATH)


class WorkspaceWriteConflict(Exception):
    """Raised when a second session claims write on a leased workspace."""

    def __init__(self, workspace_id: str, holder_session_id: str) -> None:
        self.workspace_id = workspace_id
        self.holder_session_id = holder_session_id
        super().__init__(
            f"Workspace write lease held by session {holder_session_id}"
        )


class WorkspaceWriteLease:
    """In-process single-writer lease per conversation workspace.

    One RUNNING sandbox session may hold the write lease for a given
    ``workspace_id``. A second concurrent claim raises
    :class:`WorkspaceWriteConflict` (mapped to HTTP 409 by routers).
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        # workspace_id -> session_id
        self._holders: dict[str, str] = {}

    def claim(self, workspace_id: str, session_id: str) -> None:
        if not workspace_id or not session_id:
            raise ValueError("workspace_id and session_id are required")
        with self._lock:
            current = self._holders.get(workspace_id)
            if current is None or current == session_id:
                self._holders[workspace_id] = session_id
                return
            # Another session holds the lease — allow reclaim only if that
            # session is no longer RUNNING (caller may pass a liveness probe).
            raise WorkspaceWriteConflict(workspace_id, current)

    def claim_with_liveness(
        self,
        workspace_id: str,
        session_id: str,
        *,
        is_holder_alive: Callable[[str], bool] | None = None,
    ) -> None:
        """Claim lease; if held, reclaim when holder is not alive."""
        if not workspace_id or not session_id:
            raise ValueError("workspace_id and session_id are required")
        with self._lock:
            current = self._holders.get(workspace_id)
            if current is None or current == session_id:
                self._holders[workspace_id] = session_id
                return
            alive = True
            if is_holder_alive is not None:
                try:
                    alive = bool(is_holder_alive(current))
                except Exception:  # noqa: BLE001 — fail closed to conflict
                    alive = True
            if not alive:
                self._holders[workspace_id] = session_id
                return
            raise WorkspaceWriteConflict(workspace_id, current)

    def release(self, workspace_id: str, session_id: str | None = None) -> None:
        with self._lock:
            current = self._holders.get(workspace_id)
            if current is None:
                return
            if session_id is None or current == session_id:
                self._holders.pop(workspace_id, None)

    def holder(self, workspace_id: str) -> str | None:
        with self._lock:
            return self._holders.get(workspace_id)

    def clear(self) -> None:
        """Test helper — drop all leases."""
        with self._lock:
            self._holders.clear()


# Process-wide lease registry (single sandbox worker process).
write_lease = WorkspaceWriteLease()


class WorkspaceManager:
    """Manage per-session / per-conversation workspace directories on disk."""

    # ── Optional presentation symlink (disabled by default) ──

    def activate_workspace(self, target_dir: str | Path) -> Path:
        """Best-effort: point agent-visible workspace path → *target_dir*.

        **Disabled by default** (``settings.enable_global_workspace_symlink``).
        Concurrent multi-session correctness depends on physical paths only —
        never on the global link. Failures are swallowed so host tests never
        depend on writing under ``/home/sandbox``.
        """
        target = Path(target_dir).resolve()
        if not target.is_dir():
            target.mkdir(parents=True, exist_ok=True)

        if not getattr(settings, "enable_global_workspace_symlink", False):
            return target

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

    def physical_path_for_workspace_id(self, workspace_id: str) -> Path:
        """Return physical root for a workspace_id (may not exist yet)."""
        return settings.workspaces_path / workspace_id

    def init_workspace(self, session_id: str) -> Path:
        """Create an **empty** workspace directory for a sandbox session (P2).

        Does **not** add skills symlinks or seed folders. Skills are only
        available at the agent skill path (``/home/sandbox/skill``).
        Does **not** activate the global presentation symlink.
        """
        ws = settings.workspaces_path / session_id
        ws.mkdir(parents=True, exist_ok=True)
        return ws

    def init_conversation_workspace(self, conversation_id: str) -> Path:
        """Create a persistent workspace directory for a conversation session.

        Physical path: ``<workspaces_root>/conv_<conversation_id>/``.
        Empty at init (P2). No global symlink activation.
        Client-supplied ids are validated and the resolved path must stay
        under ``settings.workspaces_path``.
        """
        from sandbox.security.path_validation import validate_conversation_id

        safe_id = validate_conversation_id(conversation_id)
        workspace_id = conversation_workspace_id(safe_id)
        root = settings.workspaces_path.resolve()
        ws = (root / workspace_id).resolve()
        try:
            if not ws.is_relative_to(root):
                raise PermissionError(
                    "Conversation workspace escapes workspaces root"
                )
        except AttributeError:  # pragma: no cover - Python < 3.9 fallback
            if os.path.commonpath([str(root), str(ws)]) != str(root):
                raise PermissionError(
                    "Conversation workspace escapes workspaces root"
                )
        ws.mkdir(parents=True, exist_ok=True)
        return ws

    def remove_workspace(self, session_id: str) -> None:
        """Remove a session's workspace directory tree."""
        ws = settings.workspaces_path / session_id
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)
        write_lease.release(session_id)

    def remove_conversation_workspace(self, conversation_id: str) -> None:
        """Remove a conversation's persistent workspace."""
        from sandbox.security.path_validation import validate_conversation_id

        try:
            safe_id = validate_conversation_id(conversation_id)
        except ValueError:
            return
        workspace_id = conversation_workspace_id(safe_id)
        root = settings.workspaces_path.resolve()
        ws = (root / workspace_id).resolve()
        try:
            if not ws.is_relative_to(root):
                return
        except AttributeError:  # pragma: no cover
            if os.path.commonpath([str(root), str(ws)]) != str(root):
                return
        if ws.exists():
            shutil.rmtree(str(ws), ignore_errors=True)
        write_lease.release(workspace_id)
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

# Re-export helpers used by routers
__all__ = [
    "WorkspaceManager",
    "WorkspaceWriteConflict",
    "WorkspaceWriteLease",
    "workspace_manager",
    "write_lease",
    "to_public_workspace_path",
]
