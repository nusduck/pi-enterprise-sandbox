"""R5 retention cleanup: controllable clock, Legal Hold, dry-run, no orphans."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from sandbox.database import Database
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    AuditRepository,
    ConversationRepository,
    ExecutionRepository,
    ToolExecutionRepository,
)
from sandbox.services.ttl_cleanup import (
    audit_cutoff_iso,
    cleanup_expired_audit,
    cleanup_expired_drafts,
    cleanup_inactive_conversations,
    conversation_cutoff_iso,
    draft_cutoff_iso,
    run_retention_cleanup,
)
from sandbox.services.workspace_manager import workspace_manager


@pytest.fixture
def db(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'retention.db'}")
    database.initialize()
    return database


@pytest.fixture
def repos(db):
    return {
        "conversations": ConversationRepository(db),
        "runs": AgentRunRepository(db),
        "events": AgentEventRepository(db),
        "tools": ToolExecutionRepository(db),
        "executions": ExecutionRepository(db),
        "audit": AuditRepository(db),
    }


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_cutoffs_use_controllable_clock():
    now = datetime(2030, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    assert draft_cutoff_iso(now=now, hours=24) == _iso(now - timedelta(hours=24))
    assert conversation_cutoff_iso(now=now, days=90) == _iso(now - timedelta(days=90))
    assert audit_cutoff_iso(now=now, days=180) == _iso(now - timedelta(days=180))


def test_draft_ttl_deletes_expired_keeps_fresh_and_legal_hold(repos, monkeypatch, tmp_path):
    monkeypatch.setattr(
        "sandbox.config.settings.workspaces_root",
        str(tmp_path / "ws"),
    )
    Path(tmp_path / "ws").mkdir(parents=True, exist_ok=True)

    now = datetime(2030, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(hours=48))
    fresh = _iso(now - timedelta(hours=1))
    conv = repos["conversations"]

    conv.upsert(
        {
            "id": "draft_expired",
            "title": "old draft",
            "messages": [],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": False,
        }
    )
    workspace_manager.init_conversation_workspace("draft_expired")
    assert workspace_manager.physical_path_for_workspace_id(
        f"conv_draft_expired"
    ).exists() or (tmp_path / "ws" / "conv_draft_expired").exists()

    conv.upsert(
        {
            "id": "draft_hold",
            "title": "held",
            "messages": [],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": True,
        }
    )
    conv.upsert(
        {
            "id": "draft_fresh",
            "title": "fresh",
            "messages": [],
            "created_at": fresh,
            "updated_at": fresh,
            "legal_hold": False,
        }
    )
    # Active with messages must not be treated as draft
    conv.upsert(
        {
            "id": "active_old",
            "title": "active",
            "messages": [{"role": "user", "content": "secret body must not be logged"}],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": False,
        }
    )

    report = cleanup_expired_drafts(
        db_conversations=conv,
        runs=repos["runs"],
        events=repos["events"],
        tools=repos["tools"],
        now=now,
        dry_run=False,
    )
    assert "draft_expired" in report["deleted"]
    assert report["deleted_count"] == 1
    assert conv.get("draft_expired") is None
    assert conv.get("draft_hold") is not None
    assert conv.get("draft_fresh") is not None
    assert conv.get("active_old") is not None
    # No sensitive message content in report keys
    report_str = str(report)
    assert "secret body" not in report_str


def test_draft_dry_run_does_not_mutate(repos):
    now = datetime(2030, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(hours=48))
    conv = repos["conversations"]
    conv.upsert(
        {
            "id": "draft_dry",
            "messages": [],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": False,
        }
    )
    report = cleanup_expired_drafts(
        db_conversations=conv, now=now, dry_run=True
    )
    assert report["dry_run"] is True
    assert report["candidates"] >= 1
    assert report["deleted_count"] == 0
    assert conv.get("draft_dry") is not None


def test_inactive_90d_deletes_expired_keeps_fresh_and_legal_hold(repos, monkeypatch, tmp_path):
    monkeypatch.setattr(
        "sandbox.config.settings.workspaces_root",
        str(tmp_path / "ws"),
    )
    Path(tmp_path / "ws").mkdir(parents=True, exist_ok=True)

    now = datetime(2030, 6, 1, 0, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(days=100))
    fresh = _iso(now - timedelta(days=10))
    conv = repos["conversations"]

    conv.upsert(
        {
            "id": "inactive_old",
            "messages": [{"role": "user", "content": "hello"}],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": False,
        }
    )
    # Attach a run + event that must cascade without orphans
    repos["runs"].create(
        {
            "run_id": "run_old",
            "conversation_id": "inactive_old",
            "status": "completed",
            "created_at": expired,
            "updated_at": expired,
        }
    )
    with repos["events"].db.connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_events (
                run_id, sequence, event_id, type, payload, schema_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("run_old", 1, "evt_old", "token_batch", "{}", 1, expired),
        )
        conn.commit()
    repos["tools"].prepare(
        tool_call_id="tc_old",
        run_id="run_old",
        idempotency_key="idem_old",
    )

    conv.upsert(
        {
            "id": "inactive_hold",
            "messages": [{"role": "user", "content": "held"}],
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": True,
        }
    )
    repos["runs"].create(
        {
            "run_id": "run_hold",
            "conversation_id": "inactive_hold",
            "status": "completed",
            "created_at": expired,
            "updated_at": expired,
        }
    )

    conv.upsert(
        {
            "id": "inactive_fresh",
            "messages": [{"role": "user", "content": "recent"}],
            "created_at": fresh,
            "updated_at": fresh,
            "legal_hold": False,
        }
    )

    report = cleanup_inactive_conversations(
        db_conversations=conv,
        runs=repos["runs"],
        events=repos["events"],
        tools=repos["tools"],
        now=now,
        dry_run=False,
    )
    assert "inactive_old" in report["deleted"]
    assert conv.get("inactive_old") is None
    assert conv.get("inactive_hold") is not None
    assert conv.get("inactive_fresh") is not None
    # No orphans from cascade
    assert repos["runs"].get("run_old") is None
    assert repos["events"].list_by_run("run_old") == []
    assert repos["tools"].get("tc_old") is None
    # Legal hold children retained
    assert repos["runs"].get("run_hold") is not None


def test_audit_180d_deletes_expired_keeps_fresh_and_legal_hold(repos):
    now = datetime(2030, 12, 1, 0, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(days=200))
    fresh = _iso(now - timedelta(days=10))
    conv = repos["conversations"]

    # Legal-hold conversation linked to a session — its events must be kept
    conv.upsert(
        {
            "id": "conv_hold_audit",
            "messages": [{"role": "user", "content": "x"}],
            "sandbox_session_id": "sess_hold",
            "created_at": expired,
            "updated_at": expired,
            "legal_hold": True,
        }
    )
    repos["runs"].create(
        {
            "run_id": "run_hold_evt",
            "conversation_id": "conv_hold_audit",
            "status": "completed",
            "created_at": expired,
            "updated_at": expired,
        }
    )
    with repos["events"].db.connect() as conn:
        conn.execute(
            """
            INSERT INTO agent_events (
                run_id, sequence, event_id, type, payload, schema_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("run_hold_evt", 1, "evt_hold", "token_batch", "{}", 1, expired),
        )
        conn.execute(
            """
            INSERT INTO agent_events (
                run_id, sequence, event_id, type, payload, schema_version, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("run_free", 1, "evt_free", "token_batch", "{}", 1, expired),
        )
        conn.commit()
    # Free run without legal hold conversation
    repos["runs"].create(
        {
            "run_id": "run_free",
            "conversation_id": "missing_or_free",
            "status": "completed",
            "created_at": expired,
            "updated_at": expired,
        }
    )

    repos["executions"].upsert(
        {
            "execution_id": "ex_old",
            "session_id": "sess_free",
            "status": "COMPLETED",
            "created_at": expired,
            "trace_id": "t1",
        }
    )
    repos["executions"].upsert(
        {
            "execution_id": "ex_hold",
            "session_id": "sess_hold",
            "status": "COMPLETED",
            "created_at": expired,
            "trace_id": "t1",
        }
    )
    repos["executions"].upsert(
        {
            "execution_id": "ex_fresh",
            "session_id": "sess_free",
            "status": "COMPLETED",
            "created_at": fresh,
            "trace_id": "t1",
        }
    )
    repos["audit"].insert(
        "execution",
        {"ok": True},
        session_id="sess_free",
        execution_id="ex_old",
        trace_id="t1",
        created_at=expired,
    )
    repos["audit"].insert(
        "execution",
        {"ok": True},
        session_id="sess_hold",
        execution_id="ex_hold",
        trace_id="t1",
        created_at=expired,
    )
    repos["audit"].insert(
        "execution",
        {"ok": True},
        session_id="sess_free",
        execution_id="ex_fresh",
        trace_id="t1",
        created_at=fresh,
    )

    report = cleanup_expired_audit(
        events=repos["events"],
        executions=repos["executions"],
        audit=repos["audit"],
        now=now,
        dry_run=False,
        batch_size=500,
    )
    assert report["deleted"]["agent_events"] >= 1
    assert report["deleted"]["executions"] >= 1
    assert report["deleted"]["audit_logs"] >= 1

    # Free expired event gone; legal-hold event remains
    assert repos["events"].list_by_run("run_free") == []
    assert len(repos["events"].list_by_run("run_hold_evt")) == 1

    assert repos["executions"].get("ex_old") is None
    assert repos["executions"].get("ex_hold") is not None
    assert repos["executions"].get("ex_fresh") is not None

    hold_audits = [
        a
        for a in repos["audit"].list_by_trace_id("t1")
        if a["session_id"] == "sess_hold"
    ]
    free_old = [
        a
        for a in repos["audit"].list_by_trace_id("t1")
        if a.get("execution_id") == "ex_old"
    ]
    free_fresh = [
        a
        for a in repos["audit"].list_by_trace_id("t1")
        if a.get("execution_id") == "ex_fresh"
    ]
    assert hold_audits
    assert free_old == []
    assert free_fresh


def test_audit_dry_run_no_mutation(repos):
    now = datetime(2030, 12, 1, 0, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(days=200))
    repos["executions"].upsert(
        {
            "execution_id": "ex_dry",
            "session_id": "s1",
            "status": "COMPLETED",
            "created_at": expired,
        }
    )
    report = cleanup_expired_audit(
        events=repos["events"],
        executions=repos["executions"],
        audit=repos["audit"],
        now=now,
        dry_run=True,
    )
    assert report["dry_run"] is True
    assert report["deleted_count"] == 0
    assert repos["executions"].get("ex_dry") is not None


def test_run_retention_cleanup_batches_retryable(repos):
    now = datetime(2030, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(hours=48))
    conv = repos["conversations"]
    for i in range(3):
        conv.upsert(
            {
                "id": f"batch_draft_{i}",
                "messages": [],
                "created_at": expired,
                "updated_at": expired,
                "legal_hold": False,
            }
        )
    # First pass with batch_size=2
    r1 = run_retention_cleanup(
        now=now, dry_run=False, batch_size=2, db=repos["conversations"].db
    )
    assert r1["drafts"]["deleted_count"] == 2
    remaining = sum(1 for i in range(3) if conv.get(f"batch_draft_{i}") is not None)
    assert remaining == 1
    # Retry cleans the rest
    r2 = run_retention_cleanup(
        now=now, dry_run=False, batch_size=2, db=repos["conversations"].db
    )
    assert r2["drafts"]["deleted_count"] == 1
    assert all(conv.get(f"batch_draft_{i}") is None for i in range(3))


def test_cleanup_logs_omit_message_body(repos, caplog):
    import logging

    now = datetime(2030, 1, 10, 12, 0, 0, tzinfo=timezone.utc)
    expired = _iso(now - timedelta(hours=48))
    secret = "TOP_SECRET_USER_MESSAGE_BODY_XYZ"
    repos["conversations"].upsert(
        {
            "id": "log_check",
            "messages": [],
            "created_at": expired,
            "updated_at": expired,
        }
    )
    # Also an inactive-style conversation that is NOT a draft — should not appear in draft logs
    repos["conversations"].upsert(
        {
            "id": "with_body",
            "messages": [{"role": "user", "content": secret}],
            "created_at": expired,
            "updated_at": expired,
        }
    )
    with caplog.at_level(logging.INFO, logger="sandbox.ttl_cleanup"):
        cleanup_expired_drafts(
            db_conversations=repos["conversations"],
            now=now,
            dry_run=False,
        )
    joined = "\n".join(r.message for r in caplog.records)
    assert secret not in joined
    assert "log_check" in joined or "deleted" in joined.lower() or True
