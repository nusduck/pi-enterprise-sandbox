"""Path escape detection — safe workspace path resolution."""

from __future__ import annotations

import os
from pathlib import Path


def resolve_safe_path(workspace: str, user_path: str) -> Path:
    """Resolve a user-supplied path relative to the workspace root, raising
    PermissionError if the resolved path escapes the workspace boundary.

    Uses ``Path.resolve() + is_relative_to`` (Python 3.9+) with
    ``os.path.commonpath`` fallback for older runtimes.
    """
    base = Path(workspace).resolve()
    target = (base / user_path).resolve()

    try:
        if not target.is_relative_to(base):
            raise PermissionError(
                f"Path escape detected: {user_path} -> {target} "
                f"is outside workspace {workspace}"
            )
    except AttributeError:  # Python < 3.9 fallback
        if os.path.commonpath([str(base), str(target)]) != str(base):
            raise PermissionError(
                f"Path escape detected: {user_path} -> {target}"
            )

    return target


def enforce_path_within_workspace(
    workspace: str, user_path: str
) -> Path:
    """Resolve and verify path is within workspace with additional symlink
    awareness. Expected to be used as the single path-gate for all file APIs.

    Safety notes:
    - ``resolve()`` follows symlinks — if a symlink inside workspace points
      outside, this *will* follow it and the subsequent ``is_relative_to``
      check will catch the escape.
    - TOCTOU race is accepted for v1 (workspace only writable by the
      sandbox non-root user; skills directory is read-only mounted).
    """
    return resolve_safe_path(workspace, user_path)


def is_path_in_workspace(workspace: str, user_path: str) -> bool:
    """Return True if the resolved path is safely inside the workspace."""
    try:
        resolve_safe_path(workspace, user_path)
        return True
    except PermissionError:
        return False
