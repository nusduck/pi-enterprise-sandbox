"""Path escape detection — safe workspace path resolution.

Path policy (public agent / API contract):

- Relative paths address the workspace (``foo/bar.txt``, ``.``, ``./x``).
- ``/home/sandbox/workspace/...`` addresses the same workspace.
- ``/tmp/...`` addresses the current workspace's persistent temp tree.
- Reject every other absolute path.
- Reject null bytes, home expansion (``~``), and paths that escape the
  physical workspace via ``..`` or symlink/hardlink resolution.
- Error messages never include physical workspace roots (redacted to
  ``<workspace>``).
"""

from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath

from sandbox.paths import (
    AGENT_TEMP_PATH,
    LEGACY_AGENT_WORKSPACE_PATH,
    SandboxPath,
    SandboxPathScope,
    sanitize_path_error,
)

# Conservative conversation identifiers: UUID-friendly, no path separators.
_CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")

# Formal domain IDs (plan §5): ULID, Crockford Base32, CHAR(26).
_FORMAL_ID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$", re.IGNORECASE)


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


def validate_formal_id(value: str, field: str = "id") -> str:
    """Validate a formal domain id (ULID / CHAR(26) Crockford Base32).

    Returns the canonical uppercase form. Rejects empty, wrong length, or
    characters outside the Crockford alphabet (path-safe by construction).
    """
    if not value or not isinstance(value, str):
        raise ValueError(f"Invalid {field}: expected formal ULID")
    if not _FORMAL_ID_RE.fullmatch(value):
        raise ValueError(
            f"Invalid {field}: expected 26 Crockford Base32 characters"
        )
    return value.upper()


def parse_sandbox_path(user_path: str) -> SandboxPath:
    """Parse a user path into a validated logical root plus relative path.

    Accepts:
    - relative paths: ``foo/bar.txt``, ``.``, ``./x``
    - logical workspace paths under ``/home/sandbox/workspace``
    - persistent temp paths under ``/tmp``

    Rejects:
    - empty / non-string
    - null bytes
    - home expansion
    - any other absolute path (POSIX or Windows drive)
    - parent traversal
    """
    if user_path is None or not isinstance(user_path, str):
        raise ValueError("Invalid path")
    if "\x00" in user_path:
        raise ValueError("Invalid path: null byte")

    raw = user_path.strip() or "."

    if raw.startswith("~"):
        raise ValueError("Invalid path: home expansion not allowed")

    if len(raw) > 1 and raw[1] == ":":
        raise PermissionError(
            f"Path escape detected: absolute path outside workspace: {raw}"
        )

    scope = SandboxPathScope.WORKSPACE
    candidate = PurePosixPath(raw)
    workspace_root = PurePosixPath(LEGACY_AGENT_WORKSPACE_PATH)
    temp_root = PurePosixPath(AGENT_TEMP_PATH)

    if candidate == workspace_root:
        candidate = PurePosixPath(".")
    elif candidate.is_relative_to(workspace_root):
        candidate = candidate.relative_to(workspace_root)
    elif candidate == temp_root:
        scope = SandboxPathScope.TEMP
        candidate = PurePosixPath(".")
    elif candidate.is_relative_to(temp_root):
        scope = SandboxPathScope.TEMP
        candidate = candidate.relative_to(temp_root)
    elif candidate.is_absolute():
        raise PermissionError(
            f"Path escape detected: absolute path outside sandbox roots: {raw}"
        )

    if ".." in candidate.parts:
        raise PermissionError(f"Path escape detected: parent traversal: {raw}")

    parts = [part for part in candidate.parts if part not in ("", ".")]
    relative = PurePosixPath(*parts) if parts else PurePosixPath(".")
    return SandboxPath(scope=scope, relative=relative)


def normalize_user_path(user_path: str) -> str:
    """Backward-compatible normalization for workspace-only call sites."""
    parsed = parse_sandbox_path(user_path)
    if parsed.scope != SandboxPathScope.WORKSPACE:
        raise PermissionError("Path belongs to persistent temp, not workspace")
    return parsed.relative.as_posix()


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


def resolve_sandbox_path(
    workspace: str | Path,
    temp: str | Path,
    user_path: str,
) -> tuple[SandboxPath, Path]:
    """Resolve a public path against the current workspace or temp root."""
    parsed = parse_sandbox_path(user_path)
    base = Path(workspace if parsed.scope == SandboxPathScope.WORKSPACE else temp).resolve()
    target = (base / parsed.relative).resolve()

    try:
        inside = target.is_relative_to(base)
    except AttributeError:  # pragma: no cover - Python < 3.9 fallback
        inside = os.path.commonpath([str(base), str(target)]) == str(base)
    if not inside:
        _raise_escape(user_path, physical_workspace=str(base))
    return parsed, target


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
