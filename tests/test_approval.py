"""Approval workflow tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.main import app

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
