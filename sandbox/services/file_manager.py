"""File Manager — read/write/preview/list files within workspace."""

from __future__ import annotations

import mimetypes
import os
import tempfile
from pathlib import Path

from sandbox.config import settings
from sandbox.models import FileInfo, FileResponse
from sandbox.paths import SandboxPath, SandboxPathScope
from sandbox.security.path_validation import (
    enforce_path_within_workspace,
    resolve_sandbox_path,
)


def workspace_size_bytes(path: str | Path) -> int:
    """Return total size in bytes of all files under *path* (recursive walk)."""
    root = Path(path)
    if not root.exists():
        return 0
    total = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            fp = Path(dirpath) / name
            try:
                if fp.is_file() and not fp.is_symlink():
                    total += fp.stat().st_size
                elif fp.is_file():
                    # Count symlink targets that still live inside the tree
                    total += fp.stat().st_size
            except OSError:
                continue
    return total


class FileManager:
    """File operations within a session workspace.

    All paths are validated against workspace boundaries.
    """

    @staticmethod
    def _resolve(
        workspace_path: str,
        user_path: str,
        temp_path: str | None,
    ) -> tuple[SandboxPath | None, Path]:
        if temp_path is None:
            return None, enforce_path_within_workspace(workspace_path, user_path)
        return resolve_sandbox_path(workspace_path, temp_path, user_path)

    def read_file(
        self, workspace_path: str, user_path: str,
        offset: int | None = None, limit: int | None = None,
        *, temp_path: str | None = None,
    ) -> FileResponse:
        parsed, safe = self._resolve(workspace_path, user_path, temp_path)
        public_path = parsed.as_public() if parsed is not None else user_path
        if not safe.is_file():
            return FileResponse(
                path=public_path, content="", size=0,
                mime_type="text/plain",
            )

        size = safe.stat().st_size
        mime_type, _ = mimetypes.guess_type(str(safe))
        mime_type = mime_type or "text/plain"

        if offset is not None and limit is not None:
            with open(safe, "r", encoding="utf-8", errors="replace") as f:
                # Skip to offset
                for _ in range(offset - 1):
                    next(f, None)
                lines = []
                for _ in range(limit):
                    try:
                        lines.append(next(f))
                    except StopIteration:
                        break
            content = "".join(lines)
        else:
            file_size = safe.stat().st_size
            max_read = settings.max_output_chars
            if file_size > max_read:
                with open(safe, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read(max_read)
                return FileResponse(
                    path=public_path, content=content, size=size,
                    truncated=True, mime_type=mime_type,
                )
            content = safe.read_text(encoding="utf-8", errors="replace")

        return FileResponse(
            path=public_path, content=content, size=size,
            truncated=False, mime_type=mime_type,
        )

    def write_file(
        self, workspace_path: str, user_path: str,
        content: str, mode: str = "w",
        *, temp_path: str | None = None,
    ) -> FileResponse:
        parsed, safe = self._resolve(workspace_path, user_path, temp_path)
        public_path = parsed.as_public() if parsed is not None else user_path
        safe.parent.mkdir(parents=True, exist_ok=True)

        # Check file size limit
        content_bytes = content.encode("utf-8")
        max_bytes = settings.max_file_size_mb * 1024 * 1024
        if len(content_bytes) > max_bytes:
            raise ValueError(
                f"Content exceeds max file size of {settings.max_file_size_mb}MB"
            )

        # Enforce workspace quota before writing
        storage_root = (
            temp_path
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else workspace_path
        )
        quota_mb = (
            settings.temp_quota_mb
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else settings.workspace_quota_mb
        )
        quota_name = (
            "Temp"
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else "Workspace"
        )
        self._enforce_storage_quota(
            str(storage_root), safe, len(content_bytes), mode=mode,
            quota_mb=quota_mb, quota_name=quota_name,
        )

        with open(safe, "w" if mode == "w" else "a",
                  encoding="utf-8") as f:
            f.write(content)

        mime_type, _ = mimetypes.guess_type(str(safe))
        return FileResponse(
            path=public_path, content="", size=len(content_bytes),
            mime_type=mime_type or "text/plain",
        )

    def write_binary(
        self, workspace_path: str, user_path: str, content: bytes,
        *, temp_path: str | None = None,
    ) -> FileResponse:
        """Write exact bytes to a workspace path (atomic temp + replace).

        Used by binary upload. Does not decode/re-encode content. Failures
        after quota checks leave the destination unchanged (no partial file).
        """
        if not isinstance(content, (bytes, bytearray)):
            raise TypeError("write_binary requires bytes content")

        parsed, safe = self._resolve(workspace_path, user_path, temp_path)
        public_path = parsed.as_public() if parsed is not None else user_path
        safe.parent.mkdir(parents=True, exist_ok=True)

        data = bytes(content)
        max_bytes = settings.max_file_size_mb * 1024 * 1024
        if len(data) > max_bytes:
            raise ValueError(
                f"Content exceeds max file size of {settings.max_file_size_mb}MB"
            )

        storage_root = (
            temp_path
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else workspace_path
        )
        quota_mb = (
            settings.temp_quota_mb
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else settings.workspace_quota_mb
        )
        quota_name = (
            "Temp"
            if parsed is not None and parsed.scope == SandboxPathScope.TEMP
            else "Workspace"
        )
        self._enforce_storage_quota(
            str(storage_root), safe, len(data), mode="w",
            quota_mb=quota_mb, quota_name=quota_name,
        )

        # Write to a temp file in the target directory, then atomically replace.
        fd, tmp_name = tempfile.mkstemp(
            dir=str(safe.parent), prefix=".upload_", suffix=".tmp",
        )
        try:
            with os.fdopen(fd, "wb") as tmp_file:
                tmp_file.write(data)
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
            os.replace(tmp_name, safe)
        except Exception:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise

        mime_type, _ = mimetypes.guess_type(str(safe))
        return FileResponse(
            path=public_path, content="", size=len(data),
            mime_type=mime_type or "application/octet-stream",
        )

    @staticmethod
    def _enforce_storage_quota(
        storage_path: str,
        target: Path,
        new_bytes: int,
        mode: str = "w",
        quota_mb: int | None = None,
        quota_name: str = "Workspace",
    ) -> None:
        """Raise ValueError if a workspace/temp write exceeds its quota."""
        effective_quota_mb = settings.workspace_quota_mb if quota_mb is None else quota_mb
        quota_bytes = effective_quota_mb * 1024 * 1024
        current = workspace_size_bytes(storage_path)

        existing = 0
        if target.is_file():
            try:
                existing = target.stat().st_size
            except OSError:
                existing = 0

        if mode == "a":
            projected = current + new_bytes
        else:
            # Overwrite replaces existing bytes for this file
            projected = current - existing + new_bytes

        if projected > quota_bytes:
            raise ValueError(
                f"{quota_name} quota exceeded: write would use ~{projected} bytes "
                f"but quota is {effective_quota_mb}MB "
                f"({quota_bytes} bytes). Current usage: {current} bytes."
            )

    def list_files(
        self, workspace_path: str, user_path: str = ".",
        *, temp_path: str | None = None,
    ) -> list[FileInfo]:
        _parsed, safe = self._resolve(workspace_path, user_path, temp_path)
        if not safe.is_dir():
            return []

        files = []
        for entry in sorted(safe.iterdir()):
            try:
                stat = entry.stat()
                files.append(FileInfo(
                    name=entry.name,
                    path=str(entry.relative_to(safe)),
                    is_dir=entry.is_dir(),
                    size=stat.st_size if entry.is_file() else 0,
                    modified_at=__import__("datetime").datetime.fromtimestamp(
                        stat.st_mtime
                    ).isoformat(),
                ))
            except (OSError, ValueError):
                continue

        return files

    def delete_file(
        self, workspace_path: str, user_path: str,
        *, temp_path: str | None = None,
    ) -> bool:
        """Delete a file (not directory). Returns True if deleted."""
        _parsed, safe = self._resolve(workspace_path, user_path, temp_path)
        if safe.is_file():
            safe.unlink()
            return True
        return False

    def get_file_path(
        self, workspace_path: str, user_path: str,
        *, temp_path: str | None = None,
    ) -> Path:
        return self._resolve(workspace_path, user_path, temp_path)[1]

    def get_binary_path(
        self, workspace_path: str, user_path: str,
        *, temp_path: str | None = None,
    ) -> Path:
        """Resolve path for binary file download (no content read)."""
        return self._resolve(workspace_path, user_path, temp_path)[1]


file_manager = FileManager()
