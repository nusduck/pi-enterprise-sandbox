"""File Manager — read/write/preview/list files within workspace."""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path

from sandbox.config import settings
from sandbox.models import FileInfo, FileResponse
from sandbox.security.path_validation import enforce_path_within_workspace


class FileManager:
    """File operations within a session workspace.

    All paths are validated against workspace boundaries.
    """

    def read_file(
        self, workspace_path: str, user_path: str,
        offset: int | None = None, limit: int | None = None,
    ) -> FileResponse:
        safe = enforce_path_within_workspace(workspace_path, user_path)
        if not safe.is_file():
            return FileResponse(
                path=user_path, content="", size=0,
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
                    path=user_path, content=content, size=size,
                    truncated=True, mime_type=mime_type,
                )
            content = safe.read_text(encoding="utf-8", errors="replace")

        return FileResponse(
            path=user_path, content=content, size=size,
            truncated=False, mime_type=mime_type,
        )

    def write_file(
        self, workspace_path: str, user_path: str,
        content: str, mode: str = "w",
    ) -> FileResponse:
        safe = enforce_path_within_workspace(workspace_path, user_path)
        safe.parent.mkdir(parents=True, exist_ok=True)

        # Check file size limit
        content_bytes = content.encode("utf-8")
        max_bytes = settings.max_file_size_mb * 1024 * 1024
        if len(content_bytes) > max_bytes:
            raise ValueError(
                f"Content exceeds max file size of {settings.max_file_size_mb}MB"
            )

        with open(safe, "w" if mode == "w" else "a",
                  encoding="utf-8") as f:
            f.write(content)

        mime_type, _ = mimetypes.guess_type(str(safe))
        return FileResponse(
            path=user_path, content="", size=len(content_bytes),
            mime_type=mime_type or "text/plain",
        )

    def list_files(
        self, workspace_path: str, user_path: str = ".",
    ) -> list[FileInfo]:
        safe = enforce_path_within_workspace(workspace_path, user_path)
        if not safe.is_dir():
            return []

        files = []
        for entry in sorted(safe.iterdir()):
            try:
                stat = entry.stat()
                files.append(FileInfo(
                    name=entry.name,
                    path=str(entry.relative_to(Path(workspace_path))),
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
    ) -> bool:
        """Delete a file (not directory). Returns True if deleted."""
        safe = enforce_path_within_workspace(workspace_path, user_path)
        if safe.is_file():
            safe.unlink()
            return True
        return False

    def get_file_path(
        self, workspace_path: str, user_path: str,
    ) -> Path:
        return enforce_path_within_workspace(workspace_path, user_path)

    def get_binary_path(
        self, workspace_path: str, user_path: str,
    ) -> Path:
        """Resolve path for binary file download (no content read)."""
        return enforce_path_within_workspace(workspace_path, user_path)


file_manager = FileManager()
