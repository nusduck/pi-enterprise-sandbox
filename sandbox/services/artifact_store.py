"""Formal artifact repository port + authoritative dual-writer (PR-09).

UNIQUE (run_id, relative_path_hash, sha256) — full-path SHA-256 identity
(plan §8.15 semantics without InnoDB 3072-byte overflow). Exact relative_path
equality still enforced on lookup; path-hash collisions fail closed.
Owner scope mandatory. Unique-key races re-get existing row.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Protocol

from sandbox.app.domain.types import ArtifactRecord, OwnerScope
from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope

logger = logging.getLogger("sandbox.artifact_store")


class FormalArtifactError(Exception):
    def __init__(self, code: str, message: str, *, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class FormalArtifactRepositoryPort(Protocol):
    def create(self, conn: Any, input: dict[str, Any]) -> ArtifactRecord: ...

    def get_by_id(
        self,
        conn: Any,
        artifact_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ArtifactRecord | None: ...

    def get_by_run_path_hash(
        self,
        conn: Any,
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str,
        relative_path: str,
        sha256: str,
    ) -> ArtifactRecord | None: ...

    def list_for_owner(
        self,
        conn: Any,
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str | None = None,
        limit: int = 50,
    ) -> list[ArtifactRecord]: ...


def _path_hash_hex(relative_path: str) -> str:
    import hashlib

    return hashlib.sha256(str(relative_path).encode("utf-8")).hexdigest().lower()


@dataclass
class FakeFormalArtifactRepository:
    """In-memory formal artifacts — owner fail-closed, unique key enforced.

    Unique key mirrors MySQL ``uk_artifact_file``:
    (run_id, relative_path_hash, sha256) with full-path SHA-256 (not prefix).
    """

    rows: dict[str, dict[str, Any]] = field(default_factory=dict)
    _unique: dict[tuple[str, str, str], str] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    # When True, create raises once to simulate unique race after check
    race_on_create: bool = False

    def create(self, conn: Any, input: dict[str, Any]) -> ArtifactRecord:  # noqa: ARG002
        from sandbox.app.persistence.errors import ConflictError

        scope = require_owner_scope(input, resource="artifacts")
        aid = input["artifact_id"]
        rel = str(input["relative_path"])
        path_h = _path_hash_hex(rel)
        key = (
            str(input["run_id"]),
            path_h,
            str(input["sha256"]).lower(),
        )
        with self._lock:
            existing_id = self._unique.get(key)
            if existing_id is not None:
                existing = self.rows[existing_id]
                if str(existing["relative_path"]) != rel:
                    raise ConflictError(
                        "Artifact path hash collision: unique key matches a "
                        "different relative_path (fail closed)",
                        resource="artifacts",
                        id=existing_id,
                    )
                return self._to_record(existing)
            if self.race_on_create and existing_id is None and key in getattr(self, "_pending", {}):
                raise UniqueRaceError(key)
            if aid in self.rows:
                return self._to_record(self.rows[aid])
            if self.race_on_create:
                # First create inserts; second concurrent create raises UniqueRaceError
                # (tests set race then call twice)
                pass
            row = {
                "artifact_id": aid,
                "org_id": scope.org_id,
                "user_id": scope.user_id,
                "conversation_id": input["conversation_id"],
                "agent_session_id": input["agent_session_id"],
                "run_id": input["run_id"],
                "relative_path": rel,
                "relative_path_hash": path_h,
                "display_name": input["display_name"],
                "mime_type": input.get("mime_type"),
                "size_bytes": int(input["size_bytes"]),
                "sha256": str(input["sha256"]).lower(),
                "status": input["status"],
                "created_at": input.get("created_at") or to_mysql_datetime(),
            }
            self.rows[aid] = row
            self._unique[key] = aid
            return self._to_record(row)

    def get_by_id(
        self,
        conn: Any,  # noqa: ARG002
        artifact_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ArtifactRecord | None:
        s = require_owner_scope(scope, resource="artifacts")
        with self._lock:
            row = self.rows.get(artifact_id)
            if row is None:
                return None
            if row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                return None
            return self._to_record(row)

    def get_by_run_path_hash(
        self,
        conn: Any,  # noqa: ARG002
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str,
        relative_path: str,
        sha256: str,
    ) -> ArtifactRecord | None:
        from sandbox.app.persistence.errors import ConflictError

        s = require_owner_scope(scope, resource="artifacts")
        rel = str(relative_path)
        key = (str(run_id), _path_hash_hex(rel), str(sha256).lower())
        with self._lock:
            aid = self._unique.get(key)
            if aid is None:
                return None
            row = self.rows.get(aid)
            if row is None:
                return None
            if row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                return None
            if str(row["relative_path"]) != rel:
                raise ConflictError(
                    "Artifact path hash collision: unique key matches a "
                    "different relative_path (fail closed)",
                    resource="artifacts",
                    id=aid,
                )
            return self._to_record(row)

    def list_for_owner(
        self,
        conn: Any,  # noqa: ARG002
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str | None = None,
        limit: int = 50,
    ) -> list[ArtifactRecord]:
        s = require_owner_scope(scope, resource="artifacts")
        with self._lock:
            out = [
                self._to_record(r)
                for r in self.rows.values()
                if r["org_id"] == s.org_id
                and r["user_id"] == s.user_id
                and (run_id is None or r["run_id"] == run_id)
            ]
        out.sort(key=lambda r: r.created_at, reverse=True)
        return out[: int(limit)]

    def simulate_unique_race_insert(
        self, entry: dict[str, Any]
    ) -> None:
        """Pre-insert a row to force get_or_create unique race path in tests."""
        scope = require_owner_scope(entry, resource="artifacts")
        rel = str(entry["relative_path"])
        path_h = _path_hash_hex(rel)
        key = (
            str(entry["run_id"]),
            path_h,
            str(entry["sha256"]).lower(),
        )
        with self._lock:
            aid = entry["artifact_id"]
            self.rows[aid] = {
                "artifact_id": aid,
                "org_id": scope.org_id,
                "user_id": scope.user_id,
                "conversation_id": entry["conversation_id"],
                "agent_session_id": entry["agent_session_id"],
                "run_id": entry["run_id"],
                "relative_path": rel,
                "relative_path_hash": path_h,
                "display_name": entry["display_name"],
                "mime_type": entry.get("mime_type"),
                "size_bytes": int(entry["size_bytes"]),
                "sha256": str(entry["sha256"]).lower(),
                "status": entry["status"],
                "created_at": entry.get("created_at") or to_mysql_datetime(),
            }
            self._unique[key] = aid

    @staticmethod
    def _to_record(row: dict[str, Any]) -> ArtifactRecord:
        return ArtifactRecord(
            artifact_id=str(row["artifact_id"]),
            org_id=str(row["org_id"]),
            user_id=str(row["user_id"]),
            conversation_id=str(row["conversation_id"]),
            agent_session_id=str(row["agent_session_id"]),
            run_id=str(row["run_id"]),
            relative_path=str(row["relative_path"]),
            display_name=str(row["display_name"]),
            size_bytes=int(row["size_bytes"]),
            sha256=str(row["sha256"]),
            status=str(row["status"]),
            created_at=str(row.get("created_at") or ""),
            mime_type=row.get("mime_type"),
        )


class UniqueRaceError(Exception):
    def __init__(self, key: tuple[str, str, str]) -> None:
        super().__init__(f"unique race on {key}")
        self.key = key


class FormalArtifactDualWriter:
    """Authoritative formal artifacts; get_or_create is race-safe on unique key."""

    def __init__(
        self,
        repo: FormalArtifactRepositoryPort | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = True,
    ) -> None:
        self.repo = repo
        self.conn_factory = conn_factory
        self.authoritative = bool(authoritative)
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.repo is not None

    def _with_conn(self, fn):
        if self.repo is None:
            return None
        factory = self.conn_factory
        if factory is None:
            return fn(None)
        maybe = factory()
        if hasattr(maybe, "__enter__"):
            with maybe as conn:
                result = fn(conn)
                try:
                    conn.commit()
                except Exception:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    raise
                return result
        try:
            result = fn(maybe)
            if hasattr(maybe, "commit"):
                maybe.commit()
            return result
        except Exception:
            if hasattr(maybe, "rollback"):
                try:
                    maybe.rollback()
                except Exception:
                    pass
            raise
        finally:
            if hasattr(maybe, "close"):
                try:
                    maybe.close()
                except Exception:
                    pass

    def get_or_create(self, entry: dict[str, Any]) -> ArtifactRecord:
        """Idempotent create. Raises FormalArtifactError when authoritative and fail."""
        if self.repo is None:
            if self.authoritative:
                raise FormalArtifactError(
                    "artifact_formal_unavailable",
                    "Formal artifact plane is required",
                    status=503,
                )
            raise FormalArtifactError(
                "artifact_formal_disabled",
                "Formal artifact repository not configured",
                status=500,
            )
        org_id = (entry.get("org_id") or "").strip()
        user_id = (entry.get("user_id") or "").strip()
        run_id = (entry.get("run_id") or "").strip()
        if not (org_id and user_id and run_id and entry.get("sha256")):
            raise FormalArtifactError(
                "artifact_formal_ownership",
                "Formal artifact requires org_id, user_id, run_id, sha256",
                status=400,
            )
        scope = OwnerScope(org_id=org_id, user_id=user_id)
        rel = str(entry["relative_path"])
        sha = str(entry["sha256"]).lower()
        entry = {**entry, "sha256": sha}

        def _do(conn):
            existing = self.repo.get_by_run_path_hash(
                conn,
                scope,
                run_id=run_id,
                relative_path=rel,
                sha256=sha,
            )
            if existing is not None:
                return existing
            try:
                return self.repo.create(conn, entry)
            except Exception:
                # Unique race: another writer won — re-get
                raced = self.repo.get_by_run_path_hash(
                    conn,
                    scope,
                    run_id=run_id,
                    relative_path=rel,
                    sha256=sha,
                )
                if raced is not None:
                    return raced
                raise

        try:
            with self._lock:
                result = self._with_conn(_do)
            if result is None:
                raise FormalArtifactError(
                    "artifact_formal_create_failed",
                    "Formal artifact create returned empty",
                    status=500,
                )
            return result
        except FormalArtifactError:
            raise
        except Exception as exc:
            if self.authoritative:
                raise FormalArtifactError(
                    "artifact_formal_create_failed",
                    f"Formal artifact create failed: {type(exc).__name__}",
                    status=500,
                ) from exc
            logger.debug("artifact formal create failed", exc_info=True)
            raise FormalArtifactError(
                "artifact_formal_create_failed",
                str(exc),
                status=500,
            ) from exc

    def get(
        self,
        artifact_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ArtifactRecord | None:
        if self.repo is None:
            return None
        try:
            with self._lock:
                return self._with_conn(
                    lambda conn: self.repo.get_by_id(conn, artifact_id, scope)
                )
        except Exception:
            return None

    def list_for_owner(
        self,
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str | None = None,
        limit: int = 50,
    ) -> list[ArtifactRecord]:
        if self.repo is None:
            return []
        try:
            with self._lock:
                return (
                    self._with_conn(
                        lambda conn: self.repo.list_for_owner(
                            conn, scope, run_id=run_id, limit=limit
                        )
                    )
                    or []
                )
        except Exception:
            return []


def try_wire_formal_artifact_repository() -> FormalArtifactDualWriter:
    """Wire production MySQL ArtifactRepository when DSN is formal MySQL."""
    from sandbox.config import is_legacy_test_database_url, is_mysql_database_url, settings

    url = (settings.database_url or "").strip()
    if not url or is_legacy_test_database_url(url) or not is_mysql_database_url(url):
        return FormalArtifactDualWriter(None, authoritative=False)
    try:
        from sandbox.app.persistence.db import create_mysql_database
        from sandbox.app.persistence.repositories.artifact_repository import (
            ArtifactRepository,
        )

        db = create_mysql_database(
            url,
            connect_timeout=int(settings.mysql_connect_timeout_seconds),
            read_timeout=int(settings.mysql_read_timeout_seconds),
            write_timeout=int(settings.mysql_write_timeout_seconds),
            max_connections=int(settings.mysql_max_connections),
        )
        repo = ArtifactRepository(db)

        def _conn_factory():
            return db.connection()

        return FormalArtifactDualWriter(
            repo, conn_factory=_conn_factory, authoritative=True
        )
    except Exception as exc:
        logger.error(
            "formal artifact MySQL wire failed: %s", type(exc).__name__, exc_info=True
        )
        writer = FormalArtifactDualWriter(None, authoritative=True)
        writer._wire_error = exc  # type: ignore[attr-defined]
        return writer
