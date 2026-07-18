"""Ownership + multi-user isolation tests (SANDBOX_AUTH_ENABLED)."""

from __future__ import annotations

import uuid

from fastapi.testclient import TestClient

from sandbox.auth import create_token
from sandbox.config import settings
from sandbox.database import count_conversation_orphans, database
from sandbox.main import app
from sandbox.repositories import ConversationRepository, UserRepository
from sandbox.security.ownership import BOOTSTRAP_ORG_ID, BOOTSTRAP_USER_ID

client = TestClient(app)


def _unique(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _register(username: str, password: str = "secret123", **extra) -> dict:
    r = client.post(
        "/auth/register",
        json={"username": username, "password": password, **extra},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_token_includes_organization_id():
    tok = create_token("user_x", "x", role="user", organization_id="org_custom", ttl_seconds=60)
    from sandbox.auth import verify_token

    payload = verify_token(tok)
    assert payload is not None
    assert payload["organization_id"] == "org_custom"
    assert payload["role"] == "user"


def test_register_assigns_bootstrap_org():
    data = _register(_unique("owner_reg"))
    assert data["user"]["organization_id"] == BOOTSTRAP_ORG_ID
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {data['token']}"})
    assert me.status_code == 200
    assert me.json()["organization_id"] == BOOTSTRAP_ORG_ID


def test_cross_user_conversation_404(monkeypatch):
    """User A cannot read/update/delete user B's conversation (404, no leak)."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(_unique("alice_own"))
    b = _register(_unique("bob_own"))
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    created = client.post(
        "/conversations",
        json={"title": "Alice private"},
        headers=headers_a,
    )
    assert created.status_code == 201, created.text
    conv = created.json()
    assert conv["owner_user_id"] == a["user"]["id"]
    assert conv["organization_id"] == BOOTSTRAP_ORG_ID
    cid = conv["id"]

    # Owner can read
    assert client.get(f"/conversations/{cid}", headers=headers_a).status_code == 200

    # Other user gets 404 (not 403)
    for method, path, kwargs in [
        ("get", f"/conversations/{cid}", {}),
        ("get", f"/conversations/{cid}/messages", {}),
        ("get", f"/conversations/{cid}/workspace", {}),
        ("patch", f"/conversations/{cid}", {"json": {"title": "hijack"}}),
        ("delete", f"/conversations/{cid}", {}),
    ]:
        resp = getattr(client, method)(path, headers=headers_b, **kwargs)
        assert resp.status_code == 404, f"{method} {path} -> {resp.status_code} {resp.text}"

    # List for B does not include A's conversation
    listed = client.get("/conversations", headers=headers_b)
    assert listed.status_code == 200
    assert all(c["id"] != cid for c in listed.json())

    # List for A includes it
    listed_a = client.get("/conversations", headers=headers_a)
    assert listed_a.status_code == 200
    assert any(c["id"] == cid for c in listed_a.json())


def test_legacy_sandbox_agent_run_routes_are_absent(monkeypatch):
    """PR-13 severe: Sandbox /agent-runs must not be mounted (Agent MySQL only)."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(_unique("run_alice"))
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    created = client.post(
        "/conversations",
        json={"title": "Alice run"},
        headers=headers_a,
    )
    assert created.status_code == 201, created.text
    conversation_id = created.json()["id"]
    run_id = _unique("run_legacy")

    for method, path, kwargs in (
        ("post", "/agent-runs", {"json": {"conversation_id": conversation_id}}),
        ("get", "/agent-runs", {"params": {"conversation_id": conversation_id}}),
        ("get", f"/agent-runs/{run_id}", {}),
        ("get", f"/agent-runs/{run_id}/events", {}),
        ("post", f"/agent-runs/{run_id}/events", {"json": {"event_type": "x"}}),
        ("post", "/tool-executions", {"json": {"tool_call_id": "t1", "run_id": run_id}}),
    ):
        resp = getattr(client, method)(path, headers=headers_a, **kwargs)
        assert resp.status_code == 404, f"{method.upper()} {path} → {resp.status_code}"


def test_legacy_sandbox_agent_session_routes_are_absent(monkeypatch):
    """PR-13 severe: Sandbox /agent-sessions had no ownership — must not be mounted."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(_unique("sess_alice"))
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    created = client.post(
        "/conversations",
        json={"title": "Alice session"},
        headers=headers_a,
    )
    assert created.status_code == 201, created.text
    conversation_id = created.json()["id"]
    sid = _unique("asess")

    for method, path, kwargs in (
        (
            "post",
            "/agent-sessions",
            {
                "json": {
                    "conversation_id": conversation_id,
                    "sdk_session_id": "sdk_x",
                    "workspace_id": "ws_x",
                }
            },
        ),
        ("get", f"/agent-sessions/{sid}", {}),
        ("post", f"/agent-sessions/{sid}/resume", {"json": {}}),
        ("get", f"/agent-sessions/{sid}/entries", {}),
        ("post", f"/agent-sessions/{sid}/entries", {"json": {"entries": []}}),
        ("get", f"/conversations/{conversation_id}/agent-session", {}),
    ):
        resp = getattr(client, method)(path, headers=headers_a, **kwargs)
        assert resp.status_code == 404, f"{method.upper()} {path} → {resp.status_code}"


def test_cross_org_conversation_404(monkeypatch):
    """Users in different orgs cannot see each other's conversations."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    # Ensure second org exists
    from datetime import datetime, timezone

    org2 = "org_other_test"
    now = datetime.now(timezone.utc).isoformat()
    with database.connect() as conn:
        conn.execute(
            """
            INSERT INTO organizations (id, name, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(id) DO NOTHING
            """,
            (org2, "Other Org", now),
        )
        conn.commit()

    a = _register(_unique("org_a_user"))
    # Force second user into other org via repository
    uname = _unique("org_b_user")
    users = UserRepository()
    uid = f"user_{uuid.uuid4().hex[:12]}"
    from sandbox.auth import hash_password

    users.create(
        user_id=uid,
        username=uname,
        password_hash=hash_password("secret123"),
        organization_id=org2,
    )
    login = client.post("/auth/login", json={"username": uname, "password": "secret123"})
    assert login.status_code == 200
    token_b = login.json()["token"]
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {token_b}"}

    created = client.post(
        "/conversations",
        json={"title": "Org A only"},
        headers=headers_a,
    )
    assert created.status_code == 201
    cid = created.json()["id"]

    resp = client.get(f"/conversations/{cid}", headers=headers_b)
    assert resp.status_code == 404


def test_unauthenticated_conversations_401(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    assert client.get("/conversations").status_code == 401
    assert client.post("/conversations", json={"title": "x"}).status_code == 401


def test_service_token_alone_cannot_list_conversations_as_god(monkeypatch):
    """Service token without acting user is not an end-user actor for conversations."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "svc-secret")

    # Create a conversation as a real user first
    monkeypatch.setattr(settings, "api_token", "")
    user = _register(_unique("svc_guard"))
    headers_u = {"Authorization": f"Bearer {user['token']}"}
    c = client.post("/conversations", json={"title": "owned"}, headers=headers_u)
    assert c.status_code == 201
    cid = c.json()["id"]

    monkeypatch.setattr(settings, "api_token", "svc-secret")
    # Service alone → 401 on list/create/get
    svc = {"X-API-Key": "svc-secret"}
    assert client.get("/conversations", headers=svc).status_code == 401
    assert client.post("/conversations", json={"title": "god"}, headers=svc).status_code == 401
    assert client.get(f"/conversations/{cid}", headers=svc).status_code == 401

    # Sessions: static service token alone is fail closed on public surface
    sessions = client.get("/sessions", headers=svc)
    assert sessions.status_code == 401

    # Service + acting headers works
    acting = {
        **svc,
        "X-Acting-User-Id": user["user"]["id"],
        "X-Acting-Organization-Id": user["user"]["organization_id"],
        "X-Acting-Role": "user",
    }
    listed = client.get("/conversations", headers=acting)
    assert listed.status_code == 200
    assert any(x["id"] == cid for x in listed.json())


def test_bootstrap_backfill_and_orphan_count():
    """Conversation without owner is backfilled to bootstrap; orphans go to 0."""
    repo = ConversationRepository()
    cid = f"orphan_{uuid.uuid4().hex[:10]}"
    # Insert raw row with null ownership (simulating pre-migration data)
    with database.connect() as conn:
        conn.execute(
            """
            INSERT INTO conversations (
                id, title, sandbox_session_id, workspace_path, messages,
                owner_user_id, organization_id, created_at, updated_at
            ) VALUES (?, 'legacy', NULL, NULL, '[]', NULL, NULL, datetime('now'), datetime('now'))
            """,
            (cid,),
        )
        conn.commit()

    orphans_before = count_conversation_orphans()
    assert orphans_before >= 1

    report = database.migrate_ownership()
    assert report["orphans_after"] == 0
    assert count_conversation_orphans() == 0

    conv = repo.get(cid)
    assert conv is not None
    assert conv.owner_user_id == BOOTSTRAP_USER_ID
    assert conv.organization_id == BOOTSTRAP_ORG_ID

    # cleanup
    repo.delete(cid)


def test_auth_off_open_mode_still_works(monkeypatch):
    """With auth disabled, conversations remain open (dev mode)."""
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")
    r = client.post("/conversations", json={"title": "open-dev"})
    assert r.status_code == 201
    conv = r.json()
    assert conv["owner_user_id"] == BOOTSTRAP_USER_ID
    assert client.get(f"/conversations/{conv['id']}").status_code == 200
    client.delete(f"/conversations/{conv['id']}")


def test_session_create_rejects_jwt_binding_under_auth(monkeypatch):
    """Auth mode: JWT cannot declare formal AgentSession/Workspace bindings."""
    from tests.conftest import session_create_payload

    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    user = _register(_unique("sess_actor"))
    headers = {"Authorization": f"Bearer {user['token']}"}
    r = client.post(
        "/sessions",
        json=session_create_payload("test", user_id="should-be-ignored"),
        headers=headers,
    )
    assert r.status_code == 503, r.text
    detail = (r.json().get("detail") or "").lower()
    assert "binding" in detail or "hmac" in detail or "unavailable" in detail


def test_register_ignores_client_organization_id():
    """Phase 1: clients cannot self-select org on register."""
    data = _register(_unique("org_force"), organization_id="org_evil_hijack")
    assert data["user"]["organization_id"] == BOOTSTRAP_ORG_ID


def test_cross_user_session_files_404(monkeypatch):
    """User B cannot list/read files in user A's owned session."""
    from sandbox.services.session_manager import session_manager
    from sandbox.services.workspace_manager import workspace_manager
    from tests.conftest import formal_id

    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")

    a = _register(_unique("file_alice"))
    b = _register(_unique("file_bob"))
    headers_a = {"Authorization": f"Bearer {a['token']}"}
    headers_b = {"Authorization": f"Bearer {b['token']}"}

    # Seed owned session via service layer (HTTP create is fail-closed under auth).
    agent, wsp = formal_id("AGT"), formal_id("WSP")
    seeded = session_manager.create(
        agent_session_id=agent,
        workspace_id=wsp,
        user_id=a["user"]["id"],
        caller_id="seed-owner",
        metadata={"organization_id": a["user"]["organization_id"]},
    )
    workspace_manager.init_workspace(wsp)
    sid = seeded.session_id

    # Owner can list (empty)
    assert client.get(f"/sessions/{sid}/files", headers=headers_a).status_code == 200

    # Other user: 404 (no leak)
    assert client.get(f"/sessions/{sid}/files", headers=headers_b).status_code == 404
    assert client.get(f"/sessions/{sid}/artifacts", headers=headers_b).status_code == 404

    # Service token alone cannot access owned session files
    monkeypatch.setattr(settings, "api_token", "svc-file")
    assert (
        client.get(f"/sessions/{sid}/files", headers={"X-API-Key": "svc-file"}).status_code
        == 401
    )
