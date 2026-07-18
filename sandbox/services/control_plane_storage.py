"""Sandbox control-plane storage — not bound into untrusted workspace.

PR-09 security roots (only Sandbox API process should mount/see these):

* ``artifacts_root`` — immutable artifact snapshots (download source of truth)
* ``control_root`` — dataset staging parts + quota reservations/locks

Workspace reads/publishes use openat dirfd chains (O_DIRECTORY|O_NOFOLLOW).
Never lstat-then-absolute-path-open across a TOCTOU window. All writes are
write-all (EINTR / short-write safe). Platforms without dir_fd rename fail closed.
"""

from __future__ import annotations

import errno
import hashlib
import os
import stat
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

from sandbox.config import settings

_CHUNK = 64 * 1024
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_WRITE_EXCL = (
    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
)


class ControlPlaneError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def artifacts_root() -> Path:
    return Path(settings.artifacts_root)


def control_root() -> Path:
    return Path(settings.control_root)


def ensure_control_roots() -> None:
    """Create control-plane roots with restrictive permissions (API process only)."""
    for root in (artifacts_root(), control_root()):
        root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(root, 0o700)
        except OSError:
            pass


def _validate_seg(seg: str, *, field: str = "path") -> str:
    if not seg or not isinstance(seg, str):
        raise ControlPlaneError("PATH_INVALID", f"invalid {field}")
    if seg in (".", "..") or "/" in seg or "\\" in seg or "\x00" in seg:
        raise ControlPlaneError("PATH_INVALID", f"invalid {field} segment")
    return seg


def artifact_blob_rel(org_id: str, artifact_id: str) -> tuple[str, ...]:
    return (
        _validate_seg(org_id, field="org_id"),
        _validate_seg(artifact_id, field="artifact_id"),
        "blob",
    )


def artifact_blob_path(org_id: str, artifact_id: str) -> Path:
    parts = artifact_blob_rel(org_id, artifact_id)
    return artifacts_root().joinpath(*parts)


def dataset_staging_rel(
    workspace_id: str, dataset_id: str, safe_name: str
) -> tuple[str, ...]:
    return (
        "datasets",
        _validate_seg(workspace_id, field="workspace_id"),
        _validate_seg(dataset_id, field="dataset_id"),
        f"{_validate_seg(safe_name, field='filename')}.part",
    )


def dataset_staging_path(
    workspace_id: str, dataset_id: str, safe_name: str
) -> Path:
    return control_root().joinpath(
        *dataset_staging_rel(workspace_id, dataset_id, safe_name)
    )


def quota_workspace_dir(workspace_id: str) -> Path:
    return control_root() / "quota" / _validate_seg(workspace_id, field="workspace_id")


@dataclass(frozen=True)
class FileIdentity:
    st_dev: int
    st_ino: int
    st_size: int
    st_mtime_ns: int
    st_nlink: int
    sha256: str | None = None

    def matches_stat(self, st: os.stat_result, *, check_mtime: bool = True) -> bool:
        if (
            int(st.st_dev) != self.st_dev
            or int(st.st_ino) != self.st_ino
            or int(st.st_size) != self.st_size
            or int(st.st_nlink) != self.st_nlink
        ):
            return False
        if check_mtime:
            mtime_ns = int(
                getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))
            )
            if mtime_ns != self.st_mtime_ns:
                return False
        return True

    def same_inode(self, st: os.stat_result) -> bool:
        return int(st.st_dev) == self.st_dev and int(st.st_ino) == self.st_ino

    def to_dict(self) -> dict:
        return {
            "st_dev": self.st_dev,
            "st_ino": self.st_ino,
            "st_size": self.st_size,
            "st_mtime_ns": self.st_mtime_ns,
            "st_nlink": self.st_nlink,
            "sha256": self.sha256,
        }

    @classmethod
    def from_stat(
        cls, st: os.stat_result, *, sha256: str | None = None
    ) -> "FileIdentity":
        return cls(
            st_dev=int(st.st_dev),
            st_ino=int(st.st_ino),
            st_size=int(st.st_size),
            st_mtime_ns=int(
                getattr(st, "st_mtime_ns", int(st.st_mtime * 1_000_000_000))
            ),
            st_nlink=int(st.st_nlink),
            sha256=sha256,
        )

    @classmethod
    def from_dict(cls, d: dict | None) -> "FileIdentity | None":
        if not d:
            return None
        try:
            return cls(
                st_dev=int(d["st_dev"]),
                st_ino=int(d["st_ino"]),
                st_size=int(d["st_size"]),
                st_mtime_ns=int(d["st_mtime_ns"]),
                st_nlink=int(d.get("st_nlink", 1)),
                sha256=d.get("sha256"),
            )
        except (KeyError, TypeError, ValueError):
            return None


def write_all(fd: int, data: bytes | memoryview) -> int:
    """Write entire buffer; handle EINTR and short writes. Returns bytes written."""
    if not data:
        return 0
    view = memoryview(data) if not isinstance(data, memoryview) else data
    total = 0
    length = len(view)
    while total < length:
        try:
            n = os.write(fd, view[total:])
        except InterruptedError:
            continue
        except OSError as exc:
            if exc.errno == errno.EINTR:
                continue
            raise
        if n is None or n <= 0:
            raise ControlPlaneError(
                "WRITE_FAILED",
                "short write (zero bytes) while writing control/workspace file",
                status=500,
            )
        total += int(n)
    return total


def _mkdir_nofollow(parent: Path, name: str, *, mode: int = 0o700) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    target = parent / name
    try:
        os.mkdir(str(target), mode)
    except FileExistsError:
        st = os.lstat(str(target))
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise ControlPlaneError(
                "PATH_INVALID", "control-plane path is not a directory"
            )
    return target


def ensure_artifact_parent(org_id: str, artifact_id: str) -> Path:
    ensure_control_roots()
    org_dir = _mkdir_nofollow(artifacts_root(), _validate_seg(org_id, field="org_id"))
    art_dir = _mkdir_nofollow(org_dir, _validate_seg(artifact_id, field="artifact_id"))
    return art_dir


def ensure_dataset_staging_parent(workspace_id: str, dataset_id: str) -> Path:
    ensure_control_roots()
    root = _mkdir_nofollow(control_root(), "datasets")
    ws = _mkdir_nofollow(root, _validate_seg(workspace_id, field="workspace_id"))
    return _mkdir_nofollow(ws, _validate_seg(dataset_id, field="dataset_id"))


def ensure_quota_dir(workspace_id: str) -> Path:
    ensure_control_roots()
    root = _mkdir_nofollow(control_root(), "quota")
    return _mkdir_nofollow(root, _validate_seg(workspace_id, field="workspace_id"))


@contextmanager
def open_control_file_read(path: Path) -> Iterator[int]:
    """Open existing regular file for read with O_NOFOLLOW."""
    try:
        fd = os.open(str(path), _FILE_READ)
    except OSError as exc:
        if exc.errno in (errno.ENOENT, errno.ENOTDIR):
            raise ControlPlaneError(
                "FILE_NOT_FOUND", "control-plane file not found", status=404
            ) from exc
        if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)):
            raise ControlPlaneError(
                "SYMLINK_REJECTED", "symlink rejected in control-plane path"
            ) from exc
        raise ControlPlaneError(
            "OPEN_FAILED", "failed to open control-plane file"
        ) from exc
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ControlPlaneError("NOT_REGULAR_FILE", "not a regular file")
        yield fd
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def unlink_control_file(path: Path) -> None:
    """Unlink a control-plane regular file only (never follows symlink targets)."""
    try:
        st = os.lstat(str(path))
    except FileNotFoundError:
        return
    except OSError:
        return
    if stat.S_ISLNK(st.st_mode) or stat.S_ISREG(st.st_mode):
        try:
            os.unlink(str(path))
        except OSError:
            pass


def open_workspace_leaf_nofollow(
    workspace_path: Path, relative_parts: tuple[str, ...]
) -> tuple[int, os.stat_result]:
    """Walk workspace-relative parts with O_DIRECTORY|O_NOFOLLOW; return (fd, fstat).

    Caller must close *leaf* fd. Intermediate dir fds are closed before return.
    Never uses pathname open after a separate lstat of parent components.
    """
    if not relative_parts:
        raise ControlPlaneError("PATH_INVALID", "empty relative path")
    for seg in relative_parts:
        _validate_seg(seg)

    try:
        root_fd = os.open(
            str(workspace_path),
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        )
    except OSError as exc:
        raise ControlPlaneError("PATH_INVALID", "workspace root open failed") from exc

    dir_fd = root_fd
    opened_dirs: list[int] = [root_fd]
    leaf_fd = -1
    try:
        for seg in relative_parts[:-1]:
            try:
                next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError as exc:
                raise ControlPlaneError(
                    "PATH_INVALID", "path component rejected", status=403
                ) from exc
            opened_dirs.append(next_fd)
            dir_fd = next_fd
        leaf = relative_parts[-1]
        try:
            leaf_fd = os.open(leaf, _FILE_READ, dir_fd=dir_fd)
        except OSError as exc:
            if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)):
                raise ControlPlaneError(
                    "SYMLINK_REJECTED", "symlink rejected in workspace path", status=400
                ) from exc
            raise ControlPlaneError(
                "FILE_NOT_FOUND", "file not found", status=404
            ) from exc
        st = os.fstat(leaf_fd)
        if not stat.S_ISREG(st.st_mode):
            os.close(leaf_fd)
            leaf_fd = -1
            raise ControlPlaneError("NOT_REGULAR_FILE", "not a regular file")
        if int(st.st_nlink) > 1:
            os.close(leaf_fd)
            leaf_fd = -1
            raise ControlPlaneError(
                "HARDLINK_REJECTED", "multi-link file rejected", status=400
            )
        out_fd, out_st = leaf_fd, st
        leaf_fd = -1  # ownership transferred
        return out_fd, out_st
    finally:
        if leaf_fd >= 0:
            try:
                os.close(leaf_fd)
            except OSError:
                pass
        for fd in reversed(opened_dirs):
            try:
                os.close(fd)
            except OSError:
                pass


def stream_copy_hash_from_fd(
    src_fd: int,
    dest_final: Path,
    *,
    max_bytes: int,
    chunk_size: int = _CHUNK,
    source_identity: FileIdentity | None = None,
) -> tuple[str, int, FileIdentity]:
    """Stream-copy from an already-open safe leaf fd → control-plane dest.

    Validates source identity at start and end of copy (stable inode/size/mtime).
    Uses write-all; cleans tmp on any failure; never leaves truncated final.
    """
    ensure_control_roots()
    dest_final.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest_final.with_name(dest_final.name + ".tmp")
    try:
        st_tmp = os.lstat(str(tmp))
        if stat.S_ISREG(st_tmp.st_mode) or stat.S_ISLNK(st_tmp.st_mode):
            os.unlink(str(tmp))
    except FileNotFoundError:
        pass
    except OSError:
        pass

    try:
        st0 = os.fstat(src_fd)
    except OSError as exc:
        raise ControlPlaneError(
            "SOURCE_OPEN_FAILED", "failed to fstat source fd", status=400
        ) from exc
    if not stat.S_ISREG(st0.st_mode):
        raise ControlPlaneError("NOT_REGULAR_FILE", "source is not a regular file")
    if int(st0.st_nlink) > 1:
        raise ControlPlaneError(
            "HARDLINK_REJECTED", "source must not be multi-linked", status=400
        )
    ident0 = FileIdentity.from_stat(st0)
    if source_identity is not None and not source_identity.same_inode(st0):
        raise ControlPlaneError(
            "IDENTITY_MISMATCH",
            "source identity changed before copy",
            status=409,
        )
    if source_identity is not None and not source_identity.matches_stat(st0):
        raise ControlPlaneError(
            "IDENTITY_MISMATCH",
            "source identity changed before copy",
            status=409,
        )

    # Rewind if prior reads occurred
    try:
        os.lseek(src_fd, 0, os.SEEK_SET)
    except OSError:
        pass

    h = hashlib.sha256()
    total = 0
    out_fd = -1
    try:
        out_fd = os.open(str(tmp), _FILE_WRITE_EXCL, 0o600)
        while True:
            try:
                chunk = os.read(src_fd, chunk_size)
            except OSError as exc:
                if exc.errno == errno.EINTR:
                    continue
                raise
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ControlPlaneError(
                    "TOO_LARGE", "file exceeds max size", status=413
                )
            h.update(chunk)
            write_all(out_fd, chunk)
        # Declare vs written
        try:
            st_out = os.fstat(out_fd)
        except OSError as exc:
            raise ControlPlaneError(
                "WRITE_FAILED", "failed to fstat output", status=500
            ) from exc
        if int(st_out.st_size) != total:
            raise ControlPlaneError(
                "SIZE_MISMATCH",
                f"written size {st_out.st_size} != streamed total {total}",
                status=500,
            )
        os.fsync(out_fd)
    except Exception:
        if out_fd >= 0:
            try:
                os.close(out_fd)
            except OSError:
                pass
            out_fd = -1
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        raise
    finally:
        if out_fd >= 0:
            try:
                os.close(out_fd)
            except OSError:
                pass

    # Source still same identity after full read
    try:
        st1 = os.fstat(src_fd)
    except OSError as exc:
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        raise ControlPlaneError(
            "IDENTITY_MISMATCH", "source vanished during copy", status=409
        ) from exc
    if not ident0.matches_stat(st1):
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        raise ControlPlaneError(
            "IDENTITY_MISMATCH",
            "source identity changed during copy",
            status=409,
        )

    try:
        os.replace(str(tmp), str(dest_final))
    except OSError as exc:
        try:
            os.unlink(str(tmp))
        except OSError:
            pass
        raise ControlPlaneError(
            "PUBLISH_FAILED", "atomic snapshot rename failed", status=500
        ) from exc

    try:
        dir_fd = os.open(str(dest_final.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass

    with open_control_file_read(dest_final) as rfd:
        st2 = os.fstat(rfd)
    digest = h.hexdigest()
    if int(st2.st_size) != total:
        try:
            os.unlink(str(dest_final))
        except OSError:
            pass
        raise ControlPlaneError("SIZE_MISMATCH", "snapshot size mismatch", status=500)
    return digest, total, FileIdentity.from_stat(st2, sha256=digest)


def stream_copy_hash_to_control(
    src_path: Path,
    dest_final: Path,
    *,
    max_bytes: int,
    chunk_size: int = _CHUNK,
    workspace_path: Path | None = None,
    relative_parts: tuple[str, ...] | None = None,
) -> tuple[str, int, FileIdentity]:
    """Copy source to control-plane snapshot.

    Prefer *workspace_path* + *relative_parts* (dirfd walk). Absolute *src_path*
    open is only for trusted control-plane/test sources with O_NOFOLLOW.
    """
    if workspace_path is not None and relative_parts is not None:
        src_fd, st = open_workspace_leaf_nofollow(workspace_path, relative_parts)
        try:
            return stream_copy_hash_from_fd(
                src_fd,
                dest_final,
                max_bytes=max_bytes,
                chunk_size=chunk_size,
                source_identity=FileIdentity.from_stat(st),
            )
        finally:
            try:
                os.close(src_fd)
            except OSError:
                pass

    # Trusted path open (control-plane or unit-test file) with O_NOFOLLOW only.
    try:
        src_fd = os.open(str(src_path), _FILE_READ)
    except OSError as exc:
        raise ControlPlaneError(
            "SOURCE_OPEN_FAILED", "failed to open source file", status=400
        ) from exc
    try:
        st = os.fstat(src_fd)
        return stream_copy_hash_from_fd(
            src_fd,
            dest_final,
            max_bytes=max_bytes,
            chunk_size=chunk_size,
            source_identity=FileIdentity.from_stat(st),
        )
    finally:
        try:
            os.close(src_fd)
        except OSError:
            pass


def secure_publish_to_workspace(
    *,
    src_control_path: Path,
    workspace_path: Path,
    relative_parts: tuple[str, ...],
    max_bytes: int,
) -> FileIdentity:
    """Copy control-plane file into workspace via openat chain (no symlink parents).

    Write-all + size verification before atomic rename. Platforms without
    dir_fd replace fail closed (no path-join fallback).
    """
    if not relative_parts:
        raise ControlPlaneError("PATH_INVALID", "empty publish path")
    for seg in relative_parts:
        _validate_seg(seg)

    try:
        root_fd = os.open(
            str(workspace_path),
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        )
    except OSError as exc:
        raise ControlPlaneError("PATH_INVALID", "workspace root open failed") from exc

    dir_fd = root_fd
    opened_dirs: list[int] = [root_fd]
    try:
        for seg in relative_parts[:-1]:
            next_fd = -1
            try:
                next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError as exc:
                if exc.errno in (errno.ELOOP, getattr(errno, "EMLINK", errno.ELOOP)):
                    raise ControlPlaneError(
                        "SYMLINK_REJECTED",
                        "symlink rejected in publish parent",
                        status=403,
                    ) from exc
                if exc.errno in (errno.ENOENT, errno.ENOTDIR):
                    try:
                        os.mkdir(seg, 0o755, dir_fd=dir_fd)
                    except FileExistsError:
                        pass
                    except OSError as exc2:
                        raise ControlPlaneError(
                            "PATH_INVALID", "cannot create parent", status=403
                        ) from exc2
                    try:
                        next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
                    except OSError as exc2:
                        raise ControlPlaneError(
                            "PATH_INVALID",
                            "parent is not a safe directory",
                            status=403,
                        ) from exc2
                else:
                    raise ControlPlaneError(
                        "PATH_INVALID", "parent walk rejected", status=403
                    ) from exc
            opened_dirs.append(next_fd)
            dir_fd = next_fd

        leaf = relative_parts[-1]
        tmp_name = f".{leaf}.publish.tmp"
        try:
            os.unlink(tmp_name, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        except OSError:
            pass

        total = 0
        out_fd = -1
        with open_control_file_read(src_control_path) as src_fd:
            try:
                out_fd = os.open(
                    tmp_name,
                    _FILE_WRITE_EXCL,
                    0o644,
                    dir_fd=dir_fd,
                )
            except OSError as exc:
                raise ControlPlaneError(
                    "OPEN_FAILED", "failed to create workspace publish temp"
                ) from exc
            try:
                while True:
                    try:
                        chunk = os.read(src_fd, _CHUNK)
                    except OSError as exc:
                        if exc.errno == errno.EINTR:
                            continue
                        raise
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > max_bytes:
                        raise ControlPlaneError(
                            "TOO_LARGE", "publish exceeds max size", status=413
                        )
                    write_all(out_fd, chunk)
                st_out = os.fstat(out_fd)
                if int(st_out.st_size) != total:
                    raise ControlPlaneError(
                        "SIZE_MISMATCH",
                        f"publish written {st_out.st_size} != total {total}",
                        status=500,
                    )
                os.fsync(out_fd)
            except Exception:
                if out_fd >= 0:
                    try:
                        os.close(out_fd)
                    except OSError:
                        pass
                    out_fd = -1
                try:
                    os.unlink(tmp_name, dir_fd=dir_fd)
                except OSError:
                    pass
                raise
            finally:
                if out_fd >= 0:
                    try:
                        os.close(out_fd)
                    except OSError:
                        pass

        # Atomic replace — fail closed if dir_fd unsupported
        try:
            os.replace(tmp_name, leaf, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
        except NotImplementedError as exc:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            raise ControlPlaneError(
                "PLATFORM_UNSUPPORTED",
                "dirfd atomic rename required; refusing unsafe path-join fallback",
                status=500,
            ) from exc
        except TypeError as exc:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            raise ControlPlaneError(
                "PLATFORM_UNSUPPORTED",
                "dirfd atomic rename required; refusing unsafe path-join fallback",
                status=500,
            ) from exc
        except OSError as exc:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            raise ControlPlaneError(
                "PUBLISH_FAILED", "atomic publish failed"
            ) from exc

        try:
            leaf_fd = os.open(leaf, _FILE_READ, dir_fd=dir_fd)
        except OSError as exc:
            raise ControlPlaneError(
                "PUBLISH_FAILED", "published leaf missing"
            ) from exc
        try:
            st = os.fstat(leaf_fd)
            if not stat.S_ISREG(st.st_mode):
                raise ControlPlaneError(
                    "NOT_REGULAR_FILE", "published leaf invalid"
                )
            if int(st.st_size) != total:
                # Remove truncated/wrong leaf via same dirfd
                try:
                    os.close(leaf_fd)
                    leaf_fd = -1
                    os.unlink(leaf, dir_fd=dir_fd)
                except OSError:
                    pass
                raise ControlPlaneError(
                    "SIZE_MISMATCH",
                    "published leaf size does not match streamed total",
                    status=500,
                )
            return FileIdentity.from_stat(st)
        finally:
            if leaf_fd >= 0:
                try:
                    os.close(leaf_fd)
                except OSError:
                    pass
    finally:
        for fd in reversed(opened_dirs):
            try:
                os.close(fd)
            except OSError:
                pass


def unlink_workspace_leaf_if_matches(
    *,
    workspace_path: Path,
    relative_parts: tuple[str, ...],
    expected: FileIdentity,
) -> bool:
    """Delete a just-published leaf only if still the same identity (dirfd-safe).

    Returns True if unlinked. Never follows symlinks; never path-join unlink.
    """
    if not relative_parts:
        return False
    for seg in relative_parts:
        try:
            _validate_seg(seg)
        except ControlPlaneError:
            return False

    try:
        root_fd = os.open(
            str(workspace_path),
            os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC,
        )
    except OSError:
        return False

    dir_fd = root_fd
    opened: list[int] = [root_fd]
    try:
        for seg in relative_parts[:-1]:
            try:
                next_fd = os.open(seg, _DIR_FLAGS, dir_fd=dir_fd)
            except OSError:
                return False
            opened.append(next_fd)
            dir_fd = next_fd
        leaf = relative_parts[-1]
        try:
            leaf_fd = os.open(leaf, _FILE_READ, dir_fd=dir_fd)
        except OSError:
            return False
        try:
            st = os.fstat(leaf_fd)
            # Match inode + size (mtime may race); require same file we published
            if not (
                int(st.st_dev) == expected.st_dev
                and int(st.st_ino) == expected.st_ino
                and int(st.st_size) == expected.st_size
            ):
                return False
        finally:
            try:
                os.close(leaf_fd)
            except OSError:
                pass
        try:
            os.unlink(leaf, dir_fd=dir_fd)
            return True
        except OSError:
            return False
    finally:
        for fd in reversed(opened):
            try:
                os.close(fd)
            except OSError:
                pass
