"""Tests for API token authentication middleware."""

from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.main import app
from sandbox.security.public_routes import is_public_route


def test_no_token_returns_401(monkeypatch):
    """Requests without X-API-Key header should be rejected when token is set."""
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/sessions")
    assert resp.status_code == 401
    assert "token" in resp.json()["detail"].lower()


def test_wrong_token_returns_401(monkeypatch):
    """Requests with wrong X-API-Key should be rejected."""
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/sessions", headers={"X-API-Key": "wrong-token"})
    assert resp.status_code == 401


def test_valid_token_allows_request(monkeypatch):
    """Requests with correct X-API-Key should proceed (may 404, not 401)."""
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/sessions", headers={"X-API-Key": "test-token"})
    assert resp.status_code != 401


def test_health_exempt_from_auth(monkeypatch):
    """Health endpoint should be accessible without token."""
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200


def test_metrics_exempt_from_auth(monkeypatch):
    """Metrics endpoint should be accessible without token."""
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code == 200


def test_auth_disabled_by_default(monkeypatch):
    """When no token is set, all endpoints should be accessible."""
    monkeypatch.setattr(settings, "api_token", "")
    monkeypatch.setattr(settings, "auth_enabled", False)
    client = TestClient(app)
    resp = client.get("/sessions")
    assert resp.status_code != 401


def test_public_route_helper_exact_root_only():
    """Bare '/' is public; every other absolute path is not via startswith('/') ."""
    assert is_public_route("/") is True
    assert is_public_route("/sessions") is False
    assert is_public_route("/health") is True
    assert is_public_route("/ready") is True
    assert is_public_route("/metrics") is True
    assert is_public_route("/docs") is True
    assert is_public_route("/docs/oauth2-redirect") is True
    assert is_public_route("/openapi.json") is True
    assert is_public_route("/redoc") is True
    assert is_public_route("/auth/login") is True
    assert is_public_route("/auth/register") is True
    # Must not treat everything as public because of startswith("/")
    assert is_public_route("/anything") is False
    assert is_public_route("/sessions/foo") is False


def test_root_public_with_api_token(monkeypatch):
    monkeypatch.setattr(settings, "api_token", "test-token")
    client = TestClient(app)
    resp = client.get("/")
    assert resp.status_code == 200
