"""Anti-TOCTOU workspace regular-file opener (PR-07B read foundation).

Opens files under ``workspaces_path / {workspace_id} / ...`` using only
fd-relative ``openat``-style walks (``os.open(..., dir_fd=...)``). Never
uses ``Path.resolve`` / pathname ``stat`` / pathname ``open`` as a
fallback. Does not create directories.

Portable path: safe openat segment walk with ``O_NOFOLLOW`` on every
component. Linux ``openat2`` (``RESOLVE_BENEATH|NO_MAGICLINKS|NO_SYMLINKS``)
is intentionally not used — cross-arch ctypes syscall numbers are fragile;
the openat walk is equally fail-closed and runs on macOS and Linux.

Errors are typed and never embed physical workspace roots.
"""

from __future__ import annotations

import errno
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence

from sandbox.paths import PUBLIC_WORKSPACE_TOKEN, sanitize_path_error
from sandbox.security.path_validation import validate_formal_id

# Directory components: must be directories, never follow symlinks.
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# Leaf: regular file only (enforced via fstat after open); nonblock so FIFO
# open cannot hang the worker.
_LEAF_FLAGS = (
    os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
)


class SecureWorkspaceFileError(Exception):
    """Typed failure opening a workspace file (no physical paths in message)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "SecureWorkspaceFileError"


@dataclass(frozen=True)
class FileIdentity:
    """Stable identity snapshot from a single fd's fstat."""

    st_dev: int
    st_ino: int
    st_size: int
    st_mtime_ns: int
    st_ctime_ns: int


def file_identity_from_stat(st: os.stat_result) -> FileIdentity:
    """Build :class:`FileIdentity` from an ``os.fstat`` / ``os.stat_result``."""
    return FileIdentity(
        st_dev=int(st.st_dev),
        st_ino=int(st.st_ino),
        st_size=int(st.st_size),
        st_mtime_ns=int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))),
        st_ctime_ns=int(getattr(st, "st_ctime_ns", int(st.st_ctime * 1_000_000_000))),
    )


def identities_equal(a: FileIdentity, b: FileIdentity) -> bool:
    """True when reader-critical identity fields match (dev/ino/size/mtime/ctime)."""
    return (
        a.st_dev == b.st_dev
        and a.st_ino == b.st_ino
        and a.st_size == b.st_size
        and a.st_mtime_ns == b.st_mtime_ns
        and a.st_ctime_ns == b.st_ctime_ns
    )


def validate_relative_parts(parts: Sequence[str]) -> tuple[str, ...]:
    """Validate workspace-relative path parts (no join / resolve).

    Rejects empty leaf, ``.``, ``..``, NUL, absolute, backslash, empty
    segments, or empty parts list.
    """
    if not isinstance(parts, (list, tuple)):
        raise SecureWorkspaceFileError(
            "PATH_INVALID", "relative path parts must be a list or tuple"
        )
    if len(parts) == 0:
        raise SecureWorkspaceFileError(
            "PATH_INVALID", "relative path parts must be non-empty"
        )
    cleaned: list[str] = []
    for part in parts:
        if not isinstance(part, str):
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "path segment must be a string"
            )
        if part == "":
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "empty path segment rejected"
            )
        if "\x00" in part:
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "NUL in path segment rejected"
            )
        if part in (".", ".."):
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "'.' and '..' path segments rejected"
            )
        if "/" in part or "\\" in part:
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "absolute or multi-segment path part rejected"
            )
        if part.startswith("/") or (len(part) > 1 and part[1] == ":"):
            raise SecureWorkspaceFileError(
                "PATH_INVALID", "absolute path segment rejected"
            )
        cleaned.append(part)
    # Explicit empty-leaf check (last component) — already covered by "" /
    # "." rules, but keep leaf non-empty for clarity.
    if cleaned[-1] == "":
        raise SecureWorkspaceFileError("PATH_INVALID", "empty leaf rejected")
    return tuple(cleaned)


def _safe_os_error(exc: OSError, *, workspaces_path: str) -> SecureWorkspaceFileError:
    """Map OSError to typed error without leaking physical roots."""
    en = exc.errno
    raw = sanitize_path_error(
        str(exc),
        physical_workspace=workspaces_path,
        extra_roots=[workspaces_path],
    )
    # Collapse any residual absolute paths to the public token.
    if workspaces_path and workspaces_path in raw:
        raw = raw.replace(workspaces_path, PUBLIC_WORKSPACE_TOKEN)
    if en in (errno.ENOENT, errno.ENOTDIR):
        return SecureWorkspaceFileError("FILE_NOT_FOUND", "file not found")
    if en in (errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)):
        return SecureWorkspaceFileError(
            "SYMLINK_REJECTED", "symlink rejected in workspace path"
        )
    if en == errno.EACCES:
        return SecureWorkspaceFileError("PERMISSION_DENIED", "permission denied")
    if en == errno.EISDIR:
        return SecureWorkspaceFileError(
            "NOT_REGULAR_FILE", "path is a directory, not a regular file"
        )
    # ENXIO / ENXIO for FIFO nonblock with no writer on some platforms
    if en in (errno.ENXIO, errno.EOPNOTSUPP, errno.EINVAL):
        return SecureWorkspaceFileError(
            "NOT_REGULAR_FILE", "not a regular file"
        )
    return SecureWorkspaceFileError(
        "OPEN_FAILED",
        f"open failed: {raw}" if raw else "open failed",
    )


@contextmanager
def open_trusted_root_regular_file(
    root_path: str | Path,
    relative_parts: Sequence[str],
) -> Iterator[int]:
    """Open a regular file under a trusted root with an fd-relative walk.

    Unlike a workspace, the Skill root has no user-controlled identifier. It
    still receives the same O_NOFOLLOW traversal so a malicious package cannot
    use a symlink to read outside the read-only mount.
    """
    if root_path is None or str(root_path).strip() == "":
        raise SecureWorkspaceFileError("PATH_INVALID", "trusted root is required")
    root = str(root_path)
    parts = validate_relative_parts(relative_parts)
    root_fd = -1
    leaf_fd = -1
    opened_dirs: list[int] = []
    try:
        try:
            root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root) from exc
        dir_fd = root_fd
        for seg in parts[:-1]:
            try:
                next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError as exc:
                raise _safe_os_error(exc, workspaces_path=root) from exc
            opened_dirs.append(next_fd)
            dir_fd = next_fd
        try:
            leaf_fd = os.open(parts[-1], _LEAF_FLAGS, dir_fd=dir_fd)
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root) from exc
        try:
            st = os.fstat(leaf_fd)
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root) from exc
        if not stat.S_ISREG(st.st_mode):
            raise SecureWorkspaceFileError("NOT_REGULAR_FILE", "not a regular file")
        yield leaf_fd
    finally:
        if leaf_fd >= 0:
            try:
                os.close(leaf_fd)
            except OSError:
                pass
        for d in reversed(opened_dirs):
            try:
                os.close(d)
            except OSError:
                pass
        if root_fd >= 0:
            try:
                os.close(root_fd)
            except OSError:
                pass


@contextmanager
def open_workspace_regular_file(
    workspaces_path: str | Path,
    workspace_id: str,
    relative_parts: Sequence[str],
) -> Iterator[int]:
    """Open a regular file under a workspace via fd-relative openat walk.

    Parameters
    ----------
    workspaces_path:
        Trusted settings root (``settings.workspaces_path``). Not created.
    workspace_id:
        Formal ULID (validated / uppercased).
    relative_parts:
        Canonical workspace-relative segments (already split; no ``/``).

    Yields
    ------
    int
        Open file descriptor (``O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK``).
        Caller must not close it; the context manager closes all fds.
    """
    if workspaces_path is None or str(workspaces_path).strip() == "":
        raise SecureWorkspaceFileError(
            "PATH_INVALID", "workspaces_path is required"
        )
    root_path = str(workspaces_path)
    # Formal id only — reject path-shaped workspace keys.
    try:
        safe_ws = validate_formal_id(workspace_id, "workspace_id")
    except ValueError as exc:
        raise SecureWorkspaceFileError(
            "PATH_INVALID", "workspace_id must be a formal ULID"
        ) from exc

    parts = validate_relative_parts(relative_parts)

    root_fd = -1
    ws_fd = -1
    dir_fd = -1
    leaf_fd = -1
    opened_dirs: list[int] = []

    try:
        try:
            root_fd = os.open(
                root_path,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
            )
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root_path) from exc

        try:
            ws_fd = os.open(
                safe_ws,
                _DIR_FLAGS,
                dir_fd=root_fd,
            )
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root_path) from exc

        # Walk intermediate directories (all but last).
        dir_fd = ws_fd
        for seg in parts[:-1]:
            try:
                next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError as exc:
                raise _safe_os_error(exc, workspaces_path=root_path) from exc
            opened_dirs.append(next_fd)
            dir_fd = next_fd

        leaf = parts[-1]
        try:
            leaf_fd = os.open(leaf, _LEAF_FLAGS, dir_fd=dir_fd)
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root_path) from exc

        try:
            st = os.fstat(leaf_fd)
        except OSError as exc:
            raise _safe_os_error(exc, workspaces_path=root_path) from exc

        if not stat.S_ISREG(st.st_mode):
            # FIFO / device / socket / dir — refuse without hanging.
            raise SecureWorkspaceFileError(
                "NOT_REGULAR_FILE", "not a regular file"
            )

        yield leaf_fd
    finally:
        # Close in reverse order; ignore errors on close.
        if leaf_fd >= 0:
            try:
                os.close(leaf_fd)
            except OSError:
                pass
        for d in reversed(opened_dirs):
            try:
                os.close(d)
            except OSError:
                pass
        if ws_fd >= 0:
            try:
                os.close(ws_fd)
            except OSError:
                pass
        if root_fd >= 0:
            try:
                os.close(root_fd)
            except OSError:
                pass


def fstat_identity(fd: int) -> FileIdentity:
    """fstat *fd* and return a :class:`FileIdentity` (never pathname)."""
    if type(fd) is not int or fd < 0:  # noqa: E721
        raise SecureWorkspaceFileError("OPEN_FAILED", "invalid file descriptor")
    try:
        st = os.fstat(fd)
    except OSError as exc:
        raise SecureWorkspaceFileError(
            "OPEN_FAILED", "fstat failed"
        ) from exc
    return file_identity_from_stat(st)
