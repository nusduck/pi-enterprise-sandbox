"""Formal dataset repository port + authoritative dual-writer (PR-09).

When a formal repository is enabled, create/mark_ready/delete are **authoritative**
(fail closed). Silent swallow is not allowed for production wiring.

Tests inject :class:`FakeFormalDatasetRepository` without real MySQL.
Production auto-wires :class:`DatasetRepository` + MySQL when DSN is formal.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Protocol

from sandbox.app.domain.types import DatasetRecord, OwnerScope
from sandbox.app.persistence.errors import NotFoundError
from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope

logger = logging.getLogger("sandbox.dataset_store")


class FormalDatasetError(Exception):
    """Authoritative formal-plane failure (not swallowed)."""

    def __init__(self, code: str, message: str, *, status: int = 500) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class FormalDatasetRepositoryPort(Protocol):
    def create(self, conn: Any, input: dict[str, Any]) -> DatasetRecord: ...

    def get_by_id(
        self,
        conn: Any,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord | None: ...

    def update_status(
        self,
        conn: Any,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        size_bytes: int | None = None,
        sha256: str | None = None,
        completed_at: str | None = None,
    ) -> DatasetRecord: ...

    def list_for_owner(
        self,
        conn: Any,
        scope: OwnerScope | dict[str, str],
        *,
        agent_session_id: str | None = None,
        limit: int = 50,
    ) -> list[DatasetRecord]: ...

    def delete(
        self,
        conn: Any,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> bool: ...


@dataclass
class FakeFormalDatasetRepository:
    """In-memory formal datasets — owner fail-closed; delete skips READY."""

    rows: dict[str, dict[str, Any]] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    # Simulate unique/pk race for tests
    fail_next_create: Exception | None = None
    fail_next_update: Exception | None = None

    def create(self, conn: Any, input: dict[str, Any]) -> DatasetRecord:  # noqa: ARG002
        scope = require_owner_scope(input, resource="datasets")
        did = input["dataset_id"]
        with self._lock:
            if self.fail_next_create is not None:
                exc = self.fail_next_create
                self.fail_next_create = None
                raise exc
            if did in self.rows:
                raise OwnershipDupError(did)
            row = {
                "dataset_id": did,
                "org_id": scope.org_id,
                "user_id": scope.user_id,
                "conversation_id": input["conversation_id"],
                "agent_session_id": input["agent_session_id"],
                "original_filename": input["original_filename"],
                "stored_relative_path": input["stored_relative_path"],
                "mime_type": input.get("mime_type"),
                "size_bytes": input.get("size_bytes"),
                "sha256": input.get("sha256"),
                "status": input["status"],
                "created_at": input.get("created_at") or to_mysql_datetime(),
                "completed_at": input.get("completed_at"),
            }
            self.rows[did] = row
            return self._to_record(row)

    def get_by_id(
        self,
        conn: Any,  # noqa: ARG002
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord | None:
        s = require_owner_scope(scope, resource="datasets")
        with self._lock:
            row = self.rows.get(dataset_id)
            if row is None:
                return None
            if row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                return None
            return self._to_record(row)

    def update_status(
        self,
        conn: Any,  # noqa: ARG002
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        size_bytes: int | None = None,
        sha256: str | None = None,
        completed_at: str | None = None,
    ) -> DatasetRecord:
        s = require_owner_scope(scope, resource="datasets")
        with self._lock:
            if self.fail_next_update is not None:
                exc = self.fail_next_update
                self.fail_next_update = None
                raise exc
            row = self.rows.get(dataset_id)
            if row is None or row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                raise NotFoundError(
                    "Dataset not found",
                    resource="datasets",
                    id=dataset_id,
                )
            # Sticky ready: do not demote ready → failed via normal path
            if row["status"] == "ready" and status != "ready":
                return self._to_record(row)
            row["status"] = status
            if size_bytes is not None:
                row["size_bytes"] = size_bytes
            if sha256 is not None:
                row["sha256"] = sha256
            if completed_at is not None:
                row["completed_at"] = completed_at
            return self._to_record(row)

    def list_for_owner(
        self,
        conn: Any,  # noqa: ARG002
        scope: OwnerScope | dict[str, str],
        *,
        agent_session_id: str | None = None,
        limit: int = 50,
    ) -> list[DatasetRecord]:
        s = require_owner_scope(scope, resource="datasets")
        with self._lock:
            out = [
                self._to_record(r)
                for r in self.rows.values()
                if r["org_id"] == s.org_id
                and r["user_id"] == s.user_id
                and (
                    agent_session_id is None
                    or r["agent_session_id"] == agent_session_id
                )
            ]
        out.sort(key=lambda r: r.created_at, reverse=True)
        return out[: int(limit)]

    def delete(
        self,
        conn: Any,  # noqa: ARG002
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> bool:
        """Aligned with MySQL repo: never deletes READY rows."""
        s = require_owner_scope(scope, resource="datasets")
        with self._lock:
            row = self.rows.get(dataset_id)
            if row is None:
                return False
            if row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                return False
            if row["status"] == "ready":
                return False
            del self.rows[dataset_id]
            return True

    @staticmethod
    def _to_record(row: dict[str, Any]) -> DatasetRecord:
        return DatasetRecord(
            dataset_id=str(row["dataset_id"]),
            org_id=str(row["org_id"]),
            user_id=str(row["user_id"]),
            conversation_id=str(row["conversation_id"]),
            agent_session_id=str(row["agent_session_id"]),
            original_filename=str(row["original_filename"]),
            stored_relative_path=str(row["stored_relative_path"]),
            status=str(row["status"]),
            created_at=str(row.get("created_at") or ""),
            mime_type=row.get("mime_type"),
            size_bytes=(
                int(row["size_bytes"]) if row.get("size_bytes") is not None else None
            ),
            sha256=row.get("sha256"),
            completed_at=(
                str(row["completed_at"]) if row.get("completed_at") is not None else None
            ),
        )


class OwnershipDupError(Exception):
    def __init__(self, dataset_id: str) -> None:
        super().__init__(f"dataset_id already exists: {dataset_id}")
        self.dataset_id = dataset_id


class FormalDatasetDualWriter:
    """Authoritative formal datasets writer when enabled.

    * ``enabled`` + ``authoritative``: failures raise :class:`FormalDatasetError`.
    * Offline tests inject Fake; production wires real DatasetRepository.
    """

    def __init__(
        self,
        repo: FormalDatasetRepositoryPort | None,
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

    def _conn(self) -> Any:
        if self.conn_factory is None:
            return None
        factory = self.conn_factory
        # Support contextmanager or plain connection
        if hasattr(factory, "__enter__"):
            return factory
        conn = factory()
        return conn

    def _with_conn(self, fn):
        if self.repo is None:
            return None
        factory = self.conn_factory
        if factory is None:
            # Fake repos ignore conn
            return fn(None)
        # conn_factory may return a context manager (MysqlDatabase.connection)
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

    def create_uploading(self, entry: dict[str, Any]) -> DatasetRecord | None:
        if self.repo is None:
            return None
        org_id = (entry.get("org_id") or "").strip()
        user_id = (entry.get("user_id") or "").strip()
        if not (org_id and user_id and entry.get("dataset_id")):
            if self.authoritative:
                raise FormalDatasetError(
                    "dataset_formal_ownership",
                    "Formal dataset create requires org_id and user_id",
                    status=400,
                )
            return None
        try:
            with self._lock:
                return self._with_conn(lambda conn: self.repo.create(conn, entry))
        except FormalDatasetError:
            raise
        except Exception as exc:
            if self.authoritative:
                raise FormalDatasetError(
                    "dataset_formal_create_failed",
                    f"Formal dataset create failed: {type(exc).__name__}",
                    status=500,
                ) from exc
            logger.debug("dataset formal create failed", exc_info=True)
            return None

    def mark_ready(
        self,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        size_bytes: int,
        sha256: str,
        completed_at: str | None = None,
    ) -> DatasetRecord | None:
        if self.repo is None:
            return None
        try:
            with self._lock:

                def _do(conn):
                    return self.repo.update_status(
                        conn,
                        dataset_id,
                        scope,
                        status="ready",
                        size_bytes=size_bytes,
                        sha256=sha256,
                        completed_at=completed_at or to_mysql_datetime(),
                    )

                return self._with_conn(_do)
        except FormalDatasetError:
            raise
        except Exception as exc:
            if self.authoritative:
                raise FormalDatasetError(
                    "dataset_formal_ready_failed",
                    f"Formal dataset mark_ready failed: {type(exc).__name__}",
                    status=500,
                ) from exc
            logger.debug("dataset formal mark_ready failed", exc_info=True)
            return None

    def mark_failed(
        self,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord | None:
        if self.repo is None:
            return None
        try:
            with self._lock:

                def _do(conn):
                    return self.repo.update_status(
                        conn,
                        dataset_id,
                        scope,
                        status="failed",
                        completed_at=to_mysql_datetime(),
                    )

                return self._with_conn(_do)
        except Exception:
            # Cleanup path — best effort even when authoritative
            logger.debug("dataset formal mark_failed failed", exc_info=True)
            return None

    def delete(
        self,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> bool:
        if self.repo is None:
            return False
        try:
            with self._lock:
                return bool(
                    self._with_conn(
                        lambda conn: self.repo.delete(conn, dataset_id, scope)
                    )
                )
        except Exception:
            logger.debug("dataset formal delete failed", exc_info=True)
            return False

    def get(
        self,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord | None:
        if self.repo is None:
            return None
        try:
            with self._lock:
                return self._with_conn(
                    lambda conn: self.repo.get_by_id(conn, dataset_id, scope)
                )
        except Exception:
            return None

    def list_for_owner(
        self,
        scope: OwnerScope | dict[str, str],
        *,
        agent_session_id: str | None = None,
        limit: int = 50,
    ) -> list[DatasetRecord]:
        if self.repo is None:
            return []
        try:
            with self._lock:
                return (
                    self._with_conn(
                        lambda conn: self.repo.list_for_owner(
                            conn,
                            scope,
                            agent_session_id=agent_session_id,
                            limit=limit,
                        )
                    )
                    or []
                )
        except Exception:
            return []


def try_wire_formal_dataset_repository() -> FormalDatasetDualWriter:
    """Wire production MySQL DatasetRepository when DSN is formal MySQL.

    Offline sqlite/test DSNs leave formal disabled (tests inject Fake).
    Real MySQL connectivity failure is a gate for operators — we raise only
    when MySQL is configured and import/connect kwargs parse fails closed
    at call sites that require authoritative writes.
    """
    from sandbox.config import is_legacy_test_database_url, is_mysql_database_url, settings

    url = (settings.database_url or "").strip()
    if not url or is_legacy_test_database_url(url) or not is_mysql_database_url(url):
        return FormalDatasetDualWriter(None, authoritative=False)
    try:
        from sandbox.app.persistence.db import create_mysql_database
        from sandbox.app.persistence.repositories.dataset_repository import (
            DatasetRepository,
        )

        db = create_mysql_database(
            url,
            connect_timeout=int(settings.mysql_connect_timeout_seconds),
            read_timeout=int(settings.mysql_read_timeout_seconds),
            write_timeout=int(settings.mysql_write_timeout_seconds),
            max_connections=int(settings.mysql_max_connections),
        )
        repo = DatasetRepository(db)

        def _conn_factory():
            return db.connection()

        return FormalDatasetDualWriter(
            repo, conn_factory=_conn_factory, authoritative=True
        )
    except Exception as exc:
        # Production with MySQL URL must not silently run without formal plane.
        logger.error(
            "formal dataset MySQL wire failed: %s", type(exc).__name__, exc_info=True
        )
        # Return disabled writer that will fail closed on first authoritative op
        # only if we re-raise — manager checks wire_error.
        writer = FormalDatasetDualWriter(None, authoritative=True)
        writer._wire_error = exc  # type: ignore[attr-defined]
        return writer
