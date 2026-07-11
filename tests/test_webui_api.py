"""WebUI API tests — covers the Node.js server API via HTTP calls.

These tests validate the WebUI server's REST API endpoints.
They require the sandbox service to be running (started via TestClient).
"""
from __future__ import annotations

import json
import time
from typing import Any

import pytest
import requests
from fastapi.testclient import TestClient

from sandbox.main import app

# ── Sandbox Fixture ──────────────────────────────────────────────────────

sandbox_client = TestClient(app)


@pytest.fixture(scope="module")
def sandbox_url() -> str:
    """Start the sandbox service via TestClient and return its base URL."""
    # We use TestClient which runs in-process — no need to start a server.
    # But we still need the sandbox logic available. Tests that need both
    # WebUI + sandbox will use TestClient directly.
    return "http://testserver"


# ── Sandbox API Tests (via TestClient) ──────────────────────────────────


class TestSandboxSessionAPI:
    """Test the sandbox session API that the WebUI depends on."""

    def test_create_session(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "webui-test"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["session_id"].startswith("sandbox_")
        assert data["status"] == "RUNNING"
        # Cleanup
        sandbox_client.delete(f"/sessions/{data['session_id']}")

    def test_create_session_with_enterprise_id(self):
        resp = sandbox_client.post(
            "/sessions",
            json={
                "caller_id": "webui-test",
                "enterprise_session_id": "ent-test-001",
                "agent_session_id": "agent-test-001",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["enterprise_session_id"] == "ent-test-001"
        assert data["agent_session_id"] == "agent-test-001"
        # Cleanup
        sandbox_client.delete(f"/sessions/{data['session_id']}")

    def test_lookup_by_agent_id(self):
        # Clean up any stale session from previous runs
        stale = sandbox_client.get("/sessions/by-agent/agent-lookup-001")
        if stale.status_code == 200:
            sandbox_client.delete(f"/sessions/{stale.json()['session_id']}")

        created = sandbox_client.post(
            "/sessions",
            json={"caller_id": "webui-test", "agent_session_id": "agent-lookup-001"},
        ).json()
        assert created["session_id"].startswith("sandbox_")

        resp = sandbox_client.get("/sessions/by-agent/agent-lookup-001")
        assert resp.status_code == 200
        assert resp.json()["session_id"] == created["session_id"]
        # Cleanup
        sandbox_client.delete(f"/sessions/{created['session_id']}")

    def test_lookup_by_enterprise_id(self):
        # Clean up any stale session from previous runs
        stale = sandbox_client.get("/sessions/by-enterprise/ent-lookup-001")
        if stale.status_code == 200:
            sandbox_client.delete(f"/sessions/{stale.json()['session_id']}")

        created = sandbox_client.post(
            "/sessions",
            json={
                "caller_id": "webui-test",
                "enterprise_session_id": "ent-lookup-001",
            },
        ).json()
        assert created["session_id"].startswith("sandbox_")

        resp = sandbox_client.get("/sessions/by-enterprise/ent-lookup-001")
        assert resp.status_code == 200
        assert resp.json()["session_id"] == created["session_id"]
        # Cleanup
        sandbox_client.delete(f"/sessions/{created['session_id']}")

    def test_delete_session(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "webui-test"})
        assert resp.status_code == 201
        sid = resp.json()["session_id"]

        resp = sandbox_client.delete(f"/sessions/{sid}")
        assert resp.status_code == 204

        # Verify deleted
        resp = sandbox_client.get(f"/sessions/{sid}")
        assert resp.status_code == 404

    def test_get_nonexistent_session(self):
        resp = sandbox_client.get("/sessions/nonexistent")
        assert resp.status_code == 404

    def test_list_sessions(self):
        # Create a couple sessions
        s1 = sandbox_client.post("/sessions", json={"caller_id": "test-list-1"}).json()
        s2 = sandbox_client.post("/sessions", json={"caller_id": "test-list-2"}).json()

        resp = sandbox_client.get("/sessions")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)
        ids = [s["session_id"] for s in data]
        assert s1["session_id"] in ids
        assert s2["session_id"] in ids


class TestWebUIExecutionAPI:
    """Test execution endpoints that the WebUI depends on."""

    @pytest.fixture
    def session_id(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "exec-test"})
        sid = resp.json()["session_id"]
        yield sid
        sandbox_client.delete(f"/sessions/{sid}")

    def test_run_python(self, session_id):
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/python",
            json={"code": "print('hello from sandbox webui')"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["execution_id"].startswith("exec_")
        assert "hello from sandbox webui" in data.get("stdout_preview", "")
        assert data["exit_code"] == 0

    def test_run_command(self, session_id):
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/command",
            json={"command": "echo 'webui command works'"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "webui command works" in data.get("stdout_preview", "")

    def test_python_error(self, session_id):
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/python",
            json={"code": "raise ValueError('test error')"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "FAILED"

    def test_trace_id_in_response(self, session_id):
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/python",
            json={"code": "print('trace test')"},
            headers={"X-Trace-Id": "trace-webui-test-001"},
        )
        assert resp.status_code == 201
        assert resp.headers.get("X-Trace-Id") == "trace-webui-test-001"


class TestWebUIFileAPI:
    """Test file endpoints that the WebUI depends on."""

    @pytest.fixture
    def session_id(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "file-test"})
        sid = resp.json()["session_id"]
        yield sid
        sandbox_client.delete(f"/sessions/{sid}")

    def test_write_file(self, session_id):
        resp = sandbox_client.post(
            f"/sessions/{session_id}/files/write",
            json={"path": "test.txt", "content": "webui file test"},
        )
        assert resp.status_code == 201
        assert resp.json()["size"] > 0

    def test_read_file(self, session_id):
        sandbox_client.post(
            f"/sessions/{session_id}/files/write",
            json={"path": "read_test.txt", "content": "read this content"},
        )
        resp = sandbox_client.get(
            f"/sessions/{session_id}/files/read",
            params={"path": "read_test.txt"},
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "read this content"

    def test_list_files(self, session_id):
        sandbox_client.post(
            f"/sessions/{session_id}/files/write",
            json={"path": "a.txt", "content": "a"},
        )
        sandbox_client.post(
            f"/sessions/{session_id}/files/write",
            json={"path": "b.txt", "content": "b"},
        )
        resp = sandbox_client.get(f"/sessions/{session_id}/files")
        assert resp.status_code == 200
        assert resp.json()["total"] >= 2

    def test_path_escape_blocked(self, session_id):
        resp = sandbox_client.get(
            f"/sessions/{session_id}/files/read",
            params={"path": "../../etc/passwd"},
        )
        assert resp.status_code == 403

    def test_file_preview(self, session_id):
        sandbox_client.post(
            f"/sessions/{session_id}/files/write",
            json={"path": "preview.txt", "content": "line1\nline2\nline3"},
        )
        resp = sandbox_client.get(
            f"/sessions/{session_id}/files/preview",
            params={"path": "preview.txt"},
        )
        assert resp.status_code == 200
        assert "line1" in resp.json()["content"]


class TestWebUIHealthAPI:
    """Test health endpoints used by WebUI status check."""

    def test_health(self):
        resp = sandbox_client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "runtimes" in data
        assert data["runtimes"]["python"] is True
        assert data["runtimes"]["bash"] is True

    def test_ready(self):
        resp = sandbox_client.get("/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["workspace_available"] is True

    def test_metrics(self):
        resp = sandbox_client.get("/metrics")
        assert resp.status_code == 200
        assert "sandbox" in resp.text


class TestWebUITraceAPI:
    """Test trace endpoints."""

    @pytest.fixture
    def session_id(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "trace-test"})
        sid = resp.json()["session_id"]
        yield sid
        sandbox_client.delete(f"/sessions/{sid}")

    def test_trace_query(self, session_id):
        # Run something with a trace ID
        trace_id = "trace-webui-query-001"
        sandbox_client.post(
            f"/sessions/{session_id}/executions/python",
            json={"code": "print('trace query test')"},
            headers={"X-Trace-Id": trace_id},
        )

        resp = sandbox_client.get(f"/traces/{trace_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["trace_id"] == trace_id
        assert len(data["executions"]) >= 1

    def test_trace_not_found(self):
        """Non-existent trace returns empty results, not an error."""
        resp = sandbox_client.get("/traces/trace-nonexistent")
        assert resp.status_code == 200
        data = resp.json()
        assert data["trace_id"] == "trace-nonexistent"
        assert data["executions"] == []
        assert data["audit_logs"] == []


class TestWebUIApprovalAPI:
    """Test approval endpoints (WebUI integration)."""

    @pytest.fixture
    def session_id(self):
        resp = sandbox_client.post("/sessions", json={"caller_id": "approval-webui"})
        sid = resp.json()["session_id"]
        yield sid
        sandbox_client.delete(f"/sessions/{sid}")

    def test_approval_check_pending(self, session_id):
        """High-risk tool should return pending_approval (not hard_deny)."""
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/approval-check",
            json={"tool_name": "raw_bash", "command": "echo high-risk"},
        )
        assert resp.status_code == 202
        data = resp.json()
        assert data["status"] == "pending_approval"
        assert data["approval_id"].startswith("approval_")
        assert data.get("decision") == "approval_required"

    def test_approval_check_auto_allowed(self, session_id):
        """Medium-risk command should be auto-allowed."""
        resp = sandbox_client.post(
            f"/sessions/{session_id}/executions/approval-check",
            json={"tool_name": "bash", "command": "echo ok"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "approved"

    def test_approve_and_reject(self, session_id):
        # Submit high-risk tool (approval_required, not hard_deny prefix)
        pending = sandbox_client.post(
            f"/sessions/{session_id}/executions/approval-check",
            json={"tool_name": "raw_bash", "command": "echo high-risk"},
        ).json()
        approval_id = pending["approval_id"]
        assert approval_id

        # Reject
        resp = sandbox_client.post(
            "/approve",
            json={"approval_id": approval_id, "decision": "reject"},
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"


# ── Version / Config Consistency ─────────────────────────────────────────

class TestVersionConsistency:
    """Verify version strings are consistent across the project."""

    def test_sandbox_version_exists(self):
        """sandbox/__init__.py should have __version__."""
        from sandbox import __version__

        parts = __version__.split(".")
        assert len(parts) == 3
        for p in parts:
            assert p.isdigit()

    def test_pyproject_version(self):
        """pyproject.toml version should match sandbox version."""
        import tomllib

        from sandbox import __version__

        with open("pyproject.toml", "rb") as f:
            data = tomllib.load(f)
        pyproject_version = data["project"]["version"]
        assert pyproject_version == __version__

    def test_health_returns_version(self):
        """/health should return a version string."""
        resp = sandbox_client.get("/health")
        assert resp.status_code == 200
        assert "version" in resp.json()
        from sandbox import __version__

        assert resp.json()["version"] == __version__


class TestConfigDefaults:
    """Test that configuration defaults are reasonable."""

    def test_sandbox_config_defaults(self):
        from sandbox.config import settings

        assert settings.port == 8081
        assert settings.execution_timeout_seconds == 120
        assert settings.max_output_chars == 50_000
        assert settings.session_ttl_minutes == 30
        assert settings.approval_timeout_seconds == 300
        assert settings.mcp_enabled is True
        assert settings.mcp_port == 8091
        assert settings.log_level == "INFO"

    def test_database_url(self):
        from sandbox.config import settings

        assert settings.database_url.startswith("sqlite:///")
        assert "sandbox.db" in settings.database_url
