"""Severe: cross-user approval decide/get must fail closed under auth."""

from __future__ import annotations

import json
import uuid

from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.database import database
from sandbox.main import app
from tests.conftest import session_create_payload

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


def _stamp_session_owner(session_id: str, *, user_id: str, organization_id: str) -> None:
    """Bind sandbox session ownership fields used by assert_session_owner."""
    with database.connect() as conn:
        row = conn.execute(
            "SELECT metadata FROM sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        assert row is not None, session_id
        meta = json.loads(row["metadata"] or "{}")
        if not isinstance(meta, dict):
            meta = {}
        meta["organization_id"] = organization_id
        conn.execute(
            "UPDATE sessions SET user_id = ?, metadata = ? WHERE session_id = ?",
            (user_id, json.dumps(meta), session_id),
        )
        conn.commit()
    # Repository-backed get() reloads from DB; clear any pure in-memory entry.
    from sandbox.services.session_manager import session_manager

    session_manager._sessions.pop(session_id, None)  # noqa: SLF001


def test_cross_user_cannot_decide_foreign_approval(monkeypatch):
    """User B cannot approve/reject User A's pending approval (IDOR)."""
    # Create session + approval while auth is off (offline formal binding create).
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")

    sa = client.post("/sessions", json=session_create_payload("appr-alice"))
    assert sa.status_code == 201, sa.text
    sid_a = sa.json()["session_id"]

    pending = client.post(
        f"/sessions/{sid_a}/executions/approval-check",
        json={"tool_name": "raw_bash", "command": "echo high-risk"},
    )
    assert pending.status_code == 202, pending.text
    approval_id = pending.json()["approval_id"]
    assert approval_id

    # Register two users, stamp session to Alice, enable auth.
    a = _register(_unique("alice_appr"))
    b = _register(_unique("bob_appr"))
    alice_id = a["user"]["id"]
    alice_org = a["user"]["organization_id"]
    _stamp_session_owner(sid_a, user_id=alice_id, organization_id=alice_org)

    monkeypatch.setattr(settings, "auth_enabled", True)
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    # Owner can get
    got = client.get(f"/approvals/{approval_id}", headers=headers_a)
    assert got.status_code == 200, got.text

    # Foreign user: get and decide must 404 (no existence leak)
    assert (
        client.get(f"/approvals/{approval_id}", headers=headers_b).status_code == 404
    )
    decide = client.post(
        "/approve",
        json={"approval_id": approval_id, "decision": "approve"},
        headers=headers_b,
    )
    assert decide.status_code == 404, decide.text

    # Owner can still decide
    ok = client.post(
        "/approve",
        json={"approval_id": approval_id, "decision": "reject"},
        headers=headers_a,
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "rejected"
