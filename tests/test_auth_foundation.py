"""Auth foundation tests (register / login / me)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.auth import create_token, hash_password, verify_password, verify_token
from sandbox.config import settings
from sandbox.main import app


client = TestClient(app)


def test_password_hash_roundtrip():
    h = hash_password("secret123")
    assert verify_password("secret123", h)
    assert not verify_password("wrong", h)


def test_token_roundtrip():
    tok = create_token("user_1", "alice", role="admin", ttl_seconds=60)
    payload = verify_token(tok)
    assert payload is not None
    assert payload["sub"] == "user_1"
    assert payload["username"] == "alice"
    assert payload["role"] == "admin"
    assert payload.get("organization_id")  # default bootstrap org claim


def test_register_login_me():
    r = client.post("/auth/register", json={
        "username": "alice_test_user",
        "password": "secret123",
        "display_name": "Alice",
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["token"]
    assert data["user"]["username"] == "alice_test_user"

    login = client.post("/auth/login", json={
        "username": "alice_test_user",
        "password": "secret123",
    })
    assert login.status_code == 200
    token = login.json()["token"]

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["username"] == "alice_test_user"


def test_jwt_enabled_unauthenticated_sessions_401(monkeypatch):
    """With auth enabled, protected routes require a bearer token."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    resp = client.get("/sessions")
    assert resp.status_code == 401
    assert "auth" in resp.json()["detail"].lower() or "token" in resp.json()["detail"].lower()


def test_jwt_enabled_public_routes_remain_open(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    assert client.get("/health").status_code == 200
    assert client.get("/").status_code == 200
    # Swagger UI and login path stay public with JWT auth enabled
    assert client.get("/docs").status_code == 200
    # /auth/* is public to middleware; missing body → 422 validation, not middleware 401
    login = client.post("/auth/login", json={})
    assert login.status_code == 422


def test_jwt_valid_token_reaches_protected(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    token = create_token("user_jwt", "bob", role="user", ttl_seconds=60)
    resp = client.get("/sessions", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code != 401


def test_service_api_token_reaches_app_but_sessions_need_actor(monkeypatch):
    """Service X-API-Key passes middleware; public /sessions still requires actor.

    Static service token alone is not a trusted public-plane session face
    (HMAC internal routes are separate and not implemented yet).
    """
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "svc-secret")
    resp = client.get("/sessions", headers={"X-API-Key": "svc-secret"})
    # Route-level 401 (acting/JWT required), not middleware "Invalid API token".
    assert resp.status_code == 401
    detail = (resp.json().get("detail") or "").lower()
    assert "acting" in detail or "jwt" in detail or "authentication required" in detail
    # Health remains public without credentials.
    assert client.get("/health").status_code == 200


def test_jwt_slash_prefix_does_not_expose_all_routes(monkeypatch):
    """Regression: public policy must not treat every path as public via '/'."""
    monkeypatch.setattr(settings, "auth_enabled", True)
    monkeypatch.setattr(settings, "api_token", "")
    # Protected resources must be 401 without token (not open via startswith("/"))
    assert client.get("/sessions").status_code == 401
    assert client.get("/conversations").status_code == 401
