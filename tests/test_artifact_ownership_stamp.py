"""Severe: formal artifact stamps from session/actor only — never client body."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.database import database
from sandbox.main import app
from sandbox.routers.artifacts import _ownership_fields
from tests.conftest import formal_id, session_create_payload

client = TestClient(app)


def _unique(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _register(username: str, password: str = "secret123") -> dict:
    r = client.post(
        "/auth/register",
        json={"username": username, "password": password},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _stamp_session(
    session_id: str,
    *,
    user_id: str,
    organization_id: str,
    conversation_id: str | None = None,
    agent_session_id: str | None = None,
    run_id: str | None = None,
) -> None:
    with database.connect() as conn:
        row = conn.execute(
            "SELECT metadata, agent_session_id FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        assert row is not None
        meta = json.loads(row["metadata"] or "{}")
        if not isinstance(meta, dict):
            meta = {}
        meta["organization_id"] = organization_id
        meta["org_id"] = organization_id
        meta["user_id"] = user_id
        if conversation_id:
            meta["conversation_id"] = conversation_id
        if run_id:
            meta["run_id"] = run_id
            meta["last_run_id"] = run_id
        if agent_session_id:
            meta["agent_session_id"] = agent_session_id
            conn.execute(
                "UPDATE sessions SET user_id = ?, metadata = ?, agent_session_id = ? "
                "WHERE session_id = ?",
                (user_id, json.dumps(meta), agent_session_id, session_id),
            )
        else:
            conn.execute(
                "UPDATE sessions SET user_id = ?, metadata = ? WHERE session_id = ?",
                (user_id, json.dumps(meta), session_id),
            )
        conn.commit()
    from sandbox.services.session_manager import session_manager

    session_manager._sessions.pop(session_id, None)  # noqa: SLF001


def test_ownership_fields_session_only_exact_org_user_conv_run():
    """Client body/header never supply org/user/agent/conversation/run."""
    session = SimpleNamespace(
        user_id="user_session",
        agent_session_id="agent_session_real",
        metadata={
            "organization_id": "org_session",
            "conversation_id": "conv_session",
            "run_id": "run_session",
            "last_run_id": "run_session",
        },
        workspace_id="ws1",
    )
    body = SimpleNamespace(
        org_id="org_spoof",
        user_id="user_spoof",
        conversation_id="conv_spoof",
        agent_session_id="agent_spoof",
        run_id="run_spoof",
    )
    req = SimpleNamespace(
        headers={
            "X-Org-Id": "org_header_spoof",
            "X-User-Id": "user_header_spoof",
            "X-Conversation-Id": "conv_header_spoof",
            "X-Run-Id": "run_header_spoof",
        }
    )
    own = _ownership_fields(session, req, body)
    assert own["org_id"] == "org_session"
    assert own["user_id"] == "user_session"
    assert own["agent_session_id"] == "agent_session_real"
    assert own["conversation_id"] == "conv_session"
    assert own["run_id"] == "run_session"


def test_ownership_fields_ignore_client_when_session_unbound():
    """Unbound session does not fall back to client conversation/run spoof."""
    session = SimpleNamespace(
        user_id="user_session",
        agent_session_id="agent_only",
        metadata={"organization_id": "org_session"},
        workspace_id="ws1",
    )
    body = SimpleNamespace(
        org_id="o",
        user_id="u",
        conversation_id="client_conv",
        agent_session_id="client_agent",
        run_id="client_run",
    )
    req = SimpleNamespace(headers={})
    own = _ownership_fields(session, req, body)
    assert own["org_id"] == "org_session"
    assert own["user_id"] == "user_session"
    assert own["agent_session_id"] == "agent_only"
    assert own["conversation_id"] is None
    assert own["run_id"] is None


def test_artifact_submit_http_uses_session_owner_not_body(monkeypatch):
    """HTTP submit with spoofed body must stamp session owner when returned."""
    monkeypatch.setattr(settings, "auth_enabled", False)

    agent_id = formal_id("AGT")
    conv_id = formal_id("CNV")
    run_id = formal_id("RUN")
    sess = client.post(
        "/sessions",
        json=session_create_payload("art-spoof", agent_session_id=agent_id),
    ).json()
    sid = sess["session_id"]
    a = _register(_unique("alice_art"))
    alice_id = a["user"]["id"]
    alice_org = a["user"]["organization_id"]
    _stamp_session(
        sid,
        user_id=alice_id,
        organization_id=alice_org,
        conversation_id=conv_id,
        agent_session_id=agent_id,
        run_id=run_id,
    )

    wr = client.post(
        f"/sessions/{sid}/files/write",
        json={"path": "out.txt", "content": "hello-artifact"},
    )
    assert wr.status_code in (200, 201), wr.text

    victim_org = "01VICTIMORG0000000000000"
    victim_user = "01VICTIMUSER00000000000"
    body = {
        "path": "out.txt",
        "name": "out.txt",
        "org_id": victim_org,
        "user_id": victim_user,
        "agent_session_id": "01VICTIMAGENT0000000000",
        "conversation_id": "01VICTIMCONV00000000000",
        "run_id": "01VICTIMRUN000000000000",
    }
    monkeypatch.setattr(settings, "auth_enabled", True)
    headers = {"Authorization": f"Bearer {a['token']}"}
    _stamp_session(
        sid,
        user_id=alice_id,
        organization_id=alice_org,
        conversation_id=conv_id,
        agent_session_id=agent_id,
        run_id=run_id,
    )

    resp = client.post(
        f"/sessions/{sid}/artifacts/submit",
        json=body,
        headers=headers,
    )
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    # Exact trusted stamps when formal/live response carries identity fields.
    if data.get("org_id") is not None:
        assert data["org_id"] == alice_org
    if data.get("user_id") is not None:
        assert data["user_id"] == alice_id
    if data.get("agent_session_id") is not None:
        assert data["agent_session_id"] == agent_id
    if data.get("conversation_id") is not None:
        assert data["conversation_id"] == conv_id
    if data.get("run_id") is not None:
        assert data["run_id"] == run_id
    assert data.get("org_id") != victim_org
    assert data.get("user_id") != victim_user
