"""Attachment upload manager — isolated paths, whitelist, idempotency.

Attachments land under ``uploads/{attachment_id}/{sanitized_name}`` so same
display names never overwrite each other. Idempotency keys are stored in a
workspace-local JSON index (MVP; no separate DB table required).
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sandbox.config import settings
from sandbox.security.path_validation import enforce_path_within_workspace
from sandbox.services.file_manager import workspace_size_bytes


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

# Common text / code / images / pdf / office + limited archives (no auto-extract).
# RAR / 7z intentionally excluded (parent task P-00F1).
_ALLOWED_EXTENSIONS: frozenset[str] = frozenset({
    # text / data
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".xml",
    ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".log", ".env",
    # code
    ".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".java", ".go", ".rs",
    ".rb", ".php", ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".swift", ".kt",
    ".scala", ".sh", ".bash", ".zsh", ".ps1", ".sql", ".r", ".m", ".mm",
    ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".lua",
    ".pl", ".pm", ".ex", ".exs", ".erl", ".hs", ".clj", ".dockerfile",
    ".ipynb", ".graphql", ".gql", ".proto", ".tf", ".hcl",
    # images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico",
    ".tif", ".tiff",
    # documents
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".odt", ".ods", ".odp", ".rtf", ".epub",
    # archives (stored as-is; never auto-extracted on upload)
    ".zip", ".tar", ".gz", ".tgz", ".tar.gz",
})

_COMPOUND_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz")

_IDEM_DIR = ".attachments"
_IDEM_FILE = "idempotency.json"
_META_FILE = "meta.json"


class AttachmentError(Exception):
    """Structured attachment failure with stable business code + HTTP status."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def extension_of(filename: str) -> str:
    """Return the lowercase extension, including compound forms like ``.tar.gz``."""
    lower = (filename or "").lower().strip()
    for compound in _COMPOUND_SUFFIXES:
        if lower.endswith(compound):
            return compound
    # bare ".gz" etc.
    suffix = Path(lower).suffix
    return suffix


def is_allowed_extension(filename: str) -> bool:
    ext = extension_of(filename)
    if not ext:
        return False
    return ext in _ALLOWED_EXTENSIONS


def sanitize_filename(name: str) -> str:
    """Strip path components and dangerous characters; keep a usable basename."""
    base = Path(name or "upload").name
    base = base.replace("\x00", "")
    base = re.sub(r"[\x00-\x1f\x7f]", "", base)
    base = base.replace("..", "_").strip().strip(".")
    if not base:
        base = "upload"
    # Cap length while preserving extension when possible
    if len(base) > 200:
        ext = extension_of(base)
        stem = base[: 200 - len(ext)] if ext else base[:200]
        base = f"{stem}{ext}" if ext and not stem.endswith(ext) else stem
    return base


def new_attachment_id() -> str:
    return f"att_{uuid.uuid4().hex}"


def new_idempotency_key() -> str:
    return f"idem_{uuid.uuid4().hex}"


class AttachmentManager:
    """Isolated attachment storage + idempotent commit for a workspace."""

    def logical_path(self, attachment_id: str, sanitized_name: str) -> str:
        return f"uploads/{attachment_id}/{sanitized_name}"

    def _idem_path(self, workspace_path: str) -> Path:
        root = Path(workspace_path) / _IDEM_DIR
        root.mkdir(parents=True, exist_ok=True)
        return root / _IDEM_FILE

    def _load_idempotency(self, workspace_path: str) -> dict:
        path = self._idem_path(workspace_path)
        if not path.is_file():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}

    def _save_idempotency(self, workspace_path: str, data: dict) -> None:
        path = self._idem_path(workspace_path)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=None, sort_keys=True), encoding="utf-8")
        os.replace(tmp, path)

    def lookup_idempotency(
        self, workspace_path: str, idempotency_key: str | None,
    ) -> dict | None:
        if not idempotency_key:
            return None
        store = self._load_idempotency(workspace_path)
        entry = store.get(idempotency_key)
        if not entry or not isinstance(entry, dict):
            return None
        # Ensure file still exists
        rel = entry.get("path")
        if not rel:
            return None
        try:
            safe = enforce_path_within_workspace(workspace_path, rel)
        except PermissionError:
            return None
        if not safe.is_file():
            return None
        return entry

    def validate_filename(self, filename: str) -> str:
        """Sanitize + whitelist; raise AttachmentError on deny."""
        sanitized = sanitize_filename(filename)
        if not is_allowed_extension(sanitized):
            ext = extension_of(sanitized) or "(none)"
            raise AttachmentError(
                "attachment_type_denied",
                f"File type not allowed: {ext}",
                status=400,
            )
        return sanitized

    def max_file_bytes(self) -> int:
        return settings.max_file_size_mb * 1024 * 1024

    def max_turn_bytes(self) -> int:
        return settings.max_turn_attachment_mb * 1024 * 1024

    def max_attachments_per_turn(self) -> int:
        return settings.max_attachments_per_turn

    def open_temp_upload(
        self, workspace_path: str, attachment_id: str, sanitized_name: str,
    ) -> tuple[Path, Path, object]:
        """Create target dir + open a temp file for streaming.

        Returns ``(final_path, temp_path, file_handle)``. Caller must close
        the handle and either commit or abort.
        """
        rel = self.logical_path(attachment_id, sanitized_name)
        final = enforce_path_within_workspace(workspace_path, rel)
        final.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(
            dir=str(final.parent), prefix=".upload_", suffix=".tmp",
        )
        tmp_path = Path(tmp_name)
        handle = os.fdopen(fd, "wb")
        return final, tmp_path, handle

    def abort_temp(self, temp_path: Path | None, handle=None) -> None:
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

    def commit_upload(
        self,
        workspace_path: str,
        *,
        attachment_id: str,
        sanitized_name: str,
        original_name: str,
        final_path: Path,
        temp_path: Path,
        size: int,
        idempotency_key: str | None,
        mime_type: str | None = None,
    ) -> dict:
        """Quota-check, atomically replace, record idempotency, return response dict."""
        max_bytes = self.max_file_bytes()
        if size > max_bytes:
            self.abort_temp(temp_path)
            raise AttachmentError(
                "attachment_too_large",
                f"File exceeds max size of {settings.max_file_size_mb}MB",
                status=413,
            )

        # Workspace quota (temp lives under final parent so count carefully)
        quota_bytes = settings.workspace_quota_mb * 1024 * 1024
        current = workspace_size_bytes(workspace_path)
        # Temp file is already under workspace — current includes it.
        # After replace, size stays the same (temp → final). If final existed,
        # replace would free nothing extra; for new attachments final does not exist.
        if current > quota_bytes:
            self.abort_temp(temp_path)
            raise AttachmentError(
                "workspace_quota_exceeded",
                f"Workspace quota exceeded: usage {current} bytes, "
                f"quota {settings.workspace_quota_mb}MB",
                status=413,
            )

        try:
            os.replace(str(temp_path), str(final_path))
        except OSError as exc:
            self.abort_temp(temp_path)
            raise AttachmentError(
                "upload_incomplete",
                f"Failed to commit upload: {exc}",
                status=500,
            ) from exc

        rel = self.logical_path(attachment_id, sanitized_name)
        mime = mime_type or "application/octet-stream"
        upload_time = _now_iso()
        entry = {
            "attachment_id": attachment_id,
            "path": rel,
            "name": original_name or sanitized_name,
            "filename": original_name or sanitized_name,
            "sanitized_name": sanitized_name,
            "size": size,
            "mime_type": mime,
            "upload_time": upload_time,
            "idempotency_key": idempotency_key,
        }

        # Persist per-attachment meta (best-effort)
        try:
            meta_path = final_path.parent / _META_FILE
            meta_path.write_text(json.dumps(entry), encoding="utf-8")
        except OSError:
            pass

        if idempotency_key:
            store = self._load_idempotency(workspace_path)
            store[idempotency_key] = entry
            try:
                self._save_idempotency(workspace_path, store)
            except OSError:
                pass

        return entry

    def write_bytes(
        self,
        workspace_path: str,
        content: bytes,
        *,
        filename: str,
        idempotency_key: str | None = None,
        mime_type: str | None = None,
        attachment_id: str | None = None,
    ) -> dict:
        """Convenience: write full bytes (tests / small payloads). Streams via temp."""
        if idempotency_key:
            existing = self.lookup_idempotency(workspace_path, idempotency_key)
            if existing:
                return existing

        sanitized = self.validate_filename(filename)
        att_id = attachment_id or new_attachment_id()
        final, tmp, handle = self.open_temp_upload(workspace_path, att_id, sanitized)
        try:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
            handle.close()
            handle = None
            return self.commit_upload(
                workspace_path,
                attachment_id=att_id,
                sanitized_name=sanitized,
                original_name=Path(filename or sanitized).name,
                final_path=final,
                temp_path=tmp,
                size=len(content),
                idempotency_key=idempotency_key,
                mime_type=mime_type,
            )
        except Exception:
            self.abort_temp(tmp, handle)
            raise


def normalize_attachment_context(item: dict | None) -> dict | None:
    """Normalize a message attachment dict to ADR §4.5 fields.

    Required/expected keys:
      attachment_id, filename, path (workspace), mime_type, size, upload_time
    """
    if not item or not isinstance(item, dict):
        return None
    attachment_id = item.get("attachment_id") or item.get("attachmentId") or ""
    path = item.get("path") or item.get("workspace_path") or ""
    filename = (
        item.get("filename")
        or item.get("name")
        or item.get("sanitized_name")
        or (Path(str(path)).name if path else "")
        or "upload"
    )
    if not attachment_id and not path:
        return None
    size_raw = item.get("size")
    try:
        size = int(size_raw) if size_raw is not None else 0
    except (TypeError, ValueError):
        size = 0
    return {
        "attachment_id": str(attachment_id) if attachment_id else None,
        "filename": str(filename),
        "path": str(path) if path else None,
        "workspace_path": str(path) if path else None,
        "mime_type": str(
            item.get("mime_type") or item.get("mimeType") or "application/octet-stream"
        ),
        "size": size,
        "upload_time": item.get("upload_time")
        or item.get("uploadTime")
        or item.get("created_at")
        or None,
    }


def format_attachment_prompt_block(attachments: list[dict] | None) -> str:
    """Build the explicit current-turn attachment section for the agent prompt.

    Agent must not scan uploads/; this block is the sole source of truth for
    which files belong to the current user turn.
    """
    normalized = []
    for raw in attachments or []:
        n = normalize_attachment_context(raw if isinstance(raw, dict) else None)
        if n:
            normalized.append(n)
    if not normalized:
        return ""
    lines = [
        "## Current-turn attachments",
        "",
        "The user attached the following file(s) for **this turn only**.",
        "Use the listed workspace paths with the `read` tool. "
        "Do **not** scan or list the entire `uploads/` directory to guess attachments.",
        "",
    ]
    for i, a in enumerate(normalized, 1):
        lines.append(
            f"{i}. **{a['filename']}**"
            f" — path=`{a.get('path') or a.get('workspace_path')}`"
            f" | mime=`{a.get('mime_type')}`"
            f" | size={a.get('size', 0)}"
            f" | attachment_id=`{a.get('attachment_id') or 'n/a'}`"
            f" | upload_time=`{a.get('upload_time') or 'n/a'}`"
        )
    lines.append("")
    return "\n".join(lines)


attachment_manager = AttachmentManager()
