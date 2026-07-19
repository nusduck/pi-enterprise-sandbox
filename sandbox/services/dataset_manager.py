"""Dataset streaming — control-plane staging + secure workspace publish.

PR-09:
  Staging: control_root/datasets/{workspace_id}/{dataset_id}/{name}.part
  Formal READY path: datasets/{dataset_id}/{safe_filename} (workspace)
  Quota: control_root/quota/{workspace_id}/ (not in untrusted workspace)
  Non-READY: formal workspace path does not exist
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import stat
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterator

from sandbox.app.domain.types import OwnerScope
from sandbox.app.domain.ulid import new_ulid
from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.config import settings
from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    dataset_staging_path,
    ensure_control_roots,
    ensure_dataset_staging_parent,
    open_workspace_leaf_nofollow,
    secure_publish_to_workspace,
    unlink_control_file,
    unlink_workspace_leaf_if_matches,
)
from sandbox.services.dataset_store import (
    FormalDatasetDualWriter,
    FormalDatasetError,
    FormalDatasetRepositoryPort,
    try_wire_formal_dataset_repository,
)
from sandbox.services.workspace_quota_ledger import (
    QuotaExceededError,
    QuotaReservation,
    WorkspaceQuotaLedger,
    workspace_quota_ledger,
)

DATASET_STATUS_UPLOADING = "uploading"
DATASET_STATUS_READY = "ready"
DATASET_STATUS_FAILED = "failed"

_COMPOUND_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz")
_IDEMPOTENCY_OPERATION_PREFIX = "dataset.upload:"


class DatasetError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def extension_of(filename: str) -> str:
    lower = (filename or "").lower().strip()
    for compound in _COMPOUND_SUFFIXES:
        if lower.endswith(compound):
            return compound
    return Path(lower).suffix


def sanitize_dataset_filename(name: str) -> str:
    raw = name or "dataset"
    if "\x00" in raw:
        raise DatasetError("dataset_filename_invalid", "NUL in filename", status=400)
    if raw.startswith("/") or raw.startswith("\\") or (
        len(raw) > 1 and raw[1] == ":"
    ):
        raise DatasetError(
            "dataset_filename_invalid",
            "Absolute paths are not accepted",
            status=400,
        )
    base = Path(raw.replace("\\", "/")).name
    base = re.sub(r"[\x00-\x1f\x7f]", "", base)
    base = base.replace("..", "_").strip().strip(".")
    if not base or base in (".", ".."):
        base = "dataset"
    if len(base) > 200:
        ext = extension_of(base)
        stem = base[: 200 - len(ext)] if ext else base[:200]
        base = f"{stem}{ext}" if ext and not stem.endswith(ext) else stem
    return base


def logical_dataset_path(dataset_id: str, safe_filename: str) -> str:
    return f"datasets/{dataset_id}/{safe_filename}"


def staging_relative_path(dataset_id: str, safe_filename: str) -> str:
    """Logical name for tests — physical staging is under control_root."""
    return f".dataset-staging/{dataset_id}/{safe_filename}.part"


def normalize_dataset_idempotency_key(value: str | None) -> str | None:
    if value is None:
        return None
    key = str(value).strip()
    if not key:
        return None
    if len(key) > 255 or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in key):
        raise DatasetError(
            "dataset_idempotency_key_invalid",
            "Idempotency-Key must be 1..255 printable characters",
            status=400,
        )
    return key


def dataset_upload_request_hash(
    entry: "DatasetEntry",
    *,
    content_sha256: str,
    size_bytes: int,
) -> str:
    """Hash the logical file request, independent of multipart boundaries."""
    canonical = {
        "v": 1,
        "org_id": entry.org_id,
        "user_id": entry.user_id,
        "conversation_id": entry.conversation_id,
        "agent_session_id": entry.agent_session_id,
        "sandbox_session_id": entry.sandbox_session_id,
        "workspace_id": entry.workspace_id,
        "filename": entry.original_filename,
        "mime_type": entry.mime_type or "application/octet-stream",
        "size_bytes": int(size_bytes),
        "content_sha256": str(content_sha256).lower(),
    }
    encoded = json.dumps(
        canonical,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass
class DatasetEntry:
    dataset_id: str
    org_id: str
    user_id: str
    conversation_id: str
    agent_session_id: str
    sandbox_session_id: str
    original_filename: str
    stored_relative_path: str
    status: str
    created_at: str
    mime_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    completed_at: str | None = None
    workspace_id: str | None = None
    idempotency_key: str | None = None

    def to_public(self) -> dict[str, Any]:
        path = (
            self.stored_relative_path
            if self.status == DATASET_STATUS_READY
            else ""
        )
        return {
            "dataset_id": self.dataset_id,
            "org_id": self.org_id,
            "user_id": self.user_id,
            "conversation_id": self.conversation_id,
            "agent_session_id": self.agent_session_id,
            "sandbox_session_id": self.sandbox_session_id,
            "original_filename": self.original_filename,
            "name": self.original_filename,
            "path": path,
            "stored_relative_path": path,
            "mime_type": self.mime_type or "application/octet-stream",
            "size_bytes": int(self.size_bytes or 0),
            "size": int(self.size_bytes or 0),
            "sha256": self.sha256 if self.status == DATASET_STATUS_READY else None,
            "status": self.status,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }


@dataclass
class _InFlight:
    entry: DatasetEntry
    temp_path: Path
    handle: BinaryIO | None
    hasher: Any
    size: int
    reservation: QuotaReservation | None
    workspace_path: str
    workspace_id: str
    formal_path: str
    safe_name: str
    idempotency_key: str | None


class DatasetManager:
    def __init__(
        self,
        *,
        formal: FormalDatasetDualWriter | None = None,
        quota: WorkspaceQuotaLedger | None = None,
        auto_wire_formal: bool = True,
    ) -> None:
        if formal is not None:
            self._formal = formal
        elif auto_wire_formal:
            self._formal = try_wire_formal_dataset_repository()
        else:
            self._formal = FormalDatasetDualWriter(None, authoritative=False)
        self._quota = quota or workspace_quota_ledger
        self._lock = threading.RLock()
        self._entries: dict[str, DatasetEntry] = {}
        self._by_session: dict[str, list[str]] = {}
        self._inflight: dict[str, _InFlight] = {}
        ensure_control_roots()

    def set_formal_repository(
        self,
        repo: FormalDatasetRepositoryPort | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = True,
    ) -> None:
        self._formal = FormalDatasetDualWriter(
            repo, conn_factory=conn_factory, authoritative=authoritative
        )

    @property
    def formal(self) -> FormalDatasetDualWriter:
        return self._formal

    def max_file_bytes(self) -> int:
        return settings.max_file_size_mb * 1024 * 1024

    def begin_upload(
        self,
        *,
        workspace_path: str,
        workspace_key: str,
        sandbox_session_id: str,
        org_id: str,
        user_id: str,
        conversation_id: str,
        agent_session_id: str,
        original_filename: str,
        mime_type: str | None = None,
        declared_size: int | None = None,
        dataset_id: str | None = None,
        idempotency_key: str | None = None,
    ) -> DatasetEntry:
        if getattr(self._formal, "_wire_error", None) is not None and self._formal.authoritative:
            raise DatasetError(
                "dataset_formal_unavailable",
                "Formal MySQL dataset plane is required but failed to wire",
                status=503,
            )
        if self._formal.authoritative and not self._formal.enabled:
            raise DatasetError(
                "dataset_formal_unavailable",
                "Formal MySQL dataset plane is required but not available",
                status=503,
            )

        org_id = (org_id or "").strip()
        user_id = (user_id or "").strip()
        conversation_id = (conversation_id or "").strip()
        agent_session_id = (agent_session_id or "").strip()
        workspace_id = (workspace_key or "").strip()
        idem_key = normalize_dataset_idempotency_key(idempotency_key)
        idempotent_formal = bool(idem_key and self._formal.enabled)
        if not (org_id and user_id and conversation_id and agent_session_id):
            raise DatasetError(
                "dataset_ownership_required",
                "org_id, user_id, conversation_id, and agent_session_id are required",
                status=400,
            )
        if not workspace_id or "/" in workspace_id or "\\" in workspace_id:
            raise DatasetError(
                "dataset_workspace_invalid",
                "workspace_key must be an opaque workspace id",
                status=400,
            )

        safe_name = sanitize_dataset_filename(original_filename)
        did = (dataset_id or new_ulid()).strip().upper()
        formal_rel = logical_dataset_path(did, safe_name)

        max_bytes = self.max_file_bytes()
        if declared_size is not None and declared_size < 0:
            raise DatasetError(
                "dataset_size_invalid",
                "Declared file size must be non-negative",
                status=400,
            )
        if declared_size is not None and declared_size > max_bytes:
            raise DatasetError(
                "dataset_too_large",
                f"File exceeds max size of {settings.max_file_size_mb}MB",
                status=413,
            )

        # Durable idempotent uploads cannot know the final resource path until
        # their content hash is computed and the formal reservation is loaded.
        # Defer quota charging so crash recovery can credit an existing target.
        reserve_n = 0 if idempotent_formal else int(declared_size or 0)
        try:
            reservation = self._quota.reserve(
                workspace_path, workspace_id, reserve_n
            )
        except QuotaExceededError as exc:
            raise DatasetError(exc.code, exc.message, status=exc.status) from exc

        # Control-plane staging (never under untrusted workspace)
        try:
            ensure_dataset_staging_parent(workspace_id, did)
            temp = dataset_staging_path(workspace_id, did, safe_name)
            unlink_control_file(temp)
            # Exclusive create
            fd = os.open(
                str(temp),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o600,
            )
            handle = os.fdopen(fd, "wb")
        except OSError as exc:
            reservation.release()
            raise DatasetError(
                "dataset_open_failed",
                f"Failed to open control-plane staging: {exc}",
                status=500,
            ) from exc

        now = _now_iso()
        guessed, _ = mimetypes.guess_type(safe_name)
        mime = mime_type or guessed or "application/octet-stream"
        entry = DatasetEntry(
            dataset_id=did,
            org_id=org_id,
            user_id=user_id,
            conversation_id=conversation_id,
            agent_session_id=agent_session_id,
            sandbox_session_id=sandbox_session_id,
            original_filename=safe_name,
            stored_relative_path=formal_rel,
            status=DATASET_STATUS_UPLOADING,
            created_at=now,
            mime_type=mime,
            workspace_id=workspace_id,
            idempotency_key=idem_key,
        )

        if not idempotent_formal:
            try:
                self._formal.create_uploading(
                    {
                        "dataset_id": did,
                        "org_id": org_id,
                        "user_id": user_id,
                        "conversation_id": conversation_id,
                        "agent_session_id": agent_session_id,
                        "original_filename": entry.original_filename,
                        "stored_relative_path": formal_rel,
                        "mime_type": mime,
                        "size_bytes": None,
                        "sha256": None,
                        "status": DATASET_STATUS_UPLOADING,
                        "created_at": to_mysql_datetime(),
                        "completed_at": None,
                    }
                )
            except FormalDatasetError as exc:
                try:
                    handle.close()
                except OSError:
                    pass
                unlink_control_file(temp)
                reservation.release()
                raise DatasetError(exc.code, exc.message, status=exc.status) from exc

        with self._lock:
            self._entries[did] = entry
            self._by_session.setdefault(sandbox_session_id, []).append(did)
            self._inflight[did] = _InFlight(
                entry=entry,
                temp_path=temp,
                handle=handle,
                hasher=hashlib.sha256(),
                size=0,
                reservation=reservation,
                workspace_path=workspace_path,
                workspace_id=workspace_id,
                formal_path=formal_rel,
                safe_name=safe_name,
                idempotency_key=idem_key if idempotent_formal else None,
            )
        return entry

    def write_chunk(self, dataset_id: str, chunk: bytes) -> int:
        if not chunk:
            return 0
        with self._lock:
            inflight = self._inflight.get(dataset_id)
            if inflight is None or inflight.handle is None:
                raise DatasetError(
                    "dataset_not_uploading",
                    "No in-flight upload for dataset",
                    status=409,
                )
            new_size = inflight.size + len(chunk)
            max_bytes = self.max_file_bytes()
            if new_size > max_bytes:
                pass
            else:
                res = inflight.reservation
                try:
                    if inflight.idempotency_key is not None:
                        pass
                    elif res is not None and new_size > res.bytes:
                        self._quota.try_grow(
                            inflight.workspace_path, res, new_size
                        )
                    elif res is None:
                        inflight.reservation = self._quota.reserve(
                            inflight.workspace_path,
                            inflight.workspace_id,
                            new_size,
                        )
                except QuotaExceededError as exc:
                    raise DatasetError(
                        exc.code, exc.message, status=exc.status
                    ) from exc
                if new_size <= max_bytes:
                    inflight.handle.write(chunk)
                    inflight.hasher.update(chunk)
                    inflight.size = new_size
                    return len(chunk)

        self.abort_upload(dataset_id, reason="dataset_too_large")
        raise DatasetError(
            "dataset_too_large",
            f"File exceeds max size of {settings.max_file_size_mb}MB",
            status=413,
        )

    def finish_upload(self, dataset_id: str) -> DatasetEntry:
        with self._lock:
            inflight = self._inflight.get(dataset_id)
            if inflight is None:
                entry = self._entries.get(dataset_id)
                if entry and entry.status == DATASET_STATUS_READY:
                    return entry
                raise DatasetError(
                    "dataset_not_uploading",
                    "No in-flight upload for dataset",
                    status=409,
                )
            handle = inflight.handle
            temp = inflight.temp_path
            hasher = inflight.hasher
            size = inflight.size
            res = inflight.reservation
            entry = inflight.entry
            workspace_path = inflight.workspace_path
            formal_rel = inflight.formal_path
            inflight.handle = None

        try:
            if handle is not None:
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
                handle.close()
        except OSError as exc:
            self.abort_upload(dataset_id, reason="upload_incomplete")
            raise DatasetError(
                "upload_incomplete", f"Failed to finalize staging: {exc}", status=500
            ) from exc

        digest = hasher.hexdigest()
        if inflight.idempotency_key is not None:
            return self._finish_idempotent_upload(
                dataset_id,
                inflight=inflight,
                content_sha256=digest,
            )

        parts = tuple(p for p in Path(formal_rel).parts if p not in ("", "."))
        published_identity = None
        try:
            published_identity = secure_publish_to_workspace(
                src_control_path=temp,
                workspace_path=Path(workspace_path),
                relative_parts=parts,
                max_bytes=self.max_file_bytes(),
            )
        except ControlPlaneError as exc:
            self.abort_upload(dataset_id, reason="publish_failed")
            raise DatasetError(exc.code.lower(), exc.message, status=exc.status) from exc

        scope = OwnerScope(org_id=entry.org_id, user_id=entry.user_id)
        try:
            self._formal.mark_ready(
                dataset_id,
                scope,
                size_bytes=size,
                sha256=digest,
                completed_at=to_mysql_datetime(),
            )
        except FormalDatasetError as exc:
            # Compensate only the leaf we just published (dirfd + identity match)
            if published_identity is not None:
                unlink_workspace_leaf_if_matches(
                    workspace_path=Path(workspace_path),
                    relative_parts=parts,
                    expected=published_identity,
                )
            unlink_control_file(temp)
            if res is not None:
                res.release()
            with self._lock:
                entry.status = DATASET_STATUS_FAILED
                entry.completed_at = _now_iso()
                self._inflight.pop(dataset_id, None)
            self._formal.mark_failed(dataset_id, scope)
            self._formal.delete(dataset_id, scope)
            raise DatasetError(exc.code, exc.message, status=exc.status) from exc

        # Staging no longer needed after successful publish
        unlink_control_file(temp)

        completed = _now_iso()
        with self._lock:
            entry.status = DATASET_STATUS_READY
            entry.size_bytes = size
            entry.sha256 = digest
            entry.completed_at = completed
            entry.stored_relative_path = formal_rel
            self._inflight.pop(dataset_id, None)

        if res is not None:
            res.commit()
        return entry

    def _finish_idempotent_upload(
        self,
        candidate_id: str,
        *,
        inflight: _InFlight,
        content_sha256: str,
    ) -> DatasetEntry:
        entry = inflight.entry
        temp = inflight.temp_path
        size = inflight.size
        workspace_path = inflight.workspace_path
        workspace_id = inflight.workspace_id
        key = inflight.idempotency_key
        if key is None:
            raise DatasetError(
                "dataset_idempotency_key_invalid",
                "Idempotency-Key is required",
                status=400,
            )
        operation = f"{_IDEMPOTENCY_OPERATION_PREFIX}{entry.conversation_id}"
        request_hash = dataset_upload_request_hash(
            entry,
            content_sha256=content_sha256,
            size_bytes=size,
        )
        completed_at = to_mysql_datetime()
        quota_box: list[QuotaReservation | None] = [inflight.reservation]

        def durable_quota_id(resource_id: str) -> str:
            return f"dataset-{resource_id}"

        def publish(record: Any) -> None:
            parts = tuple(
                p
                for p in Path(record.stored_relative_path).parts
                if p not in ("", ".")
            )
            existing_bytes = self._existing_target_size(
                workspace_path=workspace_path,
                relative_parts=parts,
            )
            if quota_box[0] is not None:
                quota_box[0].release()
            quota_box[0] = self._quota.reserve_replacement(
                workspace_path,
                workspace_id,
                size,
                existing_bytes=existing_bytes,
                reservation_id=durable_quota_id(record.dataset_id),
            )
            inflight.reservation = quota_box[0]
            secure_publish_to_workspace(
                src_control_path=temp,
                workspace_path=Path(workspace_path),
                relative_parts=parts,
                max_bytes=self.max_file_bytes(),
            )

        def response_factory(record: Any) -> dict[str, Any]:
            response = self._entry_from_formal(
                record,
                sandbox_session_id=entry.sandbox_session_id,
                workspace_id=workspace_id,
            )
            response.status = DATASET_STATUS_READY
            response.size_bytes = size
            response.sha256 = content_sha256
            response.completed_at = completed_at
            return response.to_public()

        formal_input = {
            "dataset_id": candidate_id,
            "org_id": entry.org_id,
            "user_id": entry.user_id,
            "conversation_id": entry.conversation_id,
            "agent_session_id": entry.agent_session_id,
            "original_filename": entry.original_filename,
            "stored_relative_path": entry.stored_relative_path,
            "mime_type": entry.mime_type,
            "size_bytes": None,
            "sha256": None,
            "status": DATASET_STATUS_UPLOADING,
            "created_at": to_mysql_datetime(),
            "completed_at": None,
            "expires_at": to_mysql_datetime(
                datetime.now(timezone.utc) + timedelta(days=30)
            ),
        }
        try:
            _outcome, record = self._formal.finish_idempotent_upload(
                formal_input,
                idempotency_key=key,
                operation=operation,
                request_hash=request_hash,
                size_bytes=size,
                sha256=content_sha256,
                completed_at=completed_at,
                publish=publish,
                response_factory=response_factory,
            )
        except DatasetError:
            self._fail_idempotent_candidate(candidate_id, inflight)
            raise
        except QuotaExceededError as exc:
            self._fail_idempotent_candidate(candidate_id, inflight)
            raise DatasetError(exc.code, exc.message, status=exc.status) from exc
        except ControlPlaneError as exc:
            self._fail_idempotent_candidate(candidate_id, inflight)
            raise DatasetError(exc.code.lower(), exc.message, status=exc.status) from exc
        except FormalDatasetError as exc:
            self._fail_idempotent_candidate(candidate_id, inflight)
            raise DatasetError(exc.code, exc.message, status=exc.status) from exc

        unlink_control_file(temp)
        reservation = quota_box[0]
        if reservation is not None:
            reservation.commit()
        # A process may have died after creating the durable quota reservation
        # or after MySQL completion but before local cleanup. Replay reaches
        # this path without invoking publish, so clear the stable id explicitly.
        self._quota.release_reservation(
            workspace_id,
            durable_quota_id(record.dataset_id),
        )
        final = self._entry_from_formal(
            record,
            sandbox_session_id=entry.sandbox_session_id,
            workspace_id=workspace_id,
        )
        with self._lock:
            self._inflight.pop(candidate_id, None)
            self._entries.pop(candidate_id, None)
            ids = self._by_session.setdefault(entry.sandbox_session_id, [])
            ids[:] = [did for did in ids if did != candidate_id]
            self._entries[final.dataset_id] = final
            if final.dataset_id not in ids:
                ids.append(final.dataset_id)
        return final

    def _fail_idempotent_candidate(
        self,
        candidate_id: str,
        inflight: _InFlight,
    ) -> None:
        unlink_control_file(inflight.temp_path)
        if inflight.reservation is not None:
            inflight.reservation.release()
        with self._lock:
            self._inflight.pop(candidate_id, None)
            inflight.entry.status = DATASET_STATUS_FAILED
            inflight.entry.completed_at = _now_iso()
            self._entries.pop(candidate_id, None)
            ids = self._by_session.get(inflight.entry.sandbox_session_id)
            if ids is not None:
                ids[:] = [did for did in ids if did != candidate_id]
                if not ids:
                    self._by_session.pop(inflight.entry.sandbox_session_id, None)

    @staticmethod
    def _existing_target_size(
        *,
        workspace_path: str,
        relative_parts: tuple[str, ...],
    ) -> int:
        try:
            fd, stat_result = open_workspace_leaf_nofollow(
                Path(workspace_path), relative_parts
            )
        except ControlPlaneError as exc:
            if exc.code in {"FILE_NOT_FOUND", "PATH_INVALID"}:
                return 0
            raise
        try:
            return int(stat_result.st_size)
        finally:
            os.close(fd)

    @staticmethod
    def _entry_from_formal(
        row: Any,
        *,
        sandbox_session_id: str,
        workspace_id: str | None = None,
    ) -> DatasetEntry:
        return DatasetEntry(
            dataset_id=row.dataset_id,
            org_id=row.org_id,
            user_id=row.user_id,
            conversation_id=row.conversation_id,
            agent_session_id=row.agent_session_id,
            sandbox_session_id=sandbox_session_id,
            original_filename=row.original_filename,
            stored_relative_path=row.stored_relative_path,
            status=row.status,
            created_at=row.created_at,
            mime_type=row.mime_type,
            size_bytes=row.size_bytes,
            sha256=row.sha256,
            completed_at=row.completed_at,
            workspace_id=workspace_id,
        )

    def abort_upload(self, dataset_id: str, *, reason: str = "aborted") -> None:
        with self._lock:
            inflight = self._inflight.pop(dataset_id, None)
            entry = self._entries.get(dataset_id)

        if inflight is not None:
            if inflight.handle is not None:
                try:
                    inflight.handle.close()
                except OSError:
                    pass
            unlink_control_file(inflight.temp_path)
            if inflight.reservation is not None:
                inflight.reservation.release()

        if entry is not None and entry.status == DATASET_STATUS_READY:
            return

        if entry is not None:
            entry.status = DATASET_STATUS_FAILED
            entry.completed_at = _now_iso()
            if entry.idempotency_key and self._formal.enabled:
                # No formal reservation exists until finish_upload. If finish
                # already reserved one, it must remain durable for retry; this
                # local candidate is never the source of truth.
                with self._lock:
                    self._entries.pop(dataset_id, None)
                    ids = self._by_session.get(entry.sandbox_session_id)
                    if ids is not None:
                        ids[:] = [did for did in ids if did != dataset_id]
                        if not ids:
                            self._by_session.pop(entry.sandbox_session_id, None)
            else:
                scope = OwnerScope(org_id=entry.org_id, user_id=entry.user_id)
                self._formal.mark_failed(dataset_id, scope)
                self._formal.delete(dataset_id, scope)
        _ = reason

    def stream_from_iterator(
        self,
        *,
        workspace_path: str,
        workspace_key: str,
        sandbox_session_id: str,
        org_id: str,
        user_id: str,
        conversation_id: str,
        agent_session_id: str,
        original_filename: str,
        chunks: Iterator[bytes],
        mime_type: str | None = None,
        declared_size: int | None = None,
        idempotency_key: str | None = None,
    ) -> DatasetEntry:
        entry = self.begin_upload(
            workspace_path=workspace_path,
            workspace_key=workspace_key,
            sandbox_session_id=sandbox_session_id,
            org_id=org_id,
            user_id=user_id,
            conversation_id=conversation_id,
            agent_session_id=agent_session_id,
            original_filename=original_filename,
            mime_type=mime_type,
            declared_size=declared_size,
            idempotency_key=idempotency_key,
        )
        try:
            for chunk in chunks:
                if chunk:
                    self.write_chunk(entry.dataset_id, chunk)
            return self.finish_upload(entry.dataset_id)
        except DatasetError:
            self.abort_upload(entry.dataset_id)
            raise
        except Exception:
            self.abort_upload(entry.dataset_id)
            raise

    def get(
        self,
        dataset_id: str,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
        sandbox_session_id: str | None = None,
        agent_session_id: str | None = None,
    ) -> DatasetEntry | None:
        if self._formal.authoritative:
            if getattr(self._formal, "_wire_error", None) is not None or not self._formal.enabled:
                raise DatasetError(
                    "dataset_formal_unavailable",
                    "Formal MySQL dataset plane is required but not available",
                    status=503,
                )
            if not (org_id and user_id and agent_session_id):
                raise DatasetError(
                    "dataset_ownership_required",
                    "org_id, user_id, and agent_session_id are required",
                    status=400,
                )
        if self._formal.enabled and org_id and user_id and agent_session_id:
            try:
                row = self._formal.get(
                    dataset_id,
                    OwnerScope(org_id=org_id, user_id=user_id),
                )
            except FormalDatasetError as exc:
                raise DatasetError(exc.code, exc.message, status=exc.status) from exc
            if row is None or row.agent_session_id != agent_session_id:
                return None
            recovered = self._entry_from_formal(
                row,
                sandbox_session_id=sandbox_session_id or "",
            )
            with self._lock:
                self._entries[recovered.dataset_id] = recovered
                if sandbox_session_id:
                    ids = self._by_session.setdefault(sandbox_session_id, [])
                    if recovered.dataset_id not in ids:
                        ids.append(recovered.dataset_id)
            return recovered
        with self._lock:
            entry = self._entries.get(dataset_id)
            if entry is None:
                return None
            if org_id and entry.org_id != org_id:
                return None
            if user_id and entry.user_id != user_id:
                return None
            if (
                sandbox_session_id
                and entry.sandbox_session_id != sandbox_session_id
            ):
                return None
            return entry

    def list_for_session(
        self,
        sandbox_session_id: str,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
        agent_session_id: str | None = None,
        ready_only: bool = False,
    ) -> list[DatasetEntry]:
        if self._formal.authoritative:
            if getattr(self._formal, "_wire_error", None) is not None or not self._formal.enabled:
                raise DatasetError(
                    "dataset_formal_unavailable",
                    "Formal MySQL dataset plane is required but not available",
                    status=503,
                )
            if not (org_id and user_id and agent_session_id):
                raise DatasetError(
                    "dataset_ownership_required",
                    "org_id, user_id, and agent_session_id are required",
                    status=400,
                )
        if self._formal.enabled and org_id and user_id and agent_session_id:
            try:
                rows = self._formal.list_for_owner(
                    OwnerScope(org_id=org_id, user_id=user_id),
                    agent_session_id=agent_session_id,
                    limit=200,
                )
            except FormalDatasetError as exc:
                raise DatasetError(exc.code, exc.message, status=exc.status) from exc
            recovered = [
                self._entry_from_formal(
                    row,
                    sandbox_session_id=sandbox_session_id,
                )
                for row in rows
                if not ready_only or row.status == DATASET_STATUS_READY
            ]
            with self._lock:
                ids = self._by_session.setdefault(sandbox_session_id, [])
                for entry in recovered:
                    self._entries[entry.dataset_id] = entry
                    if entry.dataset_id not in ids:
                        ids.append(entry.dataset_id)
            return recovered
        with self._lock:
            ids = list(self._by_session.get(sandbox_session_id, []))
            out: list[DatasetEntry] = []
            for did in ids:
                e = self._entries.get(did)
                if e is None:
                    continue
                if org_id and e.org_id != org_id:
                    continue
                if user_id and e.user_id != user_id:
                    continue
                if ready_only and e.status != DATASET_STATUS_READY:
                    continue
                out.append(e)
            return out

    def is_readable_by_agent(self, dataset_id: str) -> bool:
        e = self.get(dataset_id)
        return e is not None and e.status == DATASET_STATUS_READY


dataset_manager = DatasetManager(auto_wire_formal=False)
