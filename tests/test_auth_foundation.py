"""Auth foundation tests (register / login / me) against Sandbox auth_router."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.auth import create_token, hash_password, verify_password, verify_token
from sandbox.config import settings
from sandbox.main import app
from sandbox.security.public_routes import is_public_route


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


def test_auth_routes_are_public_prefixes():
    assert is_public_route("/auth/register")
    assert is_public_route("/auth/login")
    assert is_public_route("/auth/me")


def test_register_login_me_routes_exist(monkeypatch):
    """With a stub credential store, register/login/me return 200 (not 404)."""
    store: dict[str, dict] = {}

    class StubRepo:
        def get_by_username(self, username: str):
            return store.get(username)

        def get_by_external_user_id(self, external_user_id: str):
            for row in store.values():
                if row["id"] == external_user_id:
                    return row
            return None

        def create(self, **kwargs):
            entry = {
                "id": kwargs["external_user_id"],
                "username": kwargs["username"],
                "password_hash": kwargs["password_hash"],
                "email": kwargs.get("email"),
                "display_name": kwargs.get("display_name") or kwargs["username"],
                "role": kwargs.get("role") or "user",
                "organization_id": kwargs.get("external_org_id") or "org_bootstrap",
                "is_active": True,
            }
            store[entry["username"]] = entry
            return entry

        def touch_login(self, external_user_id: str) -> None:
            return None

    monkeypatch.setattr(
        "sandbox.routers.auth_router._users_repo",
        lambda: StubRepo(),
    )
    monkeypatch.setattr(settings, "auth_allow_public_register", True)

    r = client.post(
        "/auth/register",
        json={
            "username": "alice_test_user",
            "password": "secret123",
            "display_name": "Alice",
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["token"]
    assert data["user"]["username"] == "alice_test_user"

    login = client.post(
        "/auth/login",
        json={"username": "alice_test_user", "password": "secret123"},
    )
    assert login.status_code == 200, login.text
    token = login.json()["token"]

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200, me.text
    assert me.json()["username"] == "alice_test_user"


def test_duplicate_register_conflict(monkeypatch):
    class StubRepo:
        def __init__(self):
            self.seen = False

        def get_by_username(self, username: str):
            return {"id": "u1", "username": username, "is_active": True} if self.seen else None

        def create(self, **kwargs):
            self.seen = True
            return {
                "id": kwargs["external_user_id"],
                "username": kwargs["username"],
                "password_hash": kwargs["password_hash"],
                "display_name": kwargs["username"],
                "role": "user",
                "organization_id": "org_bootstrap",
                "is_active": True,
            }

        def touch_login(self, external_user_id: str) -> None:
            return None

    repo = StubRepo()
    monkeypatch.setattr("sandbox.routers.auth_router._users_repo", lambda: repo)
    monkeypatch.setattr(settings, "auth_allow_public_register", True)

    first = client.post(
        "/auth/register",
        json={"username": "dup_user", "password": "secret123"},
    )
    assert first.status_code == 200
    second = client.post(
        "/auth/register",
        json={"username": "dup_user", "password": "secret123"},
    )
    assert second.status_code == 409


class _AdminStubRepo:
    """Credential store with a mutable role, for admin bootstrap tests."""

    def __init__(self, seed: dict | None = None):
        self.rows: dict[str, dict] = dict(seed or {})
        self.role_writes: list[tuple[str, str]] = []

    def get_by_username(self, username: str):
        return self.rows.get(username)

    def get_by_external_user_id(self, external_user_id: str):
        for row in self.rows.values():
            if row["id"] == external_user_id:
                return row
        return None

    def create(self, **kwargs):
        entry = {
            "id": kwargs["external_user_id"],
            "username": kwargs["username"],
            "password_hash": kwargs["password_hash"],
            "email": kwargs.get("email"),
            "display_name": kwargs.get("display_name") or kwargs["username"],
            "role": kwargs.get("role") or "user",
            "organization_id": kwargs.get("external_org_id") or "org_bootstrap",
            "is_active": True,
        }
        self.rows[entry["username"]] = entry
        return entry

    def set_role(self, external_user_id: str, role: str) -> None:
        self.role_writes.append((external_user_id, role))
        for row in self.rows.values():
            if row["id"] == external_user_id:
                row["role"] = role

    def touch_login(self, external_user_id: str) -> None:
        return None


def _use_repo(monkeypatch, repo, admins):
    monkeypatch.setattr("sandbox.routers.auth_router._users_repo", lambda: repo)
    monkeypatch.setattr(settings, "auth_allow_public_register", True)
    monkeypatch.setattr(settings, "auth_admin_usernames", admins)


def test_register_grants_admin_only_from_the_configured_list(monkeypatch):
    """A deployment names its admins; a client cannot ask to be one."""
    repo = _AdminStubRepo()
    _use_repo(monkeypatch, repo, ["Ops_Admin"])

    listed = client.post(
        "/auth/register",
        json={"username": "ops_admin", "password": "secret123"},
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()["user"]["role"] == "admin"
    assert verify_token(listed.json()["token"])["role"] == "admin"

    # role/organization_id in the body stay ignored.
    other = client.post(
        "/auth/register",
        json={
            "username": "wants_admin",
            "password": "secret123",
            "role": "admin",
            "organization_id": "org_elsewhere",
        },
    )
    assert other.status_code == 200, other.text
    assert other.json()["user"]["role"] == "user"
    assert other.json()["user"]["organization_id"] == "org_bootstrap"


def test_login_promotes_an_account_added_to_the_admin_list(monkeypatch):
    """The bootstrap path: the account already exists when the list changes."""
    repo = _AdminStubRepo(
        {
            "existing": {
                "id": "user_existing",
                "username": "existing",
                "password_hash": hash_password("secret123"),
                "display_name": "Existing",
                "role": "user",
                "organization_id": "org_bootstrap",
                "is_active": True,
            }
        }
    )
    _use_repo(monkeypatch, repo, ["existing"])

    login = client.post(
        "/auth/login", json={"username": "existing", "password": "secret123"}
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["role"] == "admin"
    assert repo.role_writes == [("user_existing", "admin")]
    assert verify_token(login.json()["token"])["role"] == "admin"

    me = client.get(
        "/auth/me", headers={"Authorization": f"Bearer {login.json()['token']}"}
    )
    assert me.json()["role"] == "admin"


def test_dropping_a_name_from_the_list_demotes_it(monkeypatch):
    repo = _AdminStubRepo(
        {
            "former": {
                "id": "user_former",
                "username": "former",
                "password_hash": hash_password("secret123"),
                "display_name": "Former",
                "role": "admin",
                "organization_id": "org_bootstrap",
                "is_active": True,
            }
        }
    )
    _use_repo(monkeypatch, repo, [])

    login = client.post(
        "/auth/login", json={"username": "former", "password": "secret123"}
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["role"] == "user"
    assert repo.role_writes == [("user_former", "user")]


def test_login_survives_a_role_write_failure(monkeypatch):
    """Role upkeep is maintenance; it must never cost anyone their login."""

    class BrokenRepo(_AdminStubRepo):
        def set_role(self, external_user_id: str, role: str) -> None:
            raise RuntimeError("column missing")

    repo = BrokenRepo(
        {
            "alice": {
                "id": "user_alice",
                "username": "alice",
                "password_hash": hash_password("secret123"),
                "display_name": "Alice",
                "role": "user",
                "organization_id": "org_bootstrap",
                "is_active": True,
            }
        }
    )
    _use_repo(monkeypatch, repo, ["alice"])

    login = client.post(
        "/auth/login", json={"username": "alice", "password": "secret123"}
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["role"] == "user"
