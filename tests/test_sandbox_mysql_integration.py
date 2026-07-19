"""MySQL integration tests for Sandbox execution-domain repos (PR-02).

Gated by ``TEST_MYSQL_URL=mysql://...``. Skips when URL is unset **or**
PyMySQL is not installed (no install performed here).

Expects Agent Knex migration already applied so all execution-domain tables
exist (sandbox_sessions, sandbox_executions, sandbox_audit_events,
process_executions, datasets, artifacts). Exercises tenant isolation /
ownership SQL predicates where FK parents allow.
"""

from __future__ import annotations

import os
import uuid

import pytest

TEST_URL = (os.environ.get("TEST_MYSQL_URL") or "").strip()
RUN_INTEGRATION = bool(TEST_URL)


def _pymysql_available() -> bool:
    try:
        import pymysql  # noqa: F401
    except ImportError:
        return False
    return True


HAS_PYMYSQL = _pymysql_available()

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER2 = "01K0G2PAV8FPMVC9QHJG7JPN5A"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT_SESS = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
WSP = "01K0G2PAV8FPMVC9QHJG7JPN56"

REQUIRED_TABLES = (
    "sandbox_sessions",
    "process_executions",
    "sandbox_executions",
    "sandbox_audit_events",
    "datasets",
    "artifacts",
    "idempotency_records",
)


def _ulid_like() -> str:
    """26-char Crockford-ish id for CHAR(26) columns (test-only)."""
    return uuid.uuid4().hex[:26].upper()


class TestIntegrationGate:
    def test_documents_skip_conditions(self) -> None:
        if not RUN_INTEGRATION:
            assert True  # skipped: TEST_MYSQL_URL unset
            return
        if not HAS_PYMYSQL:
            assert True  # skipped: PyMySQL not installed
            return
        assert TEST_URL.startswith("mysql://"), (
            "TEST_MYSQL_URL must use strict mysql:// (Sandbox adapter)"
        )


@pytest.mark.skipif(not RUN_INTEGRATION, reason="TEST_MYSQL_URL unset")
@pytest.mark.skipif(not HAS_PYMYSQL, reason="PyMySQL not installed")
class TestSandboxMysqlIntegration:
    """Live MySQL against full Sandbox execution-domain schema."""

    @pytest.fixture()
    def db(self):
        from sandbox.app.persistence.db import MysqlDatabase, assert_mysql_connection_url
        from sandbox.app.persistence.errors import MysqlConfigError

        try:
            assert_mysql_connection_url(TEST_URL)
        except MysqlConfigError as exc:
            pytest.skip(f"TEST_MYSQL_URL rejected: {exc}")

        database = MysqlDatabase(TEST_URL)
        # Connectivity probe — fail loudly (no silent catch).
        with database.connection() as conn:
            conn.execute("SELECT 1 AS ok")
            row = conn.fetchone()
            assert row is not None
        return database

    def test_all_required_execution_domain_tables_present(self, db) -> None:
        """PR-02 owns these tables — they must exist after Agent migrate."""
        from sandbox.app.persistence.schema_gap import (
            validate_execution_domain_capability,
        )

        with db.connection() as conn:
            present: list[str] = []
            for table in REQUIRED_TABLES:
                conn.execute(
                    """
                    SELECT COUNT(*) AS n
                    FROM information_schema.tables
                    WHERE table_schema = DATABASE() AND table_name = %s
                    """,
                    (table,),
                )
                row = conn.fetchone()
                assert row is not None
                if int(row["n"]) == 0:
                    pytest.skip(
                        f"table {table} not in DATABASE(); apply Agent migration first"
                    )
                present.append(table)

                # InnoDB / utf8mb4 smoke (where engine metadata available)
                conn.execute(
                    """
                    SELECT ENGINE AS engine, TABLE_COLLATION AS coll
                    FROM information_schema.TABLES
                    WHERE table_schema = DATABASE() AND table_name = %s
                    """,
                    (table,),
                )
                meta = conn.fetchone()
                assert meta is not None
                assert "InnoDB" in str(meta.get("engine") or meta.get("ENGINE") or "")
                coll = str(meta.get("coll") or meta.get("COLL") or meta.get("TABLE_COLLATION") or "")
                assert "utf8mb4" in coll.lower()

            result = validate_execution_domain_capability(present)
            assert result["ok"] is True
            assert result["missing"] == []

    def test_process_executions_has_owner_columns(self, db) -> None:
        with db.connection() as conn:
            conn.execute(
                """
                SELECT COLUMN_NAME AS c
                FROM information_schema.COLUMNS
                WHERE table_schema = DATABASE()
                  AND table_name = 'process_executions'
                  AND column_name IN ('org_id', 'user_id')
                """
            )
            rows = conn.fetchall()
            if not rows:
                pytest.skip("process_executions missing; apply Agent migration")
            names = {str(r["c"] if "c" in r else r.get("COLUMN_NAME")) for r in rows}
            assert "org_id" in names and "user_id" in names

    def test_dataset_owner_roundtrip_when_fk_satisfied(self, db) -> None:
        """Insert dataset only if parent FK rows exist; else skip.

        Does not create org/user/conversation/agent_session (Agent authority).
        """
        from sandbox.app.persistence.repositories.dataset_repository import (
            DatasetRepository,
        )

        repo = DatasetRepository(db)
        dataset_id = _ulid_like()

        with db.connection() as conn:
            # Probe whether owner FK parents exist.
            conn.execute(
                "SELECT org_id FROM organizations WHERE org_id = %s",
                (ORG,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed org not present; not creating Agent-owned rows")

        try:
            with db.transaction() as conn:
                row = repo.create(
                    conn,
                    {
                        "dataset_id": dataset_id,
                        "org_id": ORG,
                        "user_id": USER,
                        "conversation_id": CONV,
                        "agent_session_id": AGENT_SESS,
                        "original_filename": "it.csv",
                        "stored_relative_path": "uploads/it.csv",
                        "status": "ready",
                        "size_bytes": 4,
                        "sha256": "d" * 64,
                    },
                )
                assert row.dataset_id == dataset_id
                owned = repo.get_by_id(
                    conn, dataset_id, {"org_id": ORG, "user_id": USER}
                )
                assert owned is not None
                foreign = repo.get_by_id(
                    conn,
                    dataset_id,
                    {
                        "org_id": ORG,
                        "user_id": USER2,
                    },
                )
                assert foreign is None
        except Exception as exc:
            # FK failures mean parent rows missing — skip, do not swallow silently
            # by returning success.
            msg = str(exc).lower()
            if "foreign key" in msg or "cannot add or update" in msg:
                pytest.skip(f"FK parents missing for dataset insert: {exc}")
            raise
        finally:
            # Cleanup the row we may have inserted (errors propagate — no silent catch).
            with db.transaction() as conn:
                conn.execute(
                    "DELETE FROM datasets WHERE dataset_id = %s "
                    "AND org_id = %s AND user_id = %s",
                    (dataset_id, ORG, USER),
                )

    def test_dataset_idempotency_reservation_and_replay(self, db) -> None:
        from sandbox.app.persistence.errors import ConflictError
        from sandbox.app.persistence.repositories.dataset_repository import (
            DatasetRepository,
        )

        repo = DatasetRepository(db)
        dataset_id = _ulid_like()
        replay_candidate = _ulid_like()
        conflict_candidate = _ulid_like()
        key = f"dataset-it-{uuid.uuid4().hex}"
        operation = f"dataset.upload:{CONV}"
        request_hash = "a" * 64

        def upload_input(candidate_id: str, hash_value: str) -> dict[str, object]:
            return {
                "dataset_id": candidate_id,
                "org_id": ORG,
                "user_id": USER,
                "conversation_id": CONV,
                "agent_session_id": AGENT_SESS,
                "original_filename": "idempotent.csv",
                "stored_relative_path": f"datasets/{candidate_id}/idempotent.csv",
                "mime_type": "text/csv",
                "size_bytes": None,
                "sha256": None,
                "status": "uploading",
                "created_at": "2026-07-19 00:00:00.000",
                "completed_at": None,
                "expires_at": "2099-01-01 00:00:00.000",
                "idempotency_key": key,
                "operation": operation,
                "request_hash": hash_value,
            }

        with db.connection() as conn:
            conn.execute(
                "SELECT COUNT(*) AS n FROM information_schema.tables "
                "WHERE table_schema = DATABASE() "
                "AND table_name = 'idempotency_records'"
            )
            row = conn.fetchone()
            if row is None or int(row["n"]) == 0:
                pytest.skip("idempotency_records missing; apply Agent migration")
            conn.execute(
                "SELECT org_id FROM organizations WHERE org_id = %s",
                (ORG,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed org not present; not creating Agent-owned rows")

        try:
            with db.transaction() as conn:
                outcome, reserved = repo.reserve_idempotent_upload(
                    conn,
                    upload_input(dataset_id, request_hash),
                )
                assert outcome == "begun"
                assert reserved.dataset_id == dataset_id
                assert reserved.status == "uploading"

            with db.transaction() as conn:
                completed = repo.complete_idempotent_upload(
                    conn,
                    dataset_id,
                    {"org_id": ORG, "user_id": USER},
                    idempotency_key=key,
                    operation=operation,
                    request_hash=request_hash,
                    size_bytes=4,
                    sha256="b" * 64,
                    completed_at="2026-07-19 00:00:01.000",
                    response_json={"dataset_id": dataset_id, "status": "ready"},
                )
                assert completed.status == "ready"

            with db.transaction() as conn:
                outcome, replayed = repo.reserve_idempotent_upload(
                    conn,
                    upload_input(replay_candidate, request_hash),
                )
                assert outcome == "replay"
                assert replayed.dataset_id == dataset_id

            with pytest.raises(ConflictError):
                with db.transaction() as conn:
                    repo.reserve_idempotent_upload(
                        conn,
                        upload_input(conflict_candidate, "c" * 64),
                    )

            with db.connection() as conn:
                conn.execute(
                    "SELECT COUNT(*) AS n FROM datasets "
                    "WHERE org_id = %s AND user_id = %s "
                    "AND dataset_id IN (%s, %s, %s)",
                    (ORG, USER, dataset_id, replay_candidate, conflict_candidate),
                )
                count_row = conn.fetchone()
                assert count_row is not None
                assert int(count_row["n"]) == 1
        except Exception as exc:
            message = str(exc).lower()
            if "foreign key" in message or "cannot add or update" in message:
                pytest.skip(f"FK parents missing for dataset insert: {exc}")
            raise
        finally:
            with db.transaction() as conn:
                conn.execute(
                    "DELETE FROM idempotency_records "
                    "WHERE org_id = %s AND user_id = %s "
                    "AND idempotency_key = %s AND operation = %s",
                    (ORG, USER, key, operation),
                )
                conn.execute(
                    "DELETE FROM datasets WHERE org_id = %s AND user_id = %s "
                    "AND dataset_id IN (%s, %s, %s)",
                    (ORG, USER, dataset_id, replay_candidate, conflict_candidate),
                )

    def test_sandbox_session_owner_isolation_when_fk_satisfied(self, db) -> None:
        """Create sandbox_sessions row and verify foreign owner cannot read it."""
        from sandbox.app.persistence.repositories.session_repository import (
            SessionRepository,
        )

        repo = SessionRepository(db)
        session_id = _ulid_like()

        with db.connection() as conn:
            conn.execute(
                "SELECT org_id FROM organizations WHERE org_id = %s",
                (ORG,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed org not present; not creating tenant rows")
            conn.execute(
                "SELECT user_id FROM users WHERE user_id = %s",
                (USER,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed user not present")

        try:
            with db.transaction() as conn:
                created = repo.create(
                    conn,
                    {
                        "sandbox_session_id": session_id,
                        "org_id": ORG,
                        "user_id": USER,
                        "agent_session_id": AGENT_SESS,
                        "workspace_id": WSP,
                        "status": "active",
                    },
                )
                assert created.sandbox_session_id == session_id
                owned = repo.get_by_id(
                    conn, session_id, {"org_id": ORG, "user_id": USER}
                )
                assert owned is not None
                foreign = repo.get_by_id(
                    conn, session_id, {"org_id": ORG, "user_id": USER2}
                )
                assert foreign is None
        except Exception as exc:
            msg = str(exc).lower()
            if "foreign key" in msg or "cannot add or update" in msg:
                pytest.skip(f"FK parents missing for sandbox_sessions: {exc}")
            raise
        finally:
            with db.transaction() as conn:
                conn.execute(
                    "DELETE FROM sandbox_sessions WHERE sandbox_session_id = %s "
                    "AND org_id = %s AND user_id = %s",
                    (session_id, ORG, USER),
                )

    def test_audit_owner_isolation_when_fk_satisfied(self, db) -> None:
        from sandbox.app.persistence.repositories.audit_repository import (
            AuditRepository,
        )

        repo = AuditRepository(db)
        audit_id = _ulid_like()
        trace = "e" * 32

        with db.connection() as conn:
            conn.execute(
                "SELECT org_id FROM organizations WHERE org_id = %s",
                (ORG,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed org not present")
            conn.execute(
                "SELECT user_id FROM users WHERE user_id = %s",
                (USER,),
            )
            if conn.fetchone() is None:
                pytest.skip("seed user not present")

        try:
            with db.transaction() as conn:
                repo.insert(
                    conn,
                    {
                        "audit_id": audit_id,
                        "org_id": ORG,
                        "user_id": USER,
                        "event_type": "execution.started",
                        "trace_id": trace,
                        "payload_json": {"k": "v"},
                    },
                )
                owned = repo.list_by_trace_id(
                    conn, trace, {"org_id": ORG, "user_id": USER}
                )
                assert len(owned) >= 1
                foreign = repo.list_by_trace_id(
                    conn, trace, {"org_id": ORG, "user_id": USER2}
                )
                assert foreign == []
        except Exception as exc:
            msg = str(exc).lower()
            if "foreign key" in msg or "cannot add or update" in msg:
                pytest.skip(f"FK parents missing for sandbox_audit_events: {exc}")
            raise
        finally:
            with db.transaction() as conn:
                conn.execute(
                    "DELETE FROM sandbox_audit_events WHERE audit_id = %s "
                    "AND org_id = %s AND user_id = %s",
                    (audit_id, ORG, USER),
                )
