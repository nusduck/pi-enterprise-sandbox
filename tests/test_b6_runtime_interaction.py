"""B6 — Runtime Interaction: waiting_approval, budget_exceeded, restart recovery."""

from __future__ import annotations

import pytest

from sandbox.database import Database
from sandbox.models import AgentRunStatus
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    ConversationRepository,
    ToolExecutionRepository,
)
from sandbox.services.agent_run_manager import AgentRunManager
from sandbox.services.approval_manager import ApprovalManager
from sandbox.models import RiskLevel


@pytest.fixture
def db(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'b6.db'}")
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
            "id": "conv_b6",
            "title": "B6",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )


def test_schema_has_b6_columns(db, tmp_path):
    import sqlite3

    with sqlite3.connect(tmp_path / "b6.db") as conn:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(agent_runs)").fetchall()
        }
    assert "budget_json" in cols
    assert "pending_approval_json" in cols


def test_mark_waiting_approval_releases_lease_and_stores_pending(mgr, conversation):
    run = mgr.start_run(
        conversation_id=conversation.id,
        lease_owner="worker_1",
        budget={"max_steps": 10, "max_tool_calls": 20},
    )
    assert run.lease_owner == "worker_1"
    assert run.budget_json is not None
    assert run.budget_json.get("max_steps") == 10

    pending = {
        "approval_id": "approval_b6_1",
        "tool_name": "bash",
        "params": {"command": "curl evil"},
        "tool_call_id": "tc_1",
    }
    parked = mgr.mark_waiting_approval(
        run.run_id,
        approval_id="approval_b6_1",
        pending_approval=pending,
        lease_owner="worker_1",
    )
    assert parked is not None
    assert parked.status == AgentRunStatus.WAITING_APPROVAL.value
    assert parked.lease_owner is None  # resources released
    assert parked.pending_approval_json["approval_id"] == "approval_b6_1"

    events = mgr.list_events(run.run_id)
    types = [e.type for e in events]
    assert "waiting_approval" in types


def test_budget_exceeded_terminal(mgr, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w2")
    done = mgr.mark_budget_exceeded(
        run.run_id,
        reason="tool_calls exceeded limit 5",
        usage={"tool_calls": 6},
        lease_owner="w2",
    )
    assert done is not None
    assert done.status == AgentRunStatus.BUDGET_EXCEEDED.value
    assert done.lease_owner is None
    events = mgr.list_events(run.run_id)
    assert any(e.type == "budget_exceeded" for e in events)


def test_list_waiting_approval_survives_manager_restart(db, conversation):
    """Agent restart: new manager instance still sees waiting_approval runs."""
    first = AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )
    run = first.start_run(conversation_id=conversation.id, lease_owner="w3")
    first.mark_waiting_approval(
        run.run_id,
        approval_id="approval_restart",
        pending_approval={"approval_id": "approval_restart", "tool_name": "write"},
        lease_owner="w3",
    )

    second = AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )
    waiting = second.list_waiting_approval()
    assert len(waiting) >= 1
    found = next(r for r in waiting if r.run_id == run.run_id)
    assert found.status == AgentRunStatus.WAITING_APPROVAL.value
    assert found.pending_approval_json["approval_id"] == "approval_restart"


def test_approval_decide_persists_independent_of_agent_process(db):
    """Approval decision is durable even if agent is down (restart wait)."""
    mgr = ApprovalManager(database=db)
    created = mgr.create(
        session_id="sandbox_1",
        tool_name="bash",
        risk_level=RiskLevel.HIGH,
        reason="needs review",
        payload={"run_id": "run_x", "command": "echo"},
    )
    # Simulate agent crash — new manager
    restored = ApprovalManager(database=db)
    pending = restored.get(created["approval_id"])
    assert pending["status"] == "pending_approval"
    decided = restored.decide(created["approval_id"], "approve")
    assert decided["status"] == "approved"

    # Third restart still sees approved
    again = ApprovalManager(database=db)
    assert again.get(created["approval_id"])["status"] == "approved"


def test_api_waiting_approval_and_budget_endpoints(db, conversation, monkeypatch):
    from fastapi.testclient import TestClient
    from sandbox.main import app
    from sandbox import database as dbmod
    from sandbox.services import agent_run_manager as arm_mod
    from sandbox.services import approval_manager as appr_mod

    # Point global managers at temp DB
    monkeypatch.setattr(dbmod, "database", db)
    arm_mod.agent_run_manager = AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )
    appr_mod.approval_manager = ApprovalManager(database=db)

    client = TestClient(app)
    created = client.post(
        "/agent-runs",
        json={
            "conversation_id": conversation.id,
            "lease_owner": "api_worker",
            "budget": {"max_steps": 3},
        },
    )
    assert created.status_code == 201
    run_id = created.json()["run_id"]

    parked = client.post(
        f"/agent-runs/{run_id}/waiting-approval",
        json={
            "approval_id": "approval_api",
            "pending_approval": {"approval_id": "approval_api", "tool_name": "bash"},
            "lease_owner": "api_worker",
        },
    )
    assert parked.status_code == 200
    assert parked.json()["status"] == "waiting_approval"
    assert parked.json()["lease_owner"] is None

    listed = client.get("/agent-runs", params={"status": "waiting_approval"})
    assert listed.status_code == 200
    assert any(r["run_id"] == run_id for r in listed.json())

    # Separate run for budget
    r2 = client.post(
        "/agent-runs",
        json={"conversation_id": conversation.id, "lease_owner": "bw"},
    ).json()
    be = client.post(
        f"/agent-runs/{r2['run_id']}/budget-exceeded",
        json={"reason": "max_steps", "lease_owner": "bw"},
    )
    assert be.status_code == 200
    assert be.json()["status"] == "budget_exceeded"
