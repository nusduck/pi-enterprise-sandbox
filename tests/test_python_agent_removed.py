"""Assert Python Agent runtime has been fully removed (no migration path)."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.main import app

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_sandbox_agent_package_absent():
    agent_dir = REPO_ROOT / "sandbox" / "agent"
    assert not agent_dir.exists(), "sandbox/agent/ must be deleted"
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("sandbox.agent")


def test_agent_router_module_absent():
    router_path = REPO_ROOT / "sandbox" / "routers" / "agent_router.py"
    assert not router_path.exists()
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("sandbox.routers.agent_router")


def test_agent_chat_route_absent():
    client = TestClient(app)
    resp = client.post("/agent/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 404


def test_openapi_has_no_agent_chat_path():
    client = TestClient(app)
    schema = client.get("/openapi.json").json()
    paths = schema.get("paths") or {}
    assert "/agent/chat" not in paths
