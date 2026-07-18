"""Workspace Manager — initialise and clean up AgentSession-owned workspaces.

Physical workspaces live under ``settings.workspaces_path / {workspace_id}``.
Public contract uses opaque ``workspace_id`` + relative tool paths only
(see ``sandbox.paths``). Physical roots never leave service/repository layers.

Ownership (PR-07A / plan §2.6):

- Exactly one AgentSession owns one Workspace.
- Lifecycle follows AgentSession / Sandbox Session close — never Conversation.
- Agent-visible ``/home/sandbox/workspace`` is a per-execution Bubblewrap bind.
- Global mutable presentation symlinks are forbidden and fully removed.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from sandbox.config import settings
from sandbox.paths import temp_id_for_workspace_id
from sandbox.security.path_validation import validate_formal_id

logger = logging.getLogger("sandbox.workspace")


class WorkspaceCleanupError(OSError):
    """Raised when workspace/temp tree removal fails (binding must not be freed)."""


class WorkspaceManager:
    """Manage per-AgentSession workspace directories on disk."""

    # ── Physical directory management ────────────────────────────

    def physical_path_for_workspace_id(self, workspace_id: str) -> Path:
        """Return physical root for a workspace_id (may not exist yet)."""
        return settings.workspaces_path / workspace_id

    def physical_temp_path_for_workspace_id(self, workspace_id: str) -> Path:
        """Return persistent-temp root paired with *workspace_id*."""
        return settings.temp_path / temp_id_for_workspace_id(workspace_id)

    def init_workspace(self, workspace_id: str) -> Path:
        """Create an **empty** workspace directory for a formal workspace_id.

        Does **not** add skills symlinks or seed folders. Skills are only
        available at the agent skill path (Bubblewrap read-only bind).
        """
        safe_id = validate_formal_id(workspace_id, "workspace_id")
        root = settings.workspaces_path.resolve()
        ws = (root / safe_id).resolve()
        try:
            if not ws.is_relative_to(root):
                raise PermissionError("Workspace escapes workspaces root")
        except AttributeError:  # pragma: no cover - Python < 3.9 fallback
            if os.path.commonpath([str(root), str(ws)]) != str(root):
                raise PermissionError("Workspace escapes workspaces root")
        ws.mkdir(parents=True, exist_ok=True)
        self.init_temp(safe_id)
        return ws

    def init_temp(self, workspace_id: str) -> Path:
        """Create persistent temp storage for an opaque workspace identity."""
        safe_id = validate_formal_id(workspace_id, "workspace_id")
        root = settings.temp_path.resolve()
        root.mkdir(parents=True, exist_ok=True)
        temp = (root / temp_id_for_workspace_id(safe_id)).resolve()
        try:
            if not temp.is_relative_to(root):
                raise PermissionError("Persistent temp escapes configured temp root")
        except AttributeError:  # pragma: no cover
            if os.path.commonpath([str(root), str(temp)]) != str(root):
                raise PermissionError("Persistent temp escapes configured temp root")
        temp.mkdir(parents=True, exist_ok=True)
        try:
            temp.chmod(0o700)
        except OSError:
            pass
        return temp

    def remove_workspace(self, workspace_id: str) -> None:
        """Remove an AgentSession-owned workspace directory tree + paired temp.

        Called on Session / AgentSession close — never Conversation lifecycle.

        Raises :class:`WorkspaceCleanupError` if a tree still exists after the
        removal attempt. Callers **must not** free AgentSession/workspace
        bindings when this raises — orphan data + freed binding enables
        cross-session reuse of residual files.
        """
        try:
            safe_id = validate_formal_id(workspace_id, "workspace_id")
        except ValueError:
            # Legacy/internal non-formal ids (e.g. old sandbox_* private trees).
            safe_id = workspace_id
            if not safe_id or "/" in safe_id or "\\" in safe_id or ".." in safe_id:
                raise WorkspaceCleanupError(
                    f"Refusing to remove invalid workspace id: {workspace_id!r}"
                ) from None

        root = settings.workspaces_path.resolve()
        ws = (root / safe_id).resolve()
        try:
            if not ws.is_relative_to(root):
                raise WorkspaceCleanupError(
                    "Workspace path escapes workspaces root"
                )
        except AttributeError:  # pragma: no cover
            if os.path.commonpath([str(root), str(ws)]) != str(root):
                raise WorkspaceCleanupError(
                    "Workspace path escapes workspaces root"
                )

        errors: list[str] = []
        if ws.exists():
            try:
                shutil.rmtree(str(ws), ignore_errors=False)
            except OSError as exc:
                errors.append(f"workspace: {exc}")
            if ws.exists():
                errors.append("workspace tree still present after rmtree")

        try:
            temp = self.physical_temp_path_for_workspace_id(safe_id)
        except ValueError as exc:
            raise WorkspaceCleanupError(str(exc)) from exc

        if temp.exists():
            try:
                shutil.rmtree(str(temp), ignore_errors=False)
            except OSError as exc:
                errors.append(f"temp: {exc}")
            if temp.exists():
                errors.append("temp tree still present after rmtree")

        if errors:
            raise WorkspaceCleanupError(
                "Workspace cleanup failed; binding must not be released: "
                + "; ".join(errors)
            )

    def get_workspace_path(self, workspace_id: str) -> Path:
        """Return the physical workspace path for *workspace_id* (may not exist)."""
        return settings.workspaces_path / workspace_id

    def get_temp_path(self, workspace_id: str) -> Path:
        """Return physical persistent-temp path for an opaque workspace id."""
        return self.physical_temp_path_for_workspace_id(workspace_id)

    def workspace_exists(self, workspace_id: str) -> bool:
        return (settings.workspaces_path / workspace_id).exists()

    def cleanup_stale(self) -> int:
        return 0

    @property
    def disk_free_mb(self) -> float:
        root = settings.workspaces_path
        root.mkdir(parents=True, exist_ok=True)
        st = os.statvfs(str(root))
        return (st.f_frsize * st.f_bavail) / (1024 * 1024)


workspace_manager = WorkspaceManager()

__all__ = [
    "WorkspaceCleanupError",
    "WorkspaceManager",
    "workspace_manager",
]
