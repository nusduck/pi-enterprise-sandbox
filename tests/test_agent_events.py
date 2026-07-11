"""Agent session persistence: events, leases, tool ledger, interrupted status."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from sandbox.database import Database
from sandbox.models import AgentRunStatus, ToolExecutionStatus
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    ConversationRepository,
    ToolExecutionRepository,
)
from sandbox.services.agent_run_manager import AgentRunManager
from sandbox.services.ttl_cleanup import cleanup_expired_drafts, draft_cutoff_iso


@pytest.fixture
def db(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'agent.db'}")
    database.initialize()
    return database


@pytest.fixture
def mgr(db):
    return AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )


@pytest.fixture
def conversation(db):
    repo = ConversationRepository(db)
    return repo.upsert(
        {
            "id": "conv_test_1",
            "title": "Test",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )


def test_schema_has_agent_tables(db, tmp_path):
    with sqlite3.connect(tmp_path / "agent.db") as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(conversations)").fetchall()
        }
    assert {"agent_runs", "agent_events", "tool_executions"}.issubset(tables)
    assert {"interrupted", "last_run_id", "legal_hold"}.issubset(cols)


def test_migrate_agent_session_schema_idempotent_alter(tmp_path):
    """ALTER-safe dual dialect path: apply migration on legacy-like DB twice."""
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New conversation',
                sandbox_session_id TEXT,
                workspace_path TEXT,
                messages TEXT NOT NULL DEFAULT '[]',
                owner_user_id TEXT,
                organization_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.commit()

    db = Database(f"sqlite:///{path}")
    # initialize runs full schema + migrations
    report1 = db.migrate_agent_session()
    report2 = db.migrate_agent_session()
    assert report1["tables_ensured"] >= 3
    # second run should not re-add columns
    assert report2["columns_added"] == 0

    with sqlite3.connect(path) as conn:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(conversations)").fetchall()
        }
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert "interrupted" in cols and "last_run_id" in cols
    assert "agent_runs" in tables and "agent_events" in tables


def test_event_sequence_uniqueness_and_recovery_list(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    # start_run already appends run_started (seq 1)
    e2 = mgr.append_event(run.run_id, event_type="token_batch", payload={"text": "hi"})
    e3 = mgr.append_event(run.run_id, event_type="tool_start", payload={"name": "bash"})
    e4 = mgr.append_event(run.run_id, event_type="done", payload={})

    events = mgr.list_events(run.run_id)
    sequences = [e.sequence for e in events]
    assert sequences == sorted(sequences)
    assert len(set(sequences)) == len(sequences)
    assert sequences[0] == 1
    assert e2.sequence == 2
    assert e3.sequence == 3
    assert e4.sequence == 4

    # Recovery list after sequence 2
    tail = mgr.list_events(run.run_id, after_sequence=2)
    assert [e.sequence for e in tail] == [3, 4]
    assert tail[0].type == "tool_start"


def test_event_sequence_unique_constraint_conflict(db, conversation):
    runs = AgentRunRepository(db)
    events = AgentEventRepository(db)
    run = runs.create(
        {
            "run_id": "run_seq_conflict",
            "conversation_id": conversation.id,
            "status": "running",
            "version": 0,
        }
    )
    events.append(run_id=run.run_id, event_type="a", payload={})
    # Force insert of same sequence to prove unique constraint
    with db.connect() as conn:
        with pytest.raises(Exception):
            conn.execute(
                """
                INSERT INTO agent_events (
                    run_id, sequence, event_id, type, payload, schema_version, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    run.run_id,
                    1,
                    "evt_dup",
                    "dup",
                    "{}",
                    1,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()


def test_lease_claim_conflict(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="owner_a")
    assert run.lease_owner == "owner_a"
    assert run.status == AgentRunStatus.RUNNING.value

    # Another owner cannot steal an active lease
    conflict = mgr.claim_lease(
        run.run_id,
        lease_owner="owner_b",
        expected_version=run.version,
        lease_seconds=60,
    )
    assert conflict is None

    # Same owner can renew with correct version
    renewed = mgr.claim_lease(
        run.run_id,
        lease_owner="owner_a",
        expected_version=run.version,
        lease_seconds=60,
    )
    assert renewed is not None
    assert renewed.version == run.version + 1
    assert renewed.lease_owner == "owner_a"

    # Wrong expected_version fails
    stale = mgr.claim_lease(
        run.run_id,
        lease_owner="owner_a",
        expected_version=run.version,  # stale
        lease_seconds=60,
    )
    assert stale is None


def test_lease_claim_after_expiry(db, conversation):
    runs = AgentRunRepository(db)
    past = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    run = runs.create(
        {
            "run_id": "run_expired_lease",
            "conversation_id": conversation.id,
            "status": "running",
            "lease_owner": "old_owner",
            "lease_until": past,
            "version": 3,
        }
    )
    future = (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()
    claimed = runs.claim_lease(
        run.run_id,
        lease_owner="new_owner",
        lease_until=future,
        expected_version=3,
    )
    assert claimed is not None
    assert claimed.lease_owner == "new_owner"
    assert claimed.version == 4


def test_tool_unknown_not_auto_retry(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_1",
        run_id=run.run_id,
        idempotency_key="idem_1",
        summary="bash ls",
    )
    assert tool.status == ToolExecutionStatus.PREPARED.value
    assert mgr.tool_can_auto_retry("tc_1") is True

    mgr.mark_tool_executing("tc_1")
    assert mgr.tool_can_auto_retry("tc_1") is True

    terminal = mgr.mark_tool_terminal(
        "tc_1", ToolExecutionStatus.UNKNOWN.value, summary="crash mid-flight"
    )
    assert terminal is not None
    assert terminal.status == ToolExecutionStatus.UNKNOWN.value
    # Core invariant: unknown never auto-retries
    assert mgr.tool_can_auto_retry("tc_1") is False

    # Cannot overwrite terminal unknown
    again = mgr.mark_tool_terminal("tc_1", ToolExecutionStatus.SUCCEEDED.value)
    assert again is not None
    assert again.status == ToolExecutionStatus.UNKNOWN.value


def test_tool_idempotency_prepare(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    a = mgr.prepare_tool(
        tool_call_id="tc_a",
        run_id=run.run_id,
        idempotency_key="same_key",
    )
    b = mgr.prepare_tool(
        tool_call_id="tc_b",
        run_id=run.run_id,
        idempotency_key="same_key",
    )
    assert a.tool_call_id == b.tool_call_id == "tc_a"


def test_interrupted_status_dual_write(mgr, conversation, db):
    conv_repo = ConversationRepository(db)
    # Seed a partial assistant message as dual-write would
    conv_repo.update_messages(
        conversation.id,
        [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "partial answer"},
        ],
    )
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    updated = mgr.mark_interrupted(
        run.run_id, reason="client_disconnect", partial_text="partial answer"
    )
    assert updated is not None
    assert updated.status == AgentRunStatus.INTERRUPTED.value

    conv = conv_repo.get(conversation.id)
    assert conv is not None
    assert conv.interrupted is True
    assert conv.last_run_id == run.run_id
    last = conv.messages[-1]
    assert last["role"] == "assistant"
    assert last.get("interrupted") is True
    assert last.get("status") == "interrupted"

    events = mgr.list_events(run.run_id)
    types = [e.type for e in events]
    assert "interrupted" in types


def test_complete_run_clears_interrupted(mgr, conversation, db):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.mark_interrupted(run.run_id, reason="test")
    completed = mgr.complete_run(run.run_id, lease_owner="w1")
    assert completed is not None
    assert completed.status == AgentRunStatus.COMPLETED.value
    conv = ConversationRepository(db).get(conversation.id)
    assert conv is not None
    assert conv.interrupted is False
    assert conv.last_run_id == run.run_id


def test_ttl_cleanup_skips_legal_hold_and_deletes_drafts(db):
    repo = ConversationRepository(db)
    old = (datetime.now(timezone.utc) - timedelta(hours=48)).isoformat()
    # Expired draft
    repo.upsert(
        {
            "id": "draft_old",
            "title": "Draft",
            "messages": [],
            "created_at": old,
            "updated_at": old,
            "legal_hold": False,
        }
    )
    # Legal hold draft — must not delete
    repo.upsert(
        {
            "id": "draft_hold",
            "title": "Hold",
            "messages": [],
            "created_at": old,
            "updated_at": old,
            "legal_hold": True,
        }
    )
    # Active conversation with messages — keep
    repo.upsert(
        {
            "id": "active_conv",
            "title": "Active",
            "messages": [{"role": "user", "content": "hi"}],
            "created_at": old,
            "updated_at": old,
        }
    )

    report = cleanup_expired_drafts(db_conversations=repo, dry_run=False)
    assert "draft_old" in report["deleted"]
    assert "draft_hold" not in report["deleted"]
    assert "active_conv" not in report["deleted"]
    assert repo.get("draft_old") is None
    assert repo.get("draft_hold") is not None
    assert repo.get("active_conv") is not None
    assert report["draft_ttl_hours"] == 24
    assert report["conversation_ttl_days"] == 90
    assert report["audit_ttl_days"] == 180
    # cutoff should be ~24h ago
    cutoff = draft_cutoff_iso()
    assert cutoff < datetime.now(timezone.utc).isoformat()


def test_conversation_last_run_and_events_endpoint_data(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.append_event(run.run_id, event_type="token_batch", payload={"text": "x"})
    latest = mgr.get_last_run_for_conversation(conversation.id)
    assert latest is not None
    assert latest.run_id == run.run_id
    events = mgr.list_events(latest.run_id)
    assert len(events) >= 2
