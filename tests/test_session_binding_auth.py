"""PR-07A severe auth/ownership regressions for session binding.

Production (auth_enabled) must fail closed on:
- forged AgentSession/Workspace bindings
- static service-token-alone access to public session APIs
- cross-org admin / missing ownership metadata
- delete that would free a binding while residual workspace data remains

Tests explicitly enable auth — they do not weaken production gates via
global auth_disabled (except intentional dev-mode cases).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from sandbox.auth import create_token
from sandbox.config import settings
from sandbox.main import app
from sandbox.security.ownership import BOOTSTRAP_ORG_ID
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import WorkspaceCleanupError, workspace_manager
from tests.conftest import formal_id, session_create_payload

client = TestClient(app)


def _agent_wsp() -> tuple[str, str]:
    return formal_id("AGT"), formal_id("WSP")


def _seed_session(
    *,
    user_id: str,
    organization_id: str,
    agent: str | None = None,
    wsp: str | None = None,
):
    agent = agent or formal_id("AGT")
    wsp = wsp or formal_id("WSP")
    session = session_manager.create(
        agent_session_id=agent,
        workspace_id=wsp,
        user_id=user_id,
        caller_id="seed",
        metadata={"organization_id": organization_id},
    )
    workspace_manager.init_workspace(wsp)
    # Ensure metadata stamp (create already stores it)
    return session, agent, wsp


@pytest.fixture
def auth_on(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    yield


def test_auth_on_jwt_cannot_declare_workspace_binding(auth_on):
    token = create_token("user_forge", "forger", role="user", ttl_seconds=120)
    agent, wsp = _agent_wsp()
    resp = client.post(
        "/sessions",
        json=session_create_payload(
            "jwt-forge",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 503, resp.text
    assert session_manager.get_by_agent_session_id(agent) is None
    assert not (settings.workspaces_path / wsp).exists()


def test_auth_on_static_api_key_cannot_declare_workspace_binding(auth_on, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "svc-secret-key")
    agent, wsp = _agent_wsp()
    resp = client.post(
        "/sessions",
        json=session_create_payload(
            "svc-forge",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
        headers={"X-API-Key": "svc-secret-key"},
    )
    assert resp.status_code == 503, resp.text
    assert session_manager.get_by_agent_session_id(agent) is None
    assert not (settings.workspaces_path / wsp).exists()


def test_auth_on_service_token_alone_cannot_list_or_get_or_delete(
    auth_on, monkeypatch
):
    """Static service token alone is not a public-plane trusted session face."""
    monkeypatch.setattr(settings, "api_token", "svc-only")
    session, agent, wsp = _seed_session(
        user_id="user_owner",
        organization_id=BOOTSTRAP_ORG_ID,
    )
    sid = session.session_id
    headers = {"X-API-Key": "svc-only"}

    assert client.get("/sessions", headers=headers).status_code == 401
    assert client.get(f"/sessions/{sid}", headers=headers).status_code == 401
    assert client.get(f"/sessions/by-agent/{agent}", headers=headers).status_code == 401
    assert (
        client.get(
            f"/sessions/by-enterprise/{session.enterprise_session_id or 'none'}",
            headers=headers,
        ).status_code
        == 401
    )
    assert client.delete(f"/sessions/{sid}", headers=headers).status_code == 401
    # Files / executions also fail closed (service token alone)
    assert client.get(f"/sessions/{sid}/files", headers=headers).status_code == 401
    assert (
        client.post(
            f"/sessions/{sid}/executions/command",
            json={"command": "echo x"},
            headers=headers,
        ).status_code
        == 401
    )
    # Session still present (no side effect)
    assert session_manager.get(sid) is not None
    assert (settings.workspaces_path / wsp).exists()


def test_auth_on_acting_headers_cannot_declare_workspace_binding(auth_on, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "svc-acting")
    agent, wsp = _agent_wsp()
    headers = {
        "X-API-Key": "svc-acting",
        "X-Acting-User-Id": "user_acting",
        "X-Acting-Organization-Id": BOOTSTRAP_ORG_ID,
        "X-Acting-Role": "user",
    }
    resp = client.post(
        "/sessions",
        json=session_create_payload(
            "acting-forge",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
        headers=headers,
    )
    assert resp.status_code == 503, resp.text
    assert session_manager.get_by_agent_session_id(agent) is None


def test_jwt_list_sessions_does_not_leak_other_users(auth_on, monkeypatch):
    s_a, _, wsp_a = _seed_session(
        user_id="user_alice", organization_id=BOOTSTRAP_ORG_ID
    )
    s_b, _, wsp_b = _seed_session(
        user_id="user_bob", organization_id=BOOTSTRAP_ORG_ID
    )

    tok_a = create_token(
        "user_alice",
        "alice",
        role="user",
        organization_id=BOOTSTRAP_ORG_ID,
        ttl_seconds=120,
    )
    listed = client.get(
        "/sessions",
        headers={"Authorization": f"Bearer {tok_a}"},
    )
    assert listed.status_code == 200, listed.text
    ids = {row["session_id"] for row in listed.json()}
    assert s_a.session_id in ids
    assert s_b.session_id not in ids

    cross = client.get(
        f"/sessions/{s_b.session_id}",
        headers={"Authorization": f"Bearer {tok_a}"},
    )
    assert cross.status_code == 404

    monkeypatch.setattr(settings, "auth_enabled", False)
    session_manager.delete(s_a.session_id)
    session_manager.delete(s_b.session_id)
    workspace_manager.remove_workspace(wsp_a)
    workspace_manager.remove_workspace(wsp_b)


def test_cross_org_admin_cannot_list_get_delete(auth_on, monkeypatch):
    """Admin is org-scoped; cross-org access is 404 / not listed."""
    org_a = "org_alpha_aaaaaaaaaaaaaa"
    org_b = "org_beta_bbbbbbbbbbbbbbb"
    # Normalize to formal-looking but org ids in tokens need not be ULIDs
    org_a = "org_alpha"
    org_b = "org_beta"

    s_a, _, wsp_a = _seed_session(user_id="user_in_a", organization_id=org_a)
    s_b, _, wsp_b = _seed_session(user_id="user_in_b", organization_id=org_b)

    admin_a = create_token(
        "admin_a",
        "adminA",
        role="admin",
        organization_id=org_a,
        ttl_seconds=120,
    )
    headers = {"Authorization": f"Bearer {admin_a}"}

    listed = client.get("/sessions", headers=headers)
    assert listed.status_code == 200
    ids = {row["session_id"] for row in listed.json()}
    assert s_a.session_id in ids
    assert s_b.session_id not in ids

    assert client.get(f"/sessions/{s_b.session_id}", headers=headers).status_code == 404
    assert client.delete(f"/sessions/{s_b.session_id}", headers=headers).status_code == 404
    # Session B still present
    assert session_manager.get(s_b.session_id) is not None
    assert (settings.workspaces_path / wsp_b).exists()

    # Admin A can delete own-org session
    assert client.delete(f"/sessions/{s_a.session_id}", headers=headers).status_code == 204

    monkeypatch.setattr(settings, "auth_enabled", False)
    if session_manager.get(s_b.session_id):
        session_manager.delete(s_b.session_id)
        workspace_manager.remove_workspace(wsp_b)


def test_missing_org_metadata_fail_closed(auth_on):
    """Sessions without organization_id are not accessible under auth."""
    agent, wsp = _agent_wsp()
    session = session_manager.create(
        agent_session_id=agent,
        workspace_id=wsp,
        user_id="user_orphan_meta",
        caller_id="seed",
        # no organization_id in metadata
    )
    workspace_manager.init_workspace(wsp)
    tok = create_token(
        "user_orphan_meta",
        "orphan",
        role="user",
        organization_id=BOOTSTRAP_ORG_ID,
        ttl_seconds=120,
    )
    headers = {"Authorization": f"Bearer {tok}"}
    assert client.get(f"/sessions/{session.session_id}", headers=headers).status_code == 404
    assert client.get(f"/sessions/{session.session_id}/files", headers=headers).status_code == 404
    listed = client.get("/sessions", headers=headers)
    assert listed.status_code == 200
    assert session.session_id not in {r["session_id"] for r in listed.json()}


def test_jwt_cannot_delete_other_users_session(auth_on, monkeypatch):
    s, _, wsp = _seed_session(
        user_id="user_owner", organization_id=BOOTSTRAP_ORG_ID
    )
    tok = create_token(
        "user_other",
        "other",
        role="user",
        organization_id=BOOTSTRAP_ORG_ID,
        ttl_seconds=120,
    )
    resp = client.delete(
        f"/sessions/{s.session_id}",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert resp.status_code == 404
    assert session_manager.get(s.session_id) is not None
    assert (settings.workspaces_path / wsp).exists()

    monkeypatch.setattr(settings, "auth_enabled", False)
    session_manager.delete(s.session_id)
    workspace_manager.remove_workspace(wsp)


def test_auth_off_dev_mode_create_still_works(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")
    agent, wsp = _agent_wsp()
    resp = client.post(
        "/sessions",
        json=session_create_payload(
            "dev-ok",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
    )
    assert resp.status_code == 201, resp.text
    client.delete(f"/sessions/{resp.json()['session_id']}")


def test_init_failure_compensates_new_binding_row(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")
    ws_root = tmp_path / "workspaces"
    temp_root = tmp_path / "tmp"
    ws_root.mkdir()
    temp_root.mkdir()
    monkeypatch.setattr(settings, "workspaces_root", str(ws_root))
    monkeypatch.setattr(settings, "temp_root", str(temp_root))

    agent, wsp = _agent_wsp()
    calls = {"n": 0}
    real_init = workspace_manager.init_workspace

    def flaky_init(workspace_id: str):
        calls["n"] += 1
        if calls["n"] == 1:
            return real_init(workspace_id)
        raise OSError("simulated init failure")

    monkeypatch.setattr(workspace_manager, "init_workspace", flaky_init)

    resp = client.post(
        "/sessions",
        json=session_create_payload(
            "init-fail",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
    )
    assert resp.status_code in (400, 403, 500), resp.text
    assert session_manager.get_by_agent_session_id(agent) is None


def test_delete_refuses_while_execution_busy(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")
    agent, wsp = _agent_wsp()
    created = client.post(
        "/sessions",
        json=session_create_payload(
            "busy-del",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
    )
    assert created.status_code == 201, created.text
    sid = created.json()["session_id"]

    from sandbox.services.execution_manager import execution_manager

    monkeypatch.setattr(execution_manager, "is_session_busy", lambda _sid: True)
    monkeypatch.setattr(execution_manager, "is_workspace_busy", lambda _wid: False)
    monkeypatch.setattr(execution_manager, "cancel_active_workspace", lambda _wid: None)

    resp = client.delete(f"/sessions/{sid}")
    assert resp.status_code == 409, resp.text
    assert session_manager.get(sid) is not None
    assert (settings.workspaces_path / wsp).exists()

    monkeypatch.setattr(execution_manager, "is_session_busy", lambda _sid: False)
    assert client.delete(f"/sessions/{sid}").status_code == 204


def test_delete_cleanup_failure_retains_binding(monkeypatch):
    """If remove_workspace fails, binding must not be freed (no orphan reuse)."""
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")
    agent, wsp = _agent_wsp()
    created = client.post(
        "/sessions",
        json=session_create_payload(
            "cleanup-fail",
            agent_session_id=agent,
            workspace_id=wsp,
        ),
    )
    assert created.status_code == 201, created.text
    sid = created.json()["session_id"]
    # Plant data that must not become reusable after a failed cleanup.
    physical = settings.workspaces_path / wsp
    (physical / "secret.txt").write_text("residual-data", encoding="utf-8")

    def boom(_wid: str) -> None:
        raise WorkspaceCleanupError("injected cleanup failure")

    monkeypatch.setattr(workspace_manager, "remove_workspace", boom)

    resp = client.delete(f"/sessions/{sid}")
    assert resp.status_code == 500, resp.text
    # Binding retained
    assert session_manager.get(sid) is not None
    held = session_manager.get_by_agent_session_id(agent)
    assert held is not None
    assert held.workspace_id == wsp
    # Residual data still on disk (cleanup failed)
    assert (physical / "secret.txt").read_text(encoding="utf-8") == "residual-data"

    # Different AgentSession must not claim the still-bound workspace.
    from sandbox.services.session_manager import WorkspaceBindingConflict

    other_agent = formal_id("AGT")
    with pytest.raises(WorkspaceBindingConflict):
        session_manager.create(
            agent_session_id=other_agent,
            workspace_id=wsp,
            user_id="other",
            caller_id="steal",
        )

    # Teardown via real WorkspaceManager method (bypass the injected boom).
    from sandbox.services.workspace_manager import WorkspaceManager

    WorkspaceManager.remove_workspace(workspace_manager, wsp)
    session_manager.delete(sid)
