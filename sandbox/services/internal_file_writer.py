"""Fd-relative, no-symlink workspace writer for formal files tools."""
from __future__ import annotations

import errno
import base64
import binascii
import hashlib
import os
import stat
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Sequence

from sandbox.config import settings
from sandbox.security.path_validation import validate_formal_id
from sandbox.services.child_workspace_quota import (
    ChildQuotaMeasureError,
    measure_tree_bounded,
)


_MAX_MEMORY_READ_CHUNK = 1024 * 1024
_WORKSPACE_LOCK_STRIPES = tuple(threading.RLock() for _ in range(64))


def _workspace_lock(workspace_id: str) -> threading.RLock:
    digest = hashlib.sha256(workspace_id.encode("ascii")).digest()
    return _WORKSPACE_LOCK_STRIPES[int.from_bytes(digest[:2], "big") % len(_WORKSPACE_LOCK_STRIPES)]


class InternalFileWriteError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _parts(path: str) -> tuple[str, ...]:
    prefix = "/home/sandbox/workspace/"
    if not isinstance(path, str) or not path.startswith(prefix):
        raise InternalFileWriteError("PATH_INVALID", "path must be under workspace")
    out = tuple(path[len(prefix):].split("/"))
    if not out or any(not s or s in (".", "..") or "/" in s or "\\" in s or "\x00" in s for s in out):
        raise InternalFileWriteError("PATH_INVALID", "invalid workspace path")
    return out


def _map(exc: OSError) -> InternalFileWriteError:
    if exc.errno in (errno.ENOENT, errno.ENOTDIR): return InternalFileWriteError("FILE_NOT_FOUND", "file not found")
    if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)): return InternalFileWriteError("SYMLINK_REJECTED", "symlink rejected")
    if exc.errno in (errno.EACCES, errno.EPERM): return InternalFileWriteError("PERMISSION_DENIED", "permission denied")
    return InternalFileWriteError("WRITE_FAILED", "file operation failed")


@contextmanager
def _parent_dir(workspace_id: str, parts: Sequence[str], *, create: bool) -> Iterator[tuple[int, str]]:
    try: safe = validate_formal_id(workspace_id, "workspace_id")
    except ValueError as exc: raise InternalFileWriteError("INVALID_ARGUMENT", "workspace_id invalid") from exc
    if not parts: raise InternalFileWriteError("PATH_INVALID", "empty path")
    root_fd = ws_fd = -1; opened: list[int] = []
    try:
        root_fd = os.open(str(settings.workspaces_path), os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try: ws_fd = os.open(safe, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root_fd)
        except OSError as exc: raise _map(exc) from exc
        cur = ws_fd
        for seg in parts[:-1]:
            try: nxt = os.open(seg, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cur)
            except OSError as exc:
                if not create or exc.errno not in (errno.ENOENT, errno.ENOTDIR): raise _map(exc) from exc
                try: os.mkdir(seg, 0o700, dir_fd=cur)
                except OSError as mk:
                    if mk.errno != errno.EEXIST: raise _map(mk) from mk
                try: nxt = os.open(seg, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=cur)
                except OSError as op: raise _map(op) from op
            opened.append(nxt); cur = nxt
        yield cur, parts[-1]
    finally:
        for fd in reversed(opened):
            try: os.close(fd)
            except OSError: pass
        for fd in (ws_fd, root_fd):
            if fd >= 0:
                try: os.close(fd)
                except OSError: pass


def _read_fd(parent: int, leaf: str, *, max_bytes: int) -> tuple[str, int]:
    try: fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
    except OSError as exc: raise _map(exc) from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode): raise InternalFileWriteError("NOT_REGULAR_FILE", "not a regular file")
        if st.st_size > max_bytes:
            raise InternalFileWriteError("FILE_TOO_LARGE", "file exceeds configured size limit")
        chunks: list[bytes] = []
        total = 0
        while True:
            b = os.read(fd, _MAX_MEMORY_READ_CHUNK)
            if not b: break
            total += len(b)
            if total > max_bytes:
                raise InternalFileWriteError("FILE_TOO_LARGE", "file exceeds configured size limit")
            chunks.append(b)
        try: text = b"".join(chunks).decode("utf-8", "strict")
        except UnicodeDecodeError as exc: raise InternalFileWriteError("INVALID_ENCODING", "file is not UTF-8 text") from exc
        return text, st.st_size
    except OSError as exc: raise _map(exc) from exc
    finally: os.close(fd)


def _atomic_replace(parent: int, leaf: str, data: bytes) -> None:
    fd = -1; name = None
    try:
        try:
            existing = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(existing.st_mode):
                raise InternalFileWriteError("SYMLINK_REJECTED", "symlink rejected")
            if not stat.S_ISREG(existing.st_mode):
                raise InternalFileWriteError("NOT_REGULAR_FILE", "not a regular file")
        except FileNotFoundError:
            pass
        # mkstemp is pathname-based only inside the trusted workspace parent fd;
        # use an exclusive random leaf, then fd-relative replace.
        for _ in range(8):
            candidate = f".sandbox-write-{os.urandom(12).hex()}"
            try:
                fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=parent)
                name = candidate; break
            except FileExistsError: continue
        if fd < 0 or name is None: raise InternalFileWriteError("WRITE_FAILED", "unable to allocate temporary file")
        with os.fdopen(fd, "wb", closefd=True) as f:
            fd = -1; f.write(data); f.flush(); os.fsync(f.fileno())
        try: os.replace(name, leaf, src_dir_fd=parent, dst_dir_fd=parent)
        except OSError as exc: raise _map(exc) from exc
        name = None
    finally:
        if fd >= 0:
            try: os.close(fd)
            except OSError: pass
        if name is not None:
            try: os.unlink(name, dir_fd=parent)
            except OSError: pass


class InternalFileWriter:
    def write(self, *, workspace_id: str, path: str, content: str, encoding: str = "utf-8") -> dict[str, object]:
        parts = _parts(path)
        if type(content) is not str:
            raise InternalFileWriteError("INVALID_ARGUMENT", "content must be a string")
        if encoding not in ("utf-8", "base64"):
            raise InternalFileWriteError("INVALID_ARGUMENT", "encoding must be utf-8 or base64")
        try:
            data = content.encode("utf-8", "strict") if encoding == "utf-8" else base64.b64decode(content.encode("ascii"), validate=True)
        except (UnicodeEncodeError, ValueError, binascii.Error) as exc:
            raise InternalFileWriteError("INVALID_ARGUMENT", "content encoding invalid") from exc
        max_bytes = max(0, int(settings.max_file_size_mb)) * 1024 * 1024
        if len(data) > max_bytes:
            raise InternalFileWriteError("FILE_TOO_LARGE", "content exceeds configured size limit")
        try:
            safe_workspace_id = validate_formal_id(workspace_id, "workspace_id")
        except ValueError as exc:
            raise InternalFileWriteError("INVALID_ARGUMENT", "workspace_id invalid") from exc
        with _workspace_lock(safe_workspace_id):
            with _parent_dir(safe_workspace_id, parts, create=True) as (parent, leaf):
                existing = 0
                try:
                    st = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
                    if stat.S_ISLNK(st.st_mode):
                        raise InternalFileWriteError("SYMLINK_REJECTED", "symlink rejected")
                    if not stat.S_ISREG(st.st_mode):
                        raise InternalFileWriteError("NOT_REGULAR_FILE", "not a regular file")
                    existing = st.st_size
                except FileNotFoundError:
                    pass
                self._enforce_workspace_quota(safe_workspace_id, existing, len(data))
                _atomic_replace(parent, leaf, data)
        digest = hashlib.sha256(data).hexdigest()
        return {"path": path, "size": len(data), "hash": digest, "version": digest}

    def edit(self, *, workspace_id: str, path: str, old_text: str, new_text: str, expected_hash: str | None, expected_version: str | None) -> dict[str, object]:
        parts = _parts(path)
        try:
            safe_workspace_id = validate_formal_id(workspace_id, "workspace_id")
        except ValueError as exc:
            raise InternalFileWriteError("INVALID_ARGUMENT", "workspace_id invalid") from exc
        max_bytes = max(0, int(settings.max_file_size_mb)) * 1024 * 1024
        with _workspace_lock(safe_workspace_id):
            with _parent_dir(safe_workspace_id, parts, create=False) as (parent, leaf):
                before, before_size = _read_fd(parent, leaf, max_bytes=max_bytes)
                before_hash = hashlib.sha256(before.encode("utf-8")).hexdigest()
                if (expected_hash is not None and expected_hash != before_hash) or (expected_version is not None and expected_version != before_hash):
                    raise InternalFileWriteError("FILE_VERSION_CONFLICT", "file version precondition failed")
                count = before.count(old_text) if old_text else 0
                if count == 0: raise InternalFileWriteError("FILE_TEXT_NOT_FOUND", "old text not found")
                if count != 1: raise InternalFileWriteError("FILE_MULTIPLE_MATCH", "old text matched multiple times")
                after = before.replace(old_text, new_text, 1)
                after_bytes = after.encode("utf-8")
                if len(after_bytes) > max_bytes:
                    raise InternalFileWriteError("FILE_TOO_LARGE", "content exceeds configured size limit")
                # Re-check immediately before replacement; never overwrite a changed inode.
                current, _ = _read_fd(parent, leaf, max_bytes=max_bytes)
                if hashlib.sha256(current.encode("utf-8")).hexdigest() != before_hash:
                    raise InternalFileWriteError("FILE_VERSION_CONFLICT", "file changed during edit")
                self._enforce_workspace_quota(safe_workspace_id, before_size, len(after_bytes))
                _atomic_replace(parent, leaf, after_bytes)
        digest = hashlib.sha256(after_bytes).hexdigest()
        return {"path": path, "hash": digest, "version": digest, "beforeHash": before_hash}

    @staticmethod
    def _enforce_workspace_quota(workspace_id: str, existing_bytes: int, new_bytes: int) -> None:
        quota_bytes = max(0, int(settings.workspace_quota_mb)) * 1024 * 1024
        workspace = Path(settings.workspaces_path) / workspace_id
        try:
            current = measure_tree_bounded(workspace).size_bytes
        except ChildQuotaMeasureError as exc:
            raise InternalFileWriteError(
                "WORKSPACE_QUOTA_ENFORCEMENT_FAILED",
                "workspace quota measurement failed",
            ) from exc
        projected = max(0, current - max(0, existing_bytes)) + new_bytes
        if projected > quota_bytes:
            raise InternalFileWriteError(
                "WORKSPACE_QUOTA_EXCEEDED",
                "workspace quota exceeded",
            )


__all__ = ["InternalFileWriteError", "InternalFileWriter"]
