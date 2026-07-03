"""Tests for API token authentication middleware."""

from fastapi.testclient import TestClient
from sandbox.main import app
from sandbox.config import settings


def test_no_token_returns_401():
    """Requests without X-API-Key header should be rejected when token is set."""
    settings.api_token = "test-token"
    client = TestClient(app)
    resp = client.get("/sessions")
    assert resp.status_code == 401
    assert "token" in resp.json()["detail"].lower()


def test_wrong_token_returns_401():
    """Requests with wrong X-API-Key should be rejected."""
    settings.api_token = "test-token"
    client = TestClient(app)
    resp = client.get("/sessions", headers={"X-API-Key": "wrong-token"})
    assert resp.status_code == 401


def test_valid_token_allows_request():
    """Requests with correct X-API-Key should proceed (may 404, not 401)."""
    settings.api_token = "test-token"
    client = TestClient(app)
    resp = client.get("/sessions", headers={"X-API-Key": "test-token"})
    assert resp.status_code != 401


def test_health_exempt_from_auth():
    """Health endpoint should be accessible without token."""
    settings.api_token = "test-token"
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200


def test_metrics_exempt_from_auth():
    """Metrics endpoint should be accessible without token."""
    settings.api_token = "test-token"
    client = TestClient(app)
    resp = client.get("/metrics")
    assert resp.status_code == 200


def test_auth_disabled_by_default():
    """When no token is set, all endpoints should be accessible."""
    settings.api_token = ""
    client = TestClient(app)
    resp = client.get("/sessions")
    assert resp.status_code != 401
