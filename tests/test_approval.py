"""Approval workflow tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.database import Database
from sandbox.main import app
from sandbox.models import RiskLevel
from sandbox.services.approval_manager import ApprovalManager

client = TestClient(app)


def test_high_risk_tool_returns_pending_approval_and_can_be_rejected():
    session = client.post("/sessions", json={"caller_id": "approval-test"}).json()
    sid = session["session_id"]

    resp = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "raw_bash", "command": "rm -rf /tmp/example"},
    )

    assert resp.status_code == 202
    pending = resp.json()
    assert pending["status"] == "pending_approval"
    assert pending["approval_id"].startswith("approval_")

    rejected = client.post(
        "/approve",
        json={"approval_id": pending["approval_id"], "decision": "reject"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"


def test_medium_risk_tool_is_auto_allowed_by_approval_check():
    session = client.post("/sessions", json={"caller_id": "approval-test"}).json()
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
