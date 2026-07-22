"""Artifact Manager — immutable control-plane snapshots + formal MySQL authority.

PR-09:
  - submit streams workspace file → artifacts_root snapshot (not workspace)
  - formal MySQL is authoritative for ownership/list/download after restart
  - download streams from control-plane snapshot fd (identity + sha bound)
  - untrusted workspace mutate+utime cannot forge a valid snapshot
"""

from __future__ import annotations

import mimetypes
import os
import re
import stat
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import quote

from sandbox.app.domain.types import OwnerScope
from sandbox.app.domain.ulid import new_ulid
from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.config import settings
from sandbox.models import ArtifactResponse
from sandbox.security.path_validation import resolve_sandbox_path
from sandbox.services.artifact_store import (
    FormalArtifactDualWriter,
    FormalArtifactError,
    FormalArtifactRepositoryPort,
    try_wire_formal_artifact_repository,
)
from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    FileIdentity,
    artifact_blob_path,
    ensure_artifact_parent,
    ensure_control_roots,
    open_control_file_read,
    open_workspace_leaf_nofollow,
    stream_copy_hash_from_fd,
    stream_copy_hash_to_control,
    unlink_control_file,
)

_CHUNK = 64 * 1024
_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class ArtifactError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def as_detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_content_disposition_filename(name: str) -> str:
    base = Path(name or "artifact").name
    base = base.replace("\r", "").replace("\n", "")
    base = re.sub(r'["\\;]', "_", base)
    base = re.sub(r"[\x00-\x1f\x7f]", "", base).strip() or "artifact"
    return base[:200]


def artifact_content_disposition(name: str) -> str:
    """Build an ASCII-safe attachment header with an RFC 5987 UTF-8 name.

    HTTP header values sent by Starlette must be latin-1 encodable.  The
    user-facing artifact name can legitimately contain Chinese, Greek, etc.,
    so it must never be placed verbatim in the legacy ``filename`` parameter.
    Keep that parameter as a conservative ASCII fallback and put the original
    sanitized filename in ``filename*`` for clients that support UTF-8.
    """
    filename = safe_content_disposition_filename(name)
    ascii_fallback = "".join(
        char if 0x20 <= ord(char) <= 0x7E else "_" for char in filename
    ).strip() or "artifact"
    return (
        f'attachment; filename="{ascii_fallback}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )


def iter_snapshot_chunks(
    path: Path,
    *,
    chunk_size: int = _CHUNK,
    expected: FileIdentity | None = None,
) -> Iterator[bytes]:
    """Stream control-plane snapshot fd; identity check only (no full re-hash).

    Snapshots live outside untrusted workspace; content is immutable to
    sandbox children. Identity (dev/ino/size/mtime) detects replace/swap.
    """
    with open_control_file_read(path) as fd:
        st = os.fstat(fd)
        if expected is not None and not expected.matches_stat(st, check_mtime=True):
            raise ArtifactError(
                "artifact_identity_mismatch",
                "Artifact snapshot identity changed",
                status=409,
            )
        while True:
            chunk = os.read(fd, chunk_size)
            if not chunk:
                break
            yield chunk


class ArtifactManager:
    """Explicit-submit artifacts with control-plane snapshots."""

    def __init__(
        self,
        *,
        formal: FormalArtifactDualWriter | None = None,
        auto_wire_formal: bool = True,
    ) -> None:
        # Artifact authority is supplied by the formal lifecycle runtime.
        if formal is not None:
            self._formal = formal
        elif auto_wire_formal:
            self._formal = try_wire_formal_artifact_repository()
        else:
            self._formal = FormalArtifactDualWriter(None, authoritative=False)
        # Process cache only — restart must recover from formal + snapshot disk
        self._artifacts: dict[str, dict] = {}
        self._session_artifacts: dict[str, list[str]] = {}
        # Tenant-scoped idempotency cache
        self._idem_keys: dict[tuple[str, str, str, str, str], str] = {}
        self._lock = threading.RLock()
        ensure_control_roots()

    def set_formal_repository(
        self,
        repo: FormalArtifactRepositoryPort | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = True,
    ) -> None:
        self._formal = FormalArtifactDualWriter(
            repo, conn_factory=conn_factory, authoritative=authoritative
        )

    @property
    def formal(self) -> FormalArtifactDualWriter:
        return self._formal

    def _snapshot_path(self, org_id: str, artifact_id: str) -> Path:
        return artifact_blob_path(org_id or "_local", artifact_id)

    def submit(
        self,
        *,
        session_id: str,
        path: str,
        name: str | None = None,
        mime_type: str | None = None,
        source_execution_id: str | None = None,
        physical_workspace: Path,
        physical_temp: Path | None = None,
        org_id: str | None = None,
        user_id: str | None = None,
        conversation_id: str | None = None,
        agent_session_id: str | None = None,
        run_id: str | None = None,
        expected_sha256: str | None = None,
        workspace_id: str | None = None,
    ) -> ArtifactResponse:
        """Hash+copy workspace file into control-plane snapshot; formal get_or_create.

        Source is opened only via workspace-root dirfd walk (O_DIRECTORY|O_NOFOLLOW);
        never lstat-then-absolute-path-open across a TOCTOU window.
        """
        try:
            parsed, _ = resolve_sandbox_path(
                physical_workspace,
                physical_temp or physical_workspace,
                path,
            )
        except PermissionError as exc:
            raise ArtifactError("artifact_path_invalid", str(exc), status=403) from exc

        from sandbox.paths import SandboxPathScope

        base = Path(
            physical_workspace
            if parsed.scope == SandboxPathScope.WORKSPACE
            else (physical_temp or physical_workspace)
        )
        rel_parts = tuple(p for p in parsed.relative.parts if p not in ("", "."))
        if not rel_parts:
            raise ArtifactError(
                "artifact_path_invalid",
                "Artifact path must be a relative file path",
                status=400,
            )

        stored_path = (
            parsed.relative.as_posix()
            if parsed.relative.as_posix() not in (".", "")
            else path.lstrip("/")
        )
        display = name or Path(stored_path).name or "artifact"
        mime = mime_type or mimetypes.guess_type(display)[0] or "application/octet-stream"

        org_s = (org_id or "").strip()
        user_s = (user_id or "").strip()
        run_s = (run_id or "").strip()
        conv_s = (conversation_id or "").strip()
        agent_s = (agent_session_id or "").strip()
        formal_binding = bool(org_s and user_s and conv_s and agent_s and run_s)

        if formal_binding and getattr(self._formal, "_wire_error", None):
            raise ArtifactError(
                "artifact_formal_unavailable",
                "Formal MySQL artifact plane is required but failed to wire",
                status=503,
            )
        if formal_binding and self._formal.authoritative and not self._formal.enabled:
            raise ArtifactError(
                "artifact_formal_unavailable",
                "Formal MySQL artifact plane is required but not available",
                status=503,
            )

        if expected_sha256 and not _SHA256_RE.match(expected_sha256):
            raise ArtifactError(
                "artifact_hash_invalid",
                "expected_sha256 must be 64 hex chars",
                status=400,
            )

        artifact_id = new_ulid() if formal_binding else f"art_{uuid.uuid4().hex[:10]}"
        org_key = org_s or "_local"
        ensure_artifact_parent(org_key, artifact_id)
        dest = self._snapshot_path(org_key, artifact_id)
        max_bytes = settings.max_file_size_mb * 1024 * 1024

        # Safe leaf fd for entire copy + optional winner rebuild
        try:
            leaf_fd, leaf_st = open_workspace_leaf_nofollow(base, rel_parts)
        except ControlPlaneError as exc:
            raise ArtifactError(
                exc.code.lower(), exc.message, status=exc.status
            ) from exc

        try:
            src_ident = FileIdentity.from_stat(leaf_st)
            try:
                digest, size, identity = stream_copy_hash_from_fd(
                    leaf_fd,
                    dest,
                    max_bytes=max_bytes,
                    source_identity=src_ident,
                )
            except ControlPlaneError as exc:
                unlink_control_file(dest)
                raise ArtifactError(
                    exc.code.lower(), exc.message, status=exc.status
                ) from exc

            if expected_sha256 and digest.lower() != expected_sha256.lower():
                unlink_control_file(dest)
                raise ArtifactError(
                    "artifact_hash_mismatch",
                    "Computed SHA-256 does not match expected_sha256",
                    status=409,
                )

            # Tenant-scoped idempotency
            scope_key = run_s or session_id
            idem = (org_s or "_", user_s or "_", scope_key, stored_path, digest.lower())
            with self._lock:
                existing_id = self._idem_keys.get(idem)
                if existing_id and existing_id != artifact_id:
                    unlink_control_file(dest)
                    existing = self.get_for_session(
                        session_id,
                        existing_id,
                        org_id=org_s or None,
                        user_id=user_s or None,
                        agent_session_id=agent_s or None,
                        conversation_id=conv_s or None,
                    )
                    if existing is not None:
                        return existing

            entry = {
                "artifact_id": artifact_id,
                "session_id": session_id,
                "name": display,
                "path": stored_path,
                "mime_type": mime,
                "source_execution_id": source_execution_id,
                "size": int(size),
                "sha256": digest.lower(),
                "org_id": org_s or None,
                "user_id": user_s or None,
                "conversation_id": conv_s or None,
                "agent_session_id": agent_s or None,
                "run_id": run_s or None,
                "workspace_id": workspace_id,
                "created_at": _now_iso(),
                "status": "ready",
                "file_identity": identity.to_dict(),
                "snapshot_org": org_key,
            }

            if formal_binding and self._formal.enabled:
                try:
                    formal_row = self._formal.get_or_create(
                        {
                            "artifact_id": artifact_id,
                            "org_id": org_s,
                            "user_id": user_s,
                            "conversation_id": conv_s,
                            "agent_session_id": agent_s,
                            "run_id": run_s,
                            "relative_path": stored_path,
                            "display_name": display,
                            "mime_type": mime,
                            "size_bytes": int(size),
                            "sha256": digest.lower(),
                            "status": "ready",
                            "created_at": to_mysql_datetime(),
                        }
                    )
                except FormalArtifactError as exc:
                    unlink_control_file(dest)
                    raise ArtifactError(
                        exc.code, exc.message, status=exc.status
                    ) from exc

                if formal_row.artifact_id != artifact_id:
                    unlink_control_file(dest)
                    artifact_id = formal_row.artifact_id
                    winner = self._snapshot_path(org_key, artifact_id)
                    if not winner.is_file():
                        # Rebuild winner snapshot from same safe leaf fd
                        try:
                            os.lseek(leaf_fd, 0, os.SEEK_SET)
                        except OSError:
                            pass
                        try:
                            stream_copy_hash_from_fd(
                                leaf_fd,
                                winner,
                                max_bytes=max_bytes,
                                source_identity=src_ident,
                            )
                        except ControlPlaneError as exc:
                            raise ArtifactError(
                                exc.code.lower(),
                                exc.message,
                                status=exc.status,
                            ) from exc
                    entry["artifact_id"] = artifact_id
                entry["name"] = formal_row.display_name
                entry["size"] = formal_row.size_bytes
                entry["sha256"] = formal_row.sha256
                entry["created_at"] = formal_row.created_at or entry["created_at"]

            with self._lock:
                self._artifacts[artifact_id] = entry
                ids = self._session_artifacts.setdefault(session_id, [])
                if artifact_id not in ids:
                    ids.append(artifact_id)
                self._idem_keys[idem] = artifact_id

            return self._to_response(entry)
        finally:
            try:
                os.close(leaf_fd)
            except OSError:
                pass

    def list_by_session(
        self,
        session_id: str,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
        agent_session_id: str | None = None,
        conversation_id: str | None = None,
    ) -> list[ArtifactResponse]:
        with self._lock:
            mem = [
                self._to_response(self._artifacts[aid])
                for aid in self._session_artifacts.get(session_id, [])
                if aid in self._artifacts
            ]
        if mem:
            return mem
        # Restart recovery: list from formal for owner (filter by agent session)
        if self._formal.enabled and org_id and user_id:
            rows = self._formal.list_for_owner(
                OwnerScope(org_id=org_id, user_id=user_id), limit=100
            )
            out: list[ArtifactResponse] = []
            for r in rows:
                if agent_session_id and r.agent_session_id != agent_session_id:
                    continue
                if conversation_id and r.conversation_id != conversation_id:
                    continue
                out.append(self._formal_to_response(r, session_id=session_id))
            return out
        return []

    def get(self, artifact_id: str) -> ArtifactResponse | None:
        with self._lock:
            entry = self._artifacts.get(artifact_id)
        if entry is not None:
            return self._to_response(entry)
        return None

    def get_for_session(
        self,
        session_id: str,
        artifact_id: str,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
        agent_session_id: str | None = None,
        conversation_id: str | None = None,
    ) -> ArtifactResponse | None:
        with self._lock:
            entry = self._artifacts.get(artifact_id)
            if entry is not None:
                if entry.get("session_id") != session_id:
                    # Allow same agent_session rebind across sandbox session ids
                    if not (
                        agent_session_id
                        and entry.get("agent_session_id") == agent_session_id
                    ):
                        return None
                return self._to_response(entry)
        return self._restore_from_formal(
            artifact_id,
            session_id=session_id,
            org_id=org_id,
            user_id=user_id,
            agent_session_id=agent_session_id,
            conversation_id=conversation_id,
        )

    def _cache_entry_matches_formal(self, entry: dict, formal: Any) -> bool:
        """True when live cache row is the same artifact as the formal MySQL row."""
        if entry.get("artifact_id") != formal.artifact_id:
            return False
        if entry.get("org_id") and str(entry["org_id"]) != str(formal.org_id):
            return False
        if entry.get("user_id") and str(entry["user_id"]) != str(formal.user_id):
            return False
        if entry.get("sha256") and str(entry["sha256"]).lower() != str(
            formal.sha256
        ).lower():
            return False
        if entry.get("path") and str(entry["path"]) != str(formal.relative_path):
            return False
        if entry.get("run_id") and str(entry["run_id"]) != str(formal.run_id):
            return False
        if entry.get("agent_session_id") and str(entry["agent_session_id"]) != str(
            formal.agent_session_id
        ):
            return False
        if entry.get("conversation_id") and str(entry["conversation_id"]) != str(
            formal.conversation_id
        ):
            return False
        if entry.get("size") is not None and int(entry["size"]) != int(
            formal.size_bytes
        ):
            return False
        return True

    def _same_session_live_cache(
        self,
        artifact_id: str,
        *,
        session_id: str,
        formal: Any | None = None,
    ) -> ArtifactResponse | None:
        """Allow download only from this process's cache for the exact session_id.

        Used when stable agent/conversation bindings are absent (offline/local
        sessions). Cross-session and fresh-manager (empty cache) return None.
        When *formal* is provided, cache identity must match the formal row.
        """
        with self._lock:
            entry = self._artifacts.get(artifact_id)
            if entry is None:
                return None
            if entry.get("session_id") != session_id:
                return None
            if formal is not None and not self._cache_entry_matches_formal(
                entry, formal
            ):
                return None
            return self._to_response(entry)

    def get_for_owner(
        self,
        artifact_id: str,
        *,
        session_id: str,
        org_id: str | None = None,
        user_id: str | None = None,
        agent_session_id: str | None = None,
        conversation_id: str | None = None,
        run_id: str | None = None,
    ) -> ArtifactResponse | None:
        """Authoritative owner gate supplied by the formal runtime.

        Bound path (agent_session_id + conversation_id present):
          formal row under org/user, then strict binding compare; run_id if set.

        Unbound path (missing agent/conversation — offline/local sessions):
          only same-session live manager cache; if formal row exists it must
          match cache identity. Fresh manager (no cache) → None / 404.
          Cross-session always None.
        """
        if self._formal.enabled:
            formal = None
            if org_id and user_id:
                formal = self._formal.get(
                    artifact_id, OwnerScope(org_id=org_id, user_id=user_id)
                )

            has_bindings = bool(
                (agent_session_id or "").strip() and (conversation_id or "").strip()
            )

            if has_bindings:
                # Restart recovery / multi-session: require formal row + strict binds
                if formal is None:
                    return None
                if formal.agent_session_id != str(agent_session_id).strip():
                    return None
                if formal.conversation_id != str(conversation_id).strip():
                    return None
                if run_id is not None and str(run_id).strip() != "":
                    if formal.run_id != str(run_id).strip():
                        return None
                resp = self._formal_to_response(formal, session_id=session_id)
                with self._lock:
                    self._artifacts[artifact_id] = {
                        "artifact_id": formal.artifact_id,
                        "session_id": session_id,
                        "name": formal.display_name,
                        "path": formal.relative_path,
                        "mime_type": formal.mime_type or "application/octet-stream",
                        "size": formal.size_bytes,
                        "sha256": formal.sha256,
                        "org_id": formal.org_id,
                        "user_id": formal.user_id,
                        "conversation_id": formal.conversation_id,
                        "agent_session_id": formal.agent_session_id,
                        "run_id": formal.run_id,
                        "created_at": formal.created_at,
                        "status": formal.status,
                        "snapshot_org": formal.org_id,
                        "source_execution_id": None,
                    }
                return resp

            # Unbound: same-session live cache only (optionally matched to formal)
            if formal is not None:
                return self._same_session_live_cache(
                    artifact_id, session_id=session_id, formal=formal
                )
            # No formal row (e.g. submit without run binding) — still allow
            # exact same-session live cache for this process.
            return self._same_session_live_cache(
                artifact_id, session_id=session_id, formal=None
            )

        # Offline / formal disabled: session cache only
        return self.get_for_session(
            session_id,
            artifact_id,
            org_id=org_id,
            user_id=user_id,
            agent_session_id=agent_session_id,
            conversation_id=conversation_id,
        )

    def _restore_from_formal(
        self,
        artifact_id: str,
        *,
        session_id: str,
        org_id: str | None,
        user_id: str | None,
        agent_session_id: str | None,
        conversation_id: str | None,
    ) -> ArtifactResponse | None:
        if not self._formal.enabled or not (org_id and user_id):
            return None
        return self.get_for_owner(
            artifact_id,
            session_id=session_id,
            org_id=org_id,
            user_id=user_id,
            agent_session_id=agent_session_id,
            conversation_id=conversation_id,
        )

    def resolve_download(
        self,
        *,
        session_id: str,
        artifact_id: str,
        org_id: str | None = None,
        user_id: str | None = None,
        agent_session_id: str | None = None,
        conversation_id: str | None = None,
        run_id: str | None = None,
    ) -> tuple[ArtifactResponse, Path, FileIdentity]:
        """Resolve control-plane snapshot for streaming download."""
        art = self.get_for_owner(
            artifact_id,
            session_id=session_id,
            org_id=org_id,
            user_id=user_id,
            agent_session_id=agent_session_id,
            conversation_id=conversation_id,
            run_id=run_id,
        )
        if art is None:
            raise ArtifactError("artifact_not_found", "Artifact not found", status=404)

        org_key = (org_id or "_local").strip() or "_local"
        with self._lock:
            entry = self._artifacts.get(artifact_id) or {}
            org_key = entry.get("snapshot_org") or entry.get("org_id") or org_key
            ident_dict = entry.get("file_identity")

        snap = self._snapshot_path(str(org_key), artifact_id)
        if not snap.is_file():
            raise ArtifactError(
                "artifact_file_missing",
                "Artifact snapshot not found on control plane",
                status=404,
            )
        try:
            with open_control_file_read(snap) as fd:
                st = os.fstat(fd)
        except ControlPlaneError as exc:
            raise ArtifactError(exc.code.lower(), exc.message, status=exc.status) from exc

        sha = art.sha256
        identity = FileIdentity.from_stat(st, sha256=sha)
        if ident_dict and sha:
            # Prefer registered identity + sha; mtime may differ after restore
            # from formal alone — sha is authoritative for content.
            if int(st.st_size) != int(art.size or st.st_size):
                raise ArtifactError(
                    "artifact_identity_mismatch",
                    "Artifact snapshot size mismatch",
                    status=409,
                )
        return art, snap, identity

    def delete_by_session(self, session_id: str) -> int:
        with self._lock:
            ids = self._session_artifacts.pop(session_id, [])
            for aid in ids:
                self._artifacts.pop(aid, None)
            return len(ids)

    @staticmethod
    def _formal_to_response(row: Any, *, session_id: str) -> ArtifactResponse:
        return ArtifactResponse(
            artifact_id=row.artifact_id,
            name=row.display_name,
            path=row.relative_path,
            mime_type=row.mime_type or "application/octet-stream",
            source_execution_id=None,
            size=int(row.size_bytes),
            created_at=row.created_at or "",
            sha256=row.sha256,
            run_id=row.run_id,
            status=row.status or "ready",
        )

    @staticmethod
    def _to_response(entry: dict) -> ArtifactResponse:
        return ArtifactResponse(
            artifact_id=entry["artifact_id"],
            name=entry["name"],
            path=entry["path"],
            mime_type=entry.get("mime_type") or "application/octet-stream",
            source_execution_id=entry.get("source_execution_id"),
            size=int(entry.get("size") or 0),
            created_at=entry.get("created_at") or "",
            sha256=entry.get("sha256"),
            run_id=entry.get("run_id"),
            status=entry.get("status") or "ready",
        )


artifact_manager = ArtifactManager(auto_wire_formal=False)
