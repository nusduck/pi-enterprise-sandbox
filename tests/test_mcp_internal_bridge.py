"""Offline coverage for the Agent-independent Sandbox MCP bridge."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.isolation import build_isolation_backend
from sandbox.mcp import runtime as mcp_runtime
from sandbox.routers.mcp_internal import router
from sandbox.services.execution_manager import ExecutionManager


def _id(prefix: str) -> str:
    return prefix + "0" * (26 - len(prefix))


def _payload() -> dict[str, str]:
    return {
        "sandbox_session_id": _id("S"),
        "workspace_id": _id("W"),
    }


def _client(monkeypatch) -> TestClient:
    monkeypatch.setattr(settings, "mcp_internal_token", "bridge-test-token")
    monkeypatch.setattr(settings, "isolation_backend", "direct")
    monkeypatch.setattr(settings, "isolation_required", False)
    monkeypatch.setattr(
        mcp_runtime,
        "execution_manager",
        ExecutionManager(isolation_backend=build_isolation_backend()),
    )
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_mcp_bridge_rejects_missing_or_wrong_bearer(monkeypatch):
    client = _client(monkeypatch)
    assert client.post("/internal/mcp/v1/context/ensure", json=_payload()).status_code == 401
    assert client.post(
        "/internal/mcp/v1/context/ensure",
        json=_payload(),
        headers={"Authorization": "Bearer wrong"},
    ).status_code == 401


def test_mcp_bridge_runs_python_and_persists_workspace_files(monkeypatch):
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer bridge-test-token"}
    base = _payload()

    ensured = client.post("/internal/mcp/v1/context/ensure", json=base, headers=headers)
    assert ensured.status_code == 200
    assert ensured.json() == base

    executed = client.post(
        "/internal/mcp/v1/python/execute",
        json=base | {"code": "print('mcp-ok')", "timeout_seconds": 10},
        headers=headers,
    )
    assert executed.status_code == 200
    assert executed.json()["stdout_preview"] == "mcp-ok\n"

    written = client.post(
        "/internal/mcp/v1/files/write",
        json=base | {"path": "report.txt", "content": "hello", "mode": "overwrite"},
        headers=headers,
    )
    assert written.status_code == 200
    assert written.json()["size"] == 5

    read = client.post(
        "/internal/mcp/v1/files/read",
        json=base | {"path": "report.txt"},
        headers=headers,
    )
    assert read.status_code == 200
    assert read.json()["content"] == "hello"

    listed = client.post(
        "/internal/mcp/v1/files/list",
        json=base | {"path": ".", "depth": 1},
        headers=headers,
    )
    assert listed.status_code == 200
    assert any(item["path"] == "report.txt" for item in listed.json()["items"])


def test_mcp_bridge_snapshots_artifact_without_exposing_workspace(monkeypatch):
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer bridge-test-token"}
    base = _payload()
    artifact_id = _id("A")
    client.post(
        "/internal/mcp/v1/files/write",
        json=base | {"path": "result.csv", "content": "a,b\n1,2\n", "mode": "overwrite"},
        headers=headers,
    )
    submitted = client.post(
        "/internal/mcp/v1/artifacts/submit",
        json=base | {"artifact_id": artifact_id, "source_path": "result.csv"},
        headers=headers,
    )
    assert submitted.status_code == 200
    assert submitted.json()["size"] == 8

    content = client.get(
        f"/internal/mcp/v1/artifacts/{artifact_id}/content", headers=headers
    )
    assert content.status_code == 200
    assert content.content == b"a,b\n1,2\n"


def test_mcp_bridge_runs_shell_command_in_workspace(monkeypatch):
    # Direct-backend unit tests share the host UID: disable RLIMIT_NPROC so
    # bash can fork external commands (production tightens it inside bwrap).
    monkeypatch.setattr(settings, "max_process_count", 0)
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer bridge-test-token"}
    base = _payload()

    client.post(
        "/internal/mcp/v1/files/write",
        json=base | {"path": "notes.txt", "content": "alpha\nbeta\n", "mode": "overwrite"},
        headers=headers,
    )
    executed = client.post(
        "/internal/mcp/v1/shell/execute",
        json=base | {"command": "wc -l < notes.txt", "timeout_seconds": 10},
        headers=headers,
    )
    assert executed.status_code == 200
    body = executed.json()
    assert body["status"] == "SUCCESS"
    assert body["exit_code"] == 0
    # wc output is zero/space-padded differently across platforms; strip it.
    assert body["stdout_preview"].strip() == "2"


def test_mcp_bridge_shell_rejects_extra_fields_and_bad_timeout(monkeypatch):
    client = _client(monkeypatch)
    headers = {"Authorization": "Bearer bridge-test-token"}
    base = _payload()

    extra = client.post(
        "/internal/mcp/v1/shell/execute",
        json=base | {"command": "echo hi", "unexpected": True},
        headers=headers,
    )
    assert extra.status_code == 400

    bad_timeout = client.post(
        "/internal/mcp/v1/shell/execute",
        json=base | {"command": "echo hi", "timeout_seconds": 0},
        headers=headers,
    )
    assert bad_timeout.status_code == 400
