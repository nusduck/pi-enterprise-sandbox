"""Agent session persistence: events, leases, tool ledger, interrupted status."""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from sandbox.database import Database
from sandbox.models import AgentRunStatus, ToolExecutionStatus
from sandbox.repositories import (
    MAX_APPEND_SEQUENCE_RETRIES,
    AgentEventIdConflictError,
    AgentEventRepository,
    AgentRunNotFoundError,
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


def test_event_append_requires_durable_parent_run(db):
    events = AgentEventRepository(db)

    with pytest.raises(AgentRunNotFoundError):
        events.append(run_id="run_missing", event_type="token_batch", payload={"text": "x"})

    assert events.list_by_run("run_missing") == []
    with db.connect() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM agent_events WHERE run_id = ?",
            ("run_missing",),
        ).fetchone()["count"]
    assert count == 0


def test_start_run_failure_terminalizes_created_row(mgr, conversation, monkeypatch):
    """Ancillary start-up failure cannot leave a running durable orphan."""
    def fail_projection(*args, **kwargs):
        raise RuntimeError("projection failed")

    monkeypatch.setattr(mgr.conversations, "set_last_run_id", fail_projection)
    with pytest.raises(RuntimeError, match="projection failed"):
        mgr.start_run(conversation_id=conversation.id, lease_owner="w1")

    runs = mgr.runs.list_by_conversation(conversation.id)
    assert len(runs) == 1
    assert runs[0].status == AgentRunStatus.FAILED.value
    assert runs[0].lease_owner is None


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
    # Side-effect safety (B4): executing must not auto-retry
    assert mgr.tool_can_auto_retry("tc_1") is False

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


def test_late_complete_does_not_overwrite_interrupted_terminal(
    mgr, conversation, db
):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.mark_interrupted(run.run_id, reason="test")
    completed = mgr.complete_run(run.run_id, lease_owner="w1")
    assert completed is not None
    assert completed.status == AgentRunStatus.INTERRUPTED.value
    conv = ConversationRepository(db).get(conversation.id)
    assert conv is not None
    assert conv.interrupted is True
    assert conv.last_run_id == run.run_id


def test_new_completed_run_clears_prior_interrupted_projection(
    mgr, conversation, db
):
    interrupted = mgr.start_run(
        conversation_id=conversation.id, lease_owner="w1"
    )
    mgr.mark_interrupted(interrupted.run_id, reason="test")

    current = mgr.start_run(
        conversation_id=conversation.id, lease_owner="w2"
    )
    completed = mgr.complete_run(current.run_id, lease_owner="w2")

    assert completed is not None
    assert completed.status == AgentRunStatus.COMPLETED.value
    conv = ConversationRepository(db).get(conversation.id)
    assert conv is not None
    assert conv.interrupted is False
    assert conv.last_run_id == current.run_id


def test_terminal_run_reconciles_unfinished_tool_rows(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    prepared = mgr.prepare_tool(
        tool_call_id="tc_prepared",
        run_id=run.run_id,
        idempotency_key="idem_prepared",
    )
    executing = mgr.prepare_tool(
        tool_call_id="tc_executing",
        run_id=run.run_id,
        idempotency_key="idem_executing",
    )
    mgr.mark_tool_executing(executing.tool_call_id)

    completed = mgr.complete_run(run.run_id, lease_owner="w1")

    assert completed is not None
    assert mgr.get_tool(prepared.tool_call_id).status == ToolExecutionStatus.UNKNOWN.value
    assert mgr.get_tool(executing.tool_call_id).status == ToolExecutionStatus.UNKNOWN.value


def test_interrupted_run_cancels_unfinished_tool_rows(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_cancelled",
        run_id=run.run_id,
        idempotency_key="idem_cancelled",
    )
    mgr.mark_tool_executing(tool.tool_call_id)

    mgr.mark_interrupted(run.run_id, reason="client_disconnect")

    assert mgr.get_tool(tool.tool_call_id).status == ToolExecutionStatus.CANCELLED.value


def test_terminal_snapshot_repairs_missed_tool_terminal_write(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_repair",
        run_id=run.run_id,
        idempotency_key="idem_repair",
    )

    original_mark_terminal = mgr.tools.mark_terminal
    attempts = 0

    def fail_once(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("temporary database error")
        return original_mark_terminal(*args, **kwargs)

    mgr.tools.mark_terminal = fail_once
    mgr.complete_run(run.run_id, lease_owner="w1")
    assert mgr.tools.get(tool.tool_call_id).status == ToolExecutionStatus.PREPARED.value

    repaired = mgr.reconcile_terminal_run(run.run_id)

    assert repaired is not None
    assert mgr.tools.get(tool.tool_call_id).status == ToolExecutionStatus.UNKNOWN.value
    assert attempts == 2


def test_expired_run_lease_reaper_terminalizes_tools(mgr, conversation, db):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_expired",
        run_id=run.run_id,
        idempotency_key="idem_expired",
    )
    mgr.mark_tool_executing(tool.tool_call_id)
    expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    with db.connect() as conn:
        conn.execute(
            "UPDATE agent_runs SET lease_until = ? WHERE run_id = ?",
            (expired, run.run_id),
        )
        conn.commit()

    recovered = mgr.get_run(run.run_id)

    assert recovered is not None
    assert recovered.status == AgentRunStatus.INTERRUPTED.value
    assert mgr.get_tool(tool.tool_call_id).status == ToolExecutionStatus.CANCELLED.value


def test_expired_run_rejects_late_renew_and_complete(mgr, conversation, db):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_late_owner",
        run_id=run.run_id,
        idempotency_key="idem_late_owner",
    )
    mgr.mark_tool_executing(tool.tool_call_id)
    expired = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    with db.connect() as conn:
        conn.execute(
            "UPDATE agent_runs SET lease_until = ? WHERE run_id = ?",
            (expired, run.run_id),
        )
        conn.commit()

    reaped = mgr.get_run(run.run_id)
    assert reaped is not None
    assert reaped.status == AgentRunStatus.INTERRUPTED.value
    assert mgr.renew_lease(run.run_id, lease_owner="w1", lease_seconds=120) is None

    late_completion = mgr.complete_run(run.run_id, lease_owner="w1")
    assert late_completion is not None
    assert late_completion.status == AgentRunStatus.INTERRUPTED.value
    late_release = mgr.release_lease(run.run_id, lease_owner="w1")
    assert late_release is not None
    assert late_release.status == AgentRunStatus.INTERRUPTED.value
    assert mgr.get_tool(tool.tool_call_id).status == ToolExecutionStatus.CANCELLED.value


def test_stale_owner_cannot_terminalize_or_park_active_run(mgr, conversation):
    operations = (
        "complete",
        "fail",
        "budget",
        "waiting_approval",
        "waiting_input",
        "interrupt",
    )
    for operation in operations:
        run = mgr.start_run(conversation_id=conversation.id, lease_owner="owner_a")
        tool = mgr.prepare_tool(
            tool_call_id=f"tc_stale_{operation}",
            run_id=run.run_id,
            idempotency_key=f"idem_stale_{operation}",
        )
        mgr.mark_tool_executing(tool.tool_call_id)

        if operation == "complete":
            result = mgr.complete_run(run.run_id, lease_owner="owner_b")
        elif operation == "fail":
            result = mgr.fail_run(run.run_id, error="stale", lease_owner="owner_b")
        elif operation == "budget":
            result = mgr.mark_budget_exceeded(run.run_id, lease_owner="owner_b")
        elif operation == "waiting_approval":
            result = mgr.mark_waiting_approval(
                run.run_id,
                approval_id="approval_stale",
                lease_owner="owner_b",
            )
        else:
            if operation == "waiting_input":
                result = mgr.mark_waiting_input(
                    run.run_id,
                    pending_input={"question": "stale"},
                    lease_owner="owner_b",
                )
            else:
                result = mgr.mark_interrupted(
                    run.run_id,
                    reason="stale",
                    lease_owner="owner_b",
                )

        assert result is None
        assert mgr.runs.get(run.run_id).status == AgentRunStatus.RUNNING.value
        assert mgr.get_tool(tool.tool_call_id).status == ToolExecutionStatus.EXECUTING.value
        assert [event.type for event in mgr.list_events(run.run_id)] == ["run_started"]


def test_cleanup_loop_wires_server_owned_lease_reaper():
    main_source = (
        __import__("pathlib").Path(__file__).parents[1] / "sandbox" / "main.py"
    ).read_text(encoding="utf-8")
    assert "agent_run_manager.reap_expired_runs()" in main_source


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


def test_concurrent_appends_same_run_no_gaps_or_duplicates(mgr, conversation):
    """Many threads append to one run: monotonic sequences, no 500s/errors."""
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    n = 40
    results: list = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        try:
            evt = mgr.append_event(
                run.run_id,
                event_type="token_batch",
                payload={"i": i},
            )
            with lock:
                results.append(evt)
        except BaseException as exc:  # noqa: BLE001 — collect any failure
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert errors == [], f"concurrent append errors: {errors!r}"
    assert len(results) == n

    events = mgr.list_events(run.run_id)
    # start_run emits run_started (seq 1) + n concurrent appends
    sequences = [e.sequence for e in events]
    assert sequences == list(range(1, n + 2))
    assert len(set(sequences)) == len(sequences)
    assert len({e.event_id for e in events}) == len(events)


def test_duplicate_event_id_idempotent(mgr, conversation):
    """Same event_id returns the stable existing row; no second row."""
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    first = mgr.append_event(
        run.run_id,
        event_type="token_batch",
        payload={"text": "first"},
        event_id="evt_idem_1",
    )
    second = mgr.append_event(
        run.run_id,
        event_type="token_batch",
        payload={"text": "second-should-not-overwrite"},
        event_id="evt_idem_1",
    )
    assert first.event_id == second.event_id == "evt_idem_1"
    assert first.sequence == second.sequence
    assert first.payload == {"text": "first"}
    assert second.payload == {"text": "first"}

    matching = [e for e in mgr.list_events(run.run_id) if e.event_id == "evt_idem_1"]
    assert len(matching) == 1


def test_event_id_cannot_cross_link_another_run(mgr, conversation):
    """A global event_id collision never returns the other run's event."""
    first_run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    second_run = mgr.start_run(conversation_id=conversation.id, lease_owner="w2")
    first = mgr.append_event(
        first_run.run_id,
        event_type="token_batch",
        payload={"text": "first"},
        event_id="evt_cross_run",
    )

    with pytest.raises(AgentEventIdConflictError):
        mgr.append_event(
            second_run.run_id,
            event_type="token_batch",
            payload={"text": "must not link"},
            event_id="evt_cross_run",
        )

    assert [e.event_id for e in mgr.list_events(first_run.run_id)].count("evt_cross_run") == 1
    assert [e.event_id for e in mgr.list_events(second_run.run_id)].count("evt_cross_run") == 0
    assert mgr.events.get_by_event_id(first.event_id).run_id == first_run.run_id
    assert mgr.runs.get(second_run.run_id).status == AgentRunStatus.RUNNING.value


def test_concurrent_duplicate_event_id_single_row(mgr, conversation):
    """Concurrent retries with the same event_id yield one row."""
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    results: list = []
    errors: list[BaseException] = []
    lock = threading.Lock()
    event_id = "evt_concurrent_idem"

    def worker() -> None:
        try:
            evt = mgr.append_event(
                run.run_id,
                event_type="tool_start",
                payload={"name": "bash"},
                event_id=event_id,
            )
            with lock:
                results.append(evt)
        except BaseException as exc:  # noqa: BLE001
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=60)

    assert errors == [], f"idempotent concurrent errors: {errors!r}"
    assert len(results) == 16
    assert {e.sequence for e in results} == {results[0].sequence}
    assert {e.event_id for e in results} == {event_id}
    matching = [e for e in mgr.list_events(run.run_id) if e.event_id == event_id]
    assert len(matching) == 1


def test_sequence_conflict_retry_bounded(db, conversation):
    """Sequence unique conflicts retry at most MAX_APPEND_SEQUENCE_RETRIES times."""
    runs = AgentRunRepository(db)
    events = AgentEventRepository(db)
    run = runs.create(
        {
            "run_id": "run_retry_bound",
            "conversation_id": conversation.id,
            "status": "running",
            "version": 0,
        }
    )

    calls = {"n": 0}

    def always_sequence_conflict(*args, **kwargs):
        calls["n"] += 1
        raise sqlite3.IntegrityError(
            "UNIQUE constraint failed: agent_events.run_id, agent_events.sequence"
        )

    with patch.object(events, "_append_once", side_effect=always_sequence_conflict):
        with pytest.raises(RuntimeError, match="sequence retries"):
            events.append(
                run_id=run.run_id,
                event_type="token_batch",
                payload={"x": 1},
            )

    assert calls["n"] == MAX_APPEND_SEQUENCE_RETRIES
    assert MAX_APPEND_SEQUENCE_RETRIES == 8


def test_append_hard_failure_marks_run_failed(mgr, conversation):
    """Exhausted append retries make the run observably failed (not only a warning)."""
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")

    def boom(**kwargs):
        raise RuntimeError(
            f"agent event append failed after {MAX_APPEND_SEQUENCE_RETRIES} "
            f"sequence retries for run_id={run.run_id!r}"
        )

    with patch.object(mgr.events, "append", side_effect=boom):
        with pytest.raises(RuntimeError, match="sequence retries"):
            mgr.append_event(
                run.run_id,
                event_type="token_batch",
                payload={"text": "x"},
            )

    updated = mgr.get_run(run.run_id)
    assert updated is not None
    assert updated.status == AgentRunStatus.FAILED.value


def _postgres_url() -> str | None:
    import os

    for key in ("TEST_POSTGRES_URL", "SANDBOX_TEST_DATABASE_URL"):
        value = os.environ.get(key, "").strip()
        if value.startswith("postgresql://") or value.startswith("postgres://"):
            return value
    return None


@pytest.mark.skipif(_postgres_url() is None, reason="PostgreSQL test URL not set")
def test_postgres_100_concurrent_appends_same_run_no_gaps():
    """PostgreSQL: 100 concurrent appends to one run — no gaps, dups, or errors."""
    url = _postgres_url()
    assert url is not None
    db = Database(url)
    db.initialize()
    conv_repo = ConversationRepository(db)
    conv = conv_repo.upsert(
        {
            "id": "conv_pg_concurrent",
            "title": "PG concurrent",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )
    mgr = AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=conv_repo,
    )
    run = mgr.start_run(conversation_id=conv.id, lease_owner="w1")
    n = 100
    results: list = []
    errors: list[BaseException] = []
    lock = threading.Lock()

    def worker(i: int) -> None:
        try:
            evt = mgr.append_event(
                run.run_id,
                event_type="token_batch",
                payload={"i": i},
            )
            with lock:
                results.append(evt)
        except BaseException as exc:  # noqa: BLE001
            with lock:
                errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=120)

    assert errors == [], f"PostgreSQL concurrent append errors: {errors!r}"
    assert len(results) == n
    events = mgr.list_events(run.run_id)
    sequences = [e.sequence for e in events]
    # run_started + 100 appends
    assert sequences == list(range(1, n + 2))
    assert len(set(sequences)) == len(sequences)
    assert len({e.event_id for e in events}) == len(events)
