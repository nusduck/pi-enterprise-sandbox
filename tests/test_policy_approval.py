"""Policy elevation + approval check API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.main import app
from sandbox.models import ToolCallCheck
from sandbox.services.policy_checker import POLICY_VERSION, policy_checker


client = TestClient(app)


def test_bash_pip_install_requires_approval_decision():
    d = policy_checker.check(ToolCallCheck(
        session_id="s1",
        tool_name="bash",
        command="pip install requests",
    ))
    # Strict elevates package installs; balanced intentionally allows them
    # (still subject to network_mode / isolation at execution time).
    if settings.policy_profile == "balanced":
        assert d.allowed is True
        assert d.decision == "allow"
    else:
        assert d.allowed is False
        assert d.decision == "approval_required"
        assert d.risk_level.value == "high"


def test_which_curl_does_not_require_approval():
    d = policy_checker.check(ToolCallCheck(
        session_id="s1",
        tool_name="bash",
        command="which curl wget node python3",
    ))
    assert d.allowed is True
    assert d.decision == "allow"


def test_bash_echo_auto_allowed():
    d = policy_checker.check(ToolCallCheck(
        session_id="s1",
        tool_name="bash",
        command="echo hello",
    ))
    assert d.allowed is True
    assert d.decision == "allow"


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
    assert body.get("policy_version") == POLICY_VERSION
    assert body.get("decision") == "approval_required"

    g = client.get(f"/approvals/{body['approval_id']}")
    assert g.status_code == 200
    assert g.json()["status"] == "pending_approval"

    d = client.post(
        "/approve",
        json={"approval_id": body["approval_id"], "decision": "approve"},
    )
    assert d.status_code == 200
    assert d.json()["status"] == "approved"


def test_hard_deny_rejected_not_pending():
    """Blocked commands must never enter the approval queue."""
    s = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = s["session_id"]
    r = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "bash", "command": "sudo rm -rf /"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "rejected"
    assert body.get("decision") == "hard_deny"
    assert body.get("policy_version") == POLICY_VERSION
    assert body.get("approval_id") is None


def test_hard_deny_blocks_command_execution_even_with_session():
    """Sandbox re-enforces hard_deny on /executions/command (bypass Agent)."""
    s = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = s["session_id"]
    r = client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "sudo ls"},
    )
    assert r.status_code == 403
    assert "blocked" in r.json()["detail"].lower() or "sudo" in r.json()["detail"].lower()


def test_approval_deny_mode_rejects_risk_but_not_hard_deny(monkeypatch):
    """APPROVAL_MODE=deny rejects approval-required work without broadening access."""
    monkeypatch.setattr(settings, "approval_mode", "deny")
    s = client.post("/sessions", json={"caller_id": "test"}).json()
    sid = s["session_id"]

    risk = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "bash", "command": "pip install requests"},
    )
    assert risk.status_code == 200
    body = risk.json()
    assert body["status"] == "rejected"
    assert body.get("approval_bypassed") is False
    assert body.get("decision") == "approval_required"

    hard = client.post(
        f"/sessions/{sid}/executions/approval-check",
        json={"tool_name": "bash", "command": "sudo id"},
    )
    assert hard.status_code == 200
    hbody = hard.json()
    assert hbody["status"] == "rejected"
    assert hbody.get("decision") == "hard_deny"
    assert hbody.get("approval_bypassed") is False

    # Direct execution path still hard-denies
    exec_r = client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "sudo id"},
    )
    assert exec_r.status_code == 403


def test_approval_check_reuses_same_key_after_decision_and_is_session_scoped():
    s1 = client.post("/sessions", json={"caller_id": "test"}).json()
    s2 = client.post("/sessions", json={"caller_id": "test"}).json()
    key = "api-approval-key"
    body = {"tool_name": "raw_bash", "command": "curl https://example.com", "idempotency_key": key}

    first = client.post(f"/sessions/{s1['session_id']}/executions/approval-check", json=body)
    retry = client.post(f"/sessions/{s1['session_id']}/executions/approval-check", json=body)
    other_session = client.post(f"/sessions/{s2['session_id']}/executions/approval-check", json=body)
    assert first.status_code == 202
    assert retry.status_code == 202
    assert retry.json()["approval_id"] == first.json()["approval_id"]
    assert other_session.json()["approval_id"] != first.json()["approval_id"]

    approved = client.post(
        "/approve",
        json={"approval_id": first.json()["approval_id"], "decision": "approve"},
    )
    assert approved.status_code == 200
    resumed = client.post(f"/sessions/{s1['session_id']}/executions/approval-check", json=body)
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "approved"
    assert resumed.json()["approval_id"] == first.json()["approval_id"]

    rejected_key = "api-rejected-key"
    rejected_request = {**body, "idempotency_key": rejected_key}
    rejected_pending = client.post(
        f"/sessions/{s1['session_id']}/executions/approval-check", json=rejected_request
    ).json()
    client.post(
        "/approve",
        json={"approval_id": rejected_pending["approval_id"], "decision": "reject"},
    )
    rejected_retry = client.post(
        f"/sessions/{s1['session_id']}/executions/approval-check", json=rejected_request
    )
    assert rejected_retry.status_code == 200
    assert rejected_retry.json()["status"] == "rejected"
    assert rejected_retry.json()["approval_id"] == rejected_pending["approval_id"]
