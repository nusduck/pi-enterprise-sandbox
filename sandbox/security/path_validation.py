"""Path escape detection — safe workspace path resolution.

Path policy (public agent / API contract):

- Accept **relative** paths only (``foo/bar.txt``, ``.``, ``./x``).
- Reject absolute paths (including legacy ``/home/sandbox/workspace/...``).
- Reject null bytes, home expansion (``~``), and paths that escape the
  physical workspace via ``..`` or symlink/hardlink resolution.
- Error messages never include physical workspace roots (redacted to
  ``<workspace>``).
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from sandbox.paths import sanitize_path_error

# Conservative conversation identifiers: UUID-friendly, no path separators.
_CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def validate_conversation_id(conversation_id: str) -> str:
    """Validate a client-supplied conversation id used in workspace names.

    Rejects empty values, path separators, traversal sequences and other
    characters that could escape ``workspaces_root`` when joined as
    ``conv_<id>``. Returns the validated id unchanged.
    """
    if not conversation_id or not isinstance(conversation_id, str):
        raise ValueError("Invalid conversation id")
    if not _CONVERSATION_ID_RE.fullmatch(conversation_id):
        raise ValueError(
            "Invalid conversation id: must be 1-128 chars of "
            "[A-Za-z0-9_-], starting with alphanumeric"
        )
    return conversation_id


def normalize_user_path(user_path: str) -> str:
    """Normalize a user-supplied path to a workspace-relative form.

    Accepts:
    - relative paths: ``foo/bar.txt``, ``.``, ``./x``

    Rejects:
    - empty / non-string
    - null bytes
    - home expansion
    - any absolute path (POSIX or Windows drive)
    """
    if user_path is None or not isinstance(user_path, str):
        raise ValueError("Invalid path")
    if "\x00" in user_path:
        raise ValueError("Invalid path: null byte")

    raw = user_path.strip() or "."

    if raw.startswith("~"):
        raise ValueError("Invalid path: home expansion not allowed")

    # Absolute paths fail closed (no legacy logical-absolute mapping).
    if raw.startswith("/") or (len(raw) > 1 and raw[1] == ":"):
        raise PermissionError(
            f"Path escape detected: absolute path outside workspace: {raw}"
        )

    return raw if raw else "."


def _raise_escape(user_path: str, physical_workspace: str | None = None) -> None:
    msg = sanitize_path_error(
        f"Path escape detected: {user_path} is outside workspace",
        physical_workspace=physical_workspace,
    )
    raise PermissionError(msg)


def resolve_safe_path(workspace: str, user_path: str) -> Path:
    """Resolve a user-supplied path relative to the workspace root.

    Raises ``PermissionError`` if the resolved path escapes the workspace
    boundary. Error text is sanitized so physical roots are never returned.
    """
    try:
        relative = normalize_user_path(user_path)
    except PermissionError:
        raise
    except ValueError as exc:
        raise ValueError(sanitize_path_error(str(exc), physical_workspace=workspace)) from exc

    base = Path(workspace).resolve()
    # Join relative segments only — never re-introduce absolute user paths.
    target = (base / relative).resolve()

    try:
        if not target.is_relative_to(base):
            _raise_escape(user_path, physical_workspace=str(base))
    except AttributeError:  # Python < 3.9 fallback
        if os.path.commonpath([str(base), str(target)]) != str(base):
            _raise_escape(user_path, physical_workspace=str(base))

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
    except (PermissionError, ValueError):
        return False
