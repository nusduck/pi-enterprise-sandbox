"""Wire-level smoke test for the facade's authenticated Streamable HTTP route."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_mcp_endpoint_requires_bearer_and_accepts_initialize(monkeypatch):
    from sandbox.mcp import app as mcp_app
    from mcp.types import LATEST_PROTOCOL_VERSION

    class _Service:
        async def start(self):
            return None

        async def close(self):
            return None

    # The manager is intentionally started once for this module-level app.
    monkeypatch.setattr(mcp_app, "service", _Service())
    monkeypatch.setattr(mcp_app.settings, "token", "outer-test-token")
    with TestClient(mcp_app.app, base_url="http://localhost") as client:
        # Service root is not the MCP protocol path (common operator misconfig).
        root = client.post("/")
        assert root.status_code == 404
        assert root.json()["mcp"] == "/mcp"
        assert "/mcp" in root.json()["detail"]

        assert client.post("/mcp", json={}).status_code == 401
        response = client.post(
            "/mcp",
            headers={
                "Authorization": "Bearer outer-test-token",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": LATEST_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            },
        )
    assert response.status_code == 200
    assert response.json()["result"]["serverInfo"]["name"] == "Enterprise Sandbox"
