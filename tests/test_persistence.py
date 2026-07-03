"""Persistence tests for SQLite-backed sandbox state."""

from __future__ import annotations

import sqlite3

from sandbox.database import Database
from sandbox.models import SessionStatus
from sandbox.services.artifact_manager import ArtifactManager
from sandbox.services.audit_logger import AuditLogger
from sandbox.services.session_manager import SessionManager


def test_database_initializes_schema_and_wal(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'sandbox.db'}")
    db.initialize()

    with db.connect() as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]

    assert {"sessions", "executions", "artifacts", "audit_logs"}.issubset(tables)
    assert journal_mode == "wal"


def test_sessions_persist_across_manager_instances(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'sandbox.db'}")
    db.initialize()
    first = SessionManager(database=db)

    session = first.create(
        agent_session_id="pi_001",
        enterprise_session_id="ent_001",
        user_id="u001",
        caller_id="webui",
        metadata={"topic": "restore"},
    )
    first.update_status(session.session_id, SessionStatus.COMPLETED)

    second = SessionManager(database=db)
    restored = second.get(session.session_id)
    by_agent = second.get_by_agent_session_id("pi_001")
    by_enterprise = second.get_by_enterprise_session_id("ent_001")

    assert restored is not None
    assert restored.status == SessionStatus.COMPLETED
    assert restored.metadata == {"topic": "restore"}
    assert by_agent is not None and by_agent.session_id == session.session_id
    assert by_enterprise is not None and by_enterprise.session_id == session.session_id


def test_artifacts_persist_across_manager_instances(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'sandbox.db'}")
    db.initialize()
    first = ArtifactManager(database=db)

    artifact = first.register(
        session_id="sandbox_abc",
        name="report.txt",
        path="output/report.txt",
        mime_type="text/plain",
        source_execution_id="exec_001",
        size=42,
    )

    second = ArtifactManager(database=db)
    restored = second.get(artifact.artifact_id)
    listed = second.list_by_session("sandbox_abc")

    assert restored is not None
    assert restored.name == "report.txt"
    assert len(listed) == 1
    assert listed[0].artifact_id == artifact.artifact_id


def test_audit_log_persists_to_sqlite(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'sandbox.db'}")
    db.initialize()
    logger = AuditLogger(database=db)

    logger.log_session_lifecycle("sandbox_abc", "created", {"caller_id": "test"})
    logger.log_execution(
        session_id="sandbox_abc",
        execution_id="exec_001",
        run_type="python",
        exit_code=0,
        duration_ms=12.5,
        truncated=False,
    )

    with sqlite3.connect(tmp_path / "sandbox.db") as conn:
        rows = conn.execute(
            "SELECT event_type, session_id, execution_id, payload FROM audit_logs ORDER BY id"
        ).fetchall()

    assert [row[0] for row in rows] == ["session_lifecycle", "execution"]
    assert rows[0][1] == "sandbox_abc"
    assert rows[1][2] == "exec_001"
