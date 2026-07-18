"""Approval workflow tests."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from sandbox.database import Database
from sandbox.main import app
from sandbox.models import RiskLevel
from sandbox.services.approval_manager import ApprovalManager
from tests.conftest import session_create_payload

client = TestClient(app)


def test_high_risk_tool_returns_pending_approval_and_can_be_rejected():
    session = client.post("/sessions", json=session_create_payload("approval-test")).json()
    sid = session["session_id"]

    # Use approval_required (not hard_deny): raw_bash is high-risk; avoid
    # blocked prefixes like "rm -rf /" which are never approval-eligible.
    resp = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "raw_bash", "command": "echo high-risk-tool"},
    )

    assert resp.status_code == 202
    pending = resp.json()
    assert pending["status"] == "pending_approval"
    assert pending["approval_id"].startswith("approval_")
    assert pending.get("decision") == "approval_required"

    rejected = client.post(
        "/approve",
        json={"approval_id": pending["approval_id"], "decision": "reject"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"


def test_medium_risk_tool_is_auto_allowed_by_approval_check():
    session = client.post("/sessions", json=session_create_payload("approval-test")).json()
    sid = session["session_id"]

    resp = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "bash", "command": "echo ok"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "approved"
    assert body["risk_level"] == "medium"


def test_approvals_persist_across_manager_instances(tmp_path):
    """create + decide + get after restart (new manager, same DB)."""
    db = Database(f"sqlite:///{tmp_path / 'approvals.db'}")
    db.initialize()

    first = ApprovalManager(database=db)
    created = first.create(
        session_id="sandbox_abc",
        tool_name="raw_bash",
        risk_level=RiskLevel.HIGH,
        reason="dangerous command",
        payload={"command": "rm -rf /"},
    )
    approval_id = created["approval_id"]
    decided = first.decide(approval_id, "approve")
    assert decided is not None
    assert decided["status"] == "approved"
    assert decided["decided_at"] is not None

    # Simulate process restart — fresh manager, empty cache, same DB
    second = ApprovalManager(database=db)
    restored = second.get(approval_id)
    assert restored is not None
    assert restored["approval_id"] == approval_id
    assert restored["session_id"] == "sandbox_abc"
    assert restored["tool_name"] == "raw_bash"
    assert restored["status"] == "approved"
    assert restored["payload"]["command"] == "rm -rf /"
    assert restored["decided_at"] is not None


def test_approval_create_and_get_pending_persists(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'approvals.db'}")
    db.initialize()

    first = ApprovalManager(database=db)
    created = first.create(
        session_id="sandbox_xyz",
        tool_name="raw_bash",
        risk_level=RiskLevel.HIGH,
        reason="needs review",
    )
    second = ApprovalManager(database=db)
    pending = second.get(created["approval_id"])
    assert pending is not None
    assert pending["status"] == "pending_approval"
    assert pending["risk_level"] == "high"


def test_same_session_idempotency_reuses_pending_and_terminal_decisions(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'approvals.db'}")
    db.initialize()
    manager = ApprovalManager(database=db)
    kwargs = dict(
        session_id="sandbox_idempotent",
        tool_name="raw_bash",
        risk_level=RiskLevel.HIGH,
        reason="dangerous command",
        payload={"command": "curl https://example.com"},
        idempotency_key="approval_attempt_1",
        operation_fingerprint="fingerprint_1",
    )

    pending = manager.create(**kwargs)
    retry = manager.create(**kwargs)
    assert retry["approval_id"] == pending["approval_id"]
    assert retry["status"] == "pending_approval"

    approved = manager.decide(pending["approval_id"], "approve")
    assert approved is not None
    resumed = manager.create(**kwargs)
    assert resumed["approval_id"] == pending["approval_id"]
    assert resumed["status"] == "approved"

    rejected_kwargs = {**kwargs, "idempotency_key": "approval_attempt_2"}
    rejected = manager.create(**rejected_kwargs)
    manager.decide(rejected["approval_id"], "reject")
    rejected_retry = manager.create(**rejected_kwargs)
    assert rejected_retry["approval_id"] == rejected["approval_id"]
    assert rejected_retry["status"] == "rejected"


def test_same_key_is_scoped_to_session_and_operation(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'approvals.db'}")
    db.initialize()
    manager = ApprovalManager(database=db)
    common = dict(
        tool_name="raw_bash",
        risk_level=RiskLevel.HIGH,
        reason="dangerous command",
        payload={"command": "curl https://example.com"},
        idempotency_key="same-client-key",
        operation_fingerprint="fingerprint_1",
    )

    first = manager.create(session_id="session_a", **common)
    second = manager.create(session_id="session_b", **common)
    assert second["approval_id"] != first["approval_id"]
    assert manager.repository is not None
    assert manager.repository.get_by_idempotency_key("session_a", "same-client-key")["approval_id"] == first["approval_id"]
    assert manager.repository.get_by_idempotency_key("session_b", "same-client-key")["approval_id"] == second["approval_id"]

    with pytest.raises(ValueError, match="different operation"):
        manager.create(
            session_id="session_a",
            **{**common, "operation_fingerprint": "fingerprint_2"},
        )


def test_concurrent_managers_with_separate_connections_create_one_approval(tmp_path):
    db_path = tmp_path / "approvals-concurrent.db"
    Database(f"sqlite:///{db_path}").initialize()

    def create_from_fresh_manager(_worker: int) -> str:
        worker_db = Database(f"sqlite:///{db_path}")
        manager = ApprovalManager(database=worker_db)
        entry = manager.create(
            session_id="session_concurrent",
            tool_name="raw_bash",
            risk_level=RiskLevel.HIGH,
            reason="concurrent request",
            payload={"command": "curl https://example.com"},
            idempotency_key="concurrent-key",
            operation_fingerprint="concurrent-fingerprint",
        )
        return entry["approval_id"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        approval_ids = list(pool.map(create_from_fresh_manager, range(8)))

    assert len(set(approval_ids)) == 1


def test_concurrent_terminal_decisions_are_first_writer_sticky(tmp_path):
    db_path = tmp_path / "approval-decision-race.db"
    database_url = f"sqlite:///{db_path}"
    initial_db = Database(database_url)
    initial_db.initialize()
    initial = ApprovalManager(database=initial_db)
    pending = initial.create(
        session_id="session_decision_race",
        tool_name="raw_bash",
        risk_level=RiskLevel.HIGH,
        reason="concurrent decision",
        payload={"command": "curl https://example.com"},
        idempotency_key="decision-race-key",
        operation_fingerprint="decision-race-fingerprint",
    )
    barrier = Barrier(2)

    def decide_from_fresh_manager(decision: str) -> str:
        manager = ApprovalManager(database=Database(database_url))
        barrier.wait()
        decided = manager.decide(pending["approval_id"], decision)
        assert decided is not None
        return decided["status"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(decide_from_fresh_manager, ["approve", "reject"]))

    assert len(set(statuses)) == 1
    winner = statuses[0]
    final = ApprovalManager(database=Database(database_url)).get(pending["approval_id"])
    assert final is not None
    assert final["status"] == winner

    opposite = "reject" if winner == "approved" else "approve"
    repeated = initial.decide(pending["approval_id"], opposite)
    assert repeated is not None
    assert repeated["status"] == winner
