"""Trace ID propagation and owner/org authorization tests."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from sandbox.auth import create_token
from sandbox.config import settings
from sandbox.main import app
from sandbox.security.ownership import BOOTSTRAP_ORG_ID
from tests.conftest import session_create_payload

client = TestClient(app)


def test_trace_id_header_is_echoed_and_attached_to_execution_and_audit():
    trace_id = "trace_test_001"
    session = client.post("/sessions", json=session_create_payload("trace-test")).json()
    sid = session["session_id"]

    resp = client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "echo traced"},
        headers={"X-Trace-Id": trace_id},
    )

    assert resp.status_code == 201
    assert resp.headers["X-Trace-Id"] == trace_id
    execution = resp.json()
    assert execution["trace_id"] == trace_id

    traces = client.get(f"/traces/{trace_id}").json()
    assert traces["trace_id"] == trace_id
    assert any(e["execution_id"] == execution["execution_id"] for e in traces["executions"])
    assert any(a["event_type"] == "execution" for a in traces["audit_logs"])


def test_trace_id_is_generated_when_missing():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.headers.get("X-Trace-Id")


def _register(username: str, password: str = "secret123") -> dict:
    r = client.post(
        "/auth/register",
        json={"username": username, "password": password},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _seed_owned_session(*, user_id: str, organization_id: str, caller_id: str = "trace-seed"):
    """Service-layer seed: formal AgentSession binding with ownership metadata.

    HTTP POST /sessions is fail-closed under auth_enabled (no JWT forge path).
    """
    from sandbox.services.session_manager import session_manager
    from sandbox.services.workspace_manager import workspace_manager
    from tests.conftest import formal_id

    agent = formal_id("AGT")
    wsp = formal_id("WSP")
    session = session_manager.create(
        agent_session_id=agent,
        workspace_id=wsp,
        user_id=user_id,
        caller_id=caller_id,
        metadata={"organization_id": organization_id},
    )
    workspace_manager.init_workspace(wsp)
    return session


def test_trace_cross_user_returns_404(monkeypatch):
    """Owner can read their trace; another user gets 404 (no existence leak)."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(f"trace_a_{uuid.uuid4().hex[:8]}")
    b = _register(f"trace_b_{uuid.uuid4().hex[:8]}")
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    trace_id = f"trace_own_{uuid.uuid4().hex[:8]}"
    seeded = _seed_owned_session(
        user_id=a["user"]["id"],
        organization_id=a["user"]["organization_id"],
        caller_id="trace-auth",
    )
    sid = seeded.session_id
    assert seeded.user_id == a["user"]["id"]

    resp = client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "echo owned"},
        headers={**headers_a, "X-Trace-Id": trace_id},
    )
    assert resp.status_code == 201, resp.text

    ok = client.get(f"/traces/{trace_id}", headers=headers_a)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["trace_id"] == trace_id
    assert body["executions"]

    denied = client.get(f"/traces/{trace_id}", headers=headers_b)
    assert denied.status_code == 404, denied.text


def test_trace_cross_org_returns_404(monkeypatch):
    """Users in different orgs cannot see each other's traces (404)."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(f"trace_org_a_{uuid.uuid4().hex[:8]}")
    headers_a = {"Authorization": f"Bearer {a['token']}"}

    other_org = "org_other_trace"
    tok_other = create_token(
        f"user_other_{uuid.uuid4().hex[:6]}",
        "other",
        role="user",
        organization_id=other_org,
        ttl_seconds=600,
    )
    headers_other = {"Authorization": f"Bearer {tok_other}"}

    trace_id = f"trace_org_{uuid.uuid4().hex[:8]}"
    seeded = _seed_owned_session(
        user_id=a["user"]["id"],
        organization_id=a["user"]["organization_id"],
        caller_id="trace-org",
    )
    sid = seeded.session_id
    client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "echo org"},
        headers={**headers_a, "X-Trace-Id": trace_id},
    )

    assert client.get(f"/traces/{trace_id}", headers=headers_a).status_code == 200
    assert client.get(f"/traces/{trace_id}", headers=headers_other).status_code == 404


def test_trace_admin_same_org_only(monkeypatch):
    """Admin in same org can read; admin in other org gets 404."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    owner = _register(f"trace_adm_owner_{uuid.uuid4().hex[:8]}")
    headers_owner = {"Authorization": f"Bearer {owner['token']}"}

    admin_same = create_token(
        f"admin_same_{uuid.uuid4().hex[:6]}",
        "admin_same",
        role="admin",
        organization_id=BOOTSTRAP_ORG_ID,
        ttl_seconds=600,
    )
    admin_other = create_token(
        f"admin_other_{uuid.uuid4().hex[:6]}",
        "admin_other",
        role="admin",
        organization_id="org_elsewhere",
        ttl_seconds=600,
    )

    trace_id = f"trace_adm_{uuid.uuid4().hex[:8]}"
    seeded = _seed_owned_session(
        user_id=owner["user"]["id"],
        organization_id=owner["user"]["organization_id"],
        caller_id="trace-admin",
    )
    sid = seeded.session_id
    client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "echo admin"},
        headers={**headers_owner, "X-Trace-Id": trace_id},
    )

    same = client.get(
        f"/traces/{trace_id}",
        headers={"Authorization": f"Bearer {admin_same}"},
    )
    assert same.status_code == 200, same.text
    assert same.json()["executions"]

    other = client.get(
        f"/traces/{trace_id}",
        headers={"Authorization": f"Bearer {admin_other}"},
    )
    assert other.status_code == 404


def test_trace_unknown_returns_404_when_auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    user = _register(f"trace_miss_{uuid.uuid4().hex[:8]}")
    resp = client.get(
        "/traces/trace_does_not_exist_xyz",
        headers={"Authorization": f"Bearer {user['token']}"},
    )
    assert resp.status_code == 404
