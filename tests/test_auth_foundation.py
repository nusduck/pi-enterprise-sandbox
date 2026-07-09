"""Auth foundation tests (register / login / me)."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.auth import create_token, hash_password, verify_password, verify_token
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
