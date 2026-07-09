"""Policy elevation + approval check API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.main import app
from sandbox.models import ToolCallCheck
from sandbox.services.policy_checker import policy_checker


client = TestClient(app)


def test_bash_pip_install_requires_approval_decision():
    d = policy_checker.check(ToolCallCheck(
        session_id="s1",
        tool_name="bash",
        command="pip install requests",
    ))
    assert d.allowed is False
    assert d.risk_level.value == "high"


def test_bash_echo_auto_allowed():
    d = policy_checker.check(ToolCallCheck(
        session_id="s1",
        tool_name="bash",
        command="echo hello",
    ))
    assert d.allowed is True


def test_approval_check_creates_pending_for_high_risk():
    s = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = s["session_id"]
    r = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "bash", "command": "curl https://example.com"},
    )
    assert r.status_code in (200, 202)
    body = r.json()
    assert body["status"] == "pending_approval"
    assert body.get("approval_id")

    g = client.get(f"/approvals/{body['approval_id']}")
    assert g.status_code == 200
    assert g.json()["status"] == "pending_approval"

    d = client.post(
        "/approve",
        json={"approval_id": body["approval_id"], "decision": "approve"},
    )
    assert d.status_code == 200
    assert d.json()["status"] == "approved"
