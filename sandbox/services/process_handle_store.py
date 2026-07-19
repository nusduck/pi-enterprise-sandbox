"""MySQL-backed process handle persistence ports.

Lifecycle rows are written through the formal owner-scoped repository. Tests
may inject ``FakeFormalProcessRepository`` without introducing another runtime
fact store.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Protocol

from sandbox.app.domain.types import OwnerScope, ProcessRecord
from sandbox.app.persistence.errors import NotFoundError, OwnershipError
from sandbox.app.persistence.mappers import to_mysql_datetime

logger = logging.getLogger("sandbox.process_handle_store")


class FormalProcessRepositoryPort(Protocol):
    """Minimal formal process_executions port used by ProcessManager dual-write."""

    def create(self, conn: Any, input: dict[str, Any]) -> ProcessRecord: ...

    def get_by_id(
        self,
        conn: Any,
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        sandbox_session_id: str | None = None,
    ) -> ProcessRecord | None: ...

    def update_status(
        self,
        conn: Any,
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        sandbox_session_id: str | None = None,
        pid: int | None = None,
        exit_code: int | None = None,
        stdout_path: str | None = None,
        stderr_path: str | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
        command_json: dict[str, Any] | None = None,
    ) -> ProcessRecord: ...

    def list_active_for_recovery(
        self, conn: Any, *, limit: int = 1000
    ) -> list[ProcessRecord]: ...

    def list_by_sandbox_session(
        self,
        conn: Any,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 100,
    ) -> list[ProcessRecord]: ...


@dataclass
class FakeFormalProcessRepository:
    """In-memory formal process repository for offline tests (owner fail-closed)."""

    rows: dict[str, dict[str, Any]] = field(default_factory=dict)
    _lock: threading.RLock = field(default_factory=threading.RLock)

    def create(self, conn: Any, input: dict[str, Any]) -> ProcessRecord:  # noqa: ARG002
        from sandbox.app.persistence.ownership import require_owner_scope

        scope = require_owner_scope(input, resource="process_executions")
        pid = input["process_id"]
        with self._lock:
            if pid in self.rows:
                raise OwnershipError(
                    "process_id already exists",
                    resource="process_executions",
                    id=pid,
                )
            row = {
                "process_id": pid,
                "org_id": scope.org_id,
                "user_id": scope.user_id,
                "sandbox_session_id": input["sandbox_session_id"],
                "run_id": input["run_id"],
                "execution_id": input["execution_id"],
                "command_json": input.get("command_json") or {},
                "status": input["status"],
                "pid": input.get("pid"),
                "exit_code": input.get("exit_code"),
                "stdout_path": input.get("stdout_path"),
                "stderr_path": input.get("stderr_path"),
                "started_at": input.get("started_at"),
                "ended_at": input.get("ended_at"),
                "created_at": input.get("created_at") or to_mysql_datetime(),
            }
            self.rows[pid] = row
            return self._to_record(row)

    def get_by_id(
        self,
        conn: Any,  # noqa: ARG002
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        sandbox_session_id: str | None = None,
    ) -> ProcessRecord | None:
        from sandbox.app.persistence.ownership import require_owner_scope

        s = require_owner_scope(scope, resource="process_executions")
        with self._lock:
            row = self.rows.get(process_id)
            if row is None:
                return None
            if row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                return None
            if (
                sandbox_session_id is not None
                and row["sandbox_session_id"] != sandbox_session_id
            ):
                return None
            return self._to_record(row)

    def update_status(
        self,
        conn: Any,  # noqa: ARG002
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        sandbox_session_id: str | None = None,
        pid: int | None = None,
        exit_code: int | None = None,
        stdout_path: str | None = None,
        stderr_path: str | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
        command_json: dict[str, Any] | None = None,
    ) -> ProcessRecord:
        from sandbox.app.persistence.ownership import require_owner_scope

        s = require_owner_scope(scope, resource="process_executions")
        with self._lock:
            row = self.rows.get(process_id)
            if row is None or row["org_id"] != s.org_id or row["user_id"] != s.user_id:
                raise NotFoundError(
                    "Process not found",
                    resource="process_executions",
                    id=process_id,
                )
            if (
                sandbox_session_id is not None
                and row["sandbox_session_id"] != sandbox_session_id
            ):
                raise NotFoundError(
                    "Process not found",
                    resource="process_executions",
                    id=process_id,
                )
            row["status"] = status
            if command_json is not None:
                row["command_json"] = dict(command_json)
            if pid is not None:
                row["pid"] = pid
            if exit_code is not None:
                row["exit_code"] = exit_code
            if stdout_path is not None:
                row["stdout_path"] = stdout_path
            if stderr_path is not None:
                row["stderr_path"] = stderr_path
            if started_at is not None:
                row["started_at"] = started_at
            if ended_at is not None:
                row["ended_at"] = ended_at
            return self._to_record(row)

    def list_by_sandbox_session(
        self,
        conn: Any,  # noqa: ARG002
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 100,
    ) -> list[ProcessRecord]:
        from sandbox.app.persistence.ownership import require_owner_scope

        s = require_owner_scope(scope, resource="process_executions")
        with self._lock:
            out = [
                self._to_record(r)
                for r in self.rows.values()
                if r["sandbox_session_id"] == sandbox_session_id
                and r["org_id"] == s.org_id
                and r["user_id"] == s.user_id
            ]
        return out[: int(limit)]

    def list_active_for_recovery(
        self, conn: Any, *, limit: int = 1000
    ) -> list[ProcessRecord]:  # noqa: ARG002
        terminal = {"completed", "failed", "cancelled", "timeout", "orphaned", "lost"}
        with self._lock:
            rows = [
                self._to_record(row)
                for row in self.rows.values()
                if str(row.get("status", "")).lower() not in terminal
            ]
        return rows[: int(limit)]

    @staticmethod
    def _to_record(row: dict[str, Any]) -> ProcessRecord:
        return ProcessRecord(
            process_id=str(row["process_id"]),
            org_id=str(row["org_id"]),
            user_id=str(row["user_id"]),
            sandbox_session_id=str(row["sandbox_session_id"]),
            run_id=str(row["run_id"]),
            execution_id=str(row["execution_id"]),
            command_json=row.get("command_json") or {},
            status=str(row["status"]),
            created_at=str(row.get("created_at") or ""),
            pid=row.get("pid"),
            exit_code=row.get("exit_code"),
            stdout_path=row.get("stdout_path"),
            stderr_path=row.get("stderr_path"),
            started_at=row.get("started_at"),
            ended_at=row.get("ended_at"),
        )


class FormalProcessDualWriter:
    """Write process lifecycle rows to formal ``process_executions``.

    The production lifespan installs this writer with ``authoritative=True``
    so a missing owner binding or failed transaction prevents an undurable
    process. Offline service tests may use the fake repository explicitly.
    """

    def __init__(
        self,
        repo: FormalProcessRepositoryPort | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = False,
    ) -> None:
        self.repo = repo
        self.conn_factory = conn_factory
        self.authoritative = bool(authoritative)
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self.repo is not None

    def get_owned(
        self,
        process_id: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
    ) -> ProcessRecord | None:
        """Owner/session-scoped formal read used by internal process tools."""
        if self.repo is None:
            if self.authoritative:
                raise RuntimeError("formal process repository is unavailable")
            return None
        scope = OwnerScope(org_id=org_id, user_id=user_id)
        return self._with_conn(
            lambda conn: self.repo.get_by_id(
                conn,
                process_id,
                scope,
                sandbox_session_id=sandbox_session_id,
            )
        )

    def _with_conn(self, fn: Any) -> Any:
        if self.repo is None:
            return None
        if self.conn_factory is None:
            return fn(None)
        maybe = self.conn_factory()
        if hasattr(maybe, "__enter__"):
            with maybe as conn:
                try:
                    result = fn(conn)
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

    def upsert_from_runtime(self, entry: dict[str, Any]) -> bool:
        if self.repo is None:
            if self.authoritative:
                raise RuntimeError("formal process repository is unavailable")
            return False
        org_id = (entry.get("org_id") or "").strip()
        user_id = (entry.get("user_id") or "").strip()
        sandbox_session_id = (
            entry.get("sandbox_session_id") or entry.get("session_id") or ""
        ).strip()
        run_id = (entry.get("run_id") or "").strip()
        execution_id = (entry.get("execution_id") or entry.get("process_id") or "").strip()
        process_id = (entry.get("process_id") or "").strip()
        if not (org_id and user_id and sandbox_session_id and run_id and process_id):
            if self.authoritative:
                raise ValueError(
                    "formal process persistence requires owner, session, and run binding"
                )
            return False
        scope = OwnerScope(org_id=org_id, user_id=user_id)
        status = entry.get("status")
        if hasattr(status, "value"):
            status = status.value
        status_s = str(status or "created")
        # Formal schema uses uppercase-ish status in some paths; keep as-is string.
        command_json = {
            "command": entry.get("command") or "",
            "cwd": entry.get("cwd"),
            "pgid": entry.get("pgid"),
            "start_identity": entry.get("start_identity"),
            "timeout_seconds": entry.get("timeout_seconds"),
            "background": bool(entry.get("background")),
        }
        payload = {
            "process_id": process_id,
            "org_id": org_id,
            "user_id": user_id,
            "sandbox_session_id": sandbox_session_id,
            "run_id": run_id,
            "execution_id": execution_id,
            "command_json": command_json,
            "status": status_s,
            "pid": entry.get("pid"),
            "exit_code": entry.get("exit_code"),
            "stdout_path": entry.get("stdout_path"),
            "stderr_path": entry.get("stderr_path"),
            "started_at": entry.get("started_at"),
            "ended_at": entry.get("finished_at") or entry.get("ended_at"),
            "created_at": entry.get("created_at"),
        }
        try:
            with self._lock:
                def _upsert(conn: Any) -> None:
                    existing = self.repo.get_by_id(
                        conn,
                        process_id,
                        scope,
                        sandbox_session_id=sandbox_session_id,
                    )
                    if existing is None:
                        self.repo.create(conn, payload)
                    else:
                        self.repo.update_status(
                            conn,
                            process_id,
                            scope,
                            status=status_s,
                            sandbox_session_id=sandbox_session_id,
                            pid=entry.get("pid"),
                            exit_code=entry.get("exit_code"),
                            stdout_path=entry.get("stdout_path"),
                            stderr_path=entry.get("stderr_path"),
                            started_at=entry.get("started_at"),
                            ended_at=(
                                entry.get("finished_at") or entry.get("ended_at")
                            ),
                            command_json=command_json,
                        )

                self._with_conn(_upsert)
            return True
        except Exception:
            if self.authoritative:
                raise
            logger.debug(
                "formal process dual-write failed for %s", process_id, exc_info=True
            )
            return False

    def list_active_for_recovery(self, *, limit: int = 1000) -> list[ProcessRecord]:
        if self.repo is None:
            if self.authoritative:
                raise RuntimeError("formal process repository is unavailable")
            return []
        return self._with_conn(
            lambda conn: self.repo.list_active_for_recovery(conn, limit=limit)
        )
