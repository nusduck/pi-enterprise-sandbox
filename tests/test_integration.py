"""Integration tests — end-to-end Sandbox Service via TestClient."""

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.main import app
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager
from tests.conftest import session_create_payload


@pytest.fixture(autouse=True)
def hermetic_auth(monkeypatch):
    """Do not silently rely on host SANDBOX_AUTH_ENABLED / API token."""
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")


@pytest.fixture(autouse=True)
def cleanup():
    yield
    # Reset state between tests
    for session in session_manager.list_active():
        wid = session.workspace_id or (session.metadata or {}).get("workspace_id")
        session_manager.delete(session.session_id)
        if wid:
            workspace_manager.remove_workspace(wid)


client = TestClient(app)


class TestSessionIntegration:
    def test_create_session(self):
        resp = client.post("/sessions", json=session_create_payload("test"))
        assert resp.status_code == 201
        data = resp.json()
        assert data["session_id"].startswith("sandbox_")
        assert data["status"] == "RUNNING"

    def test_get_session(self):
        created = client.post("/sessions", json=session_create_payload()).json()
        sid = created["session_id"]

        resp = client.get(f"/sessions/{sid}")
        assert resp.status_code == 200
        assert resp.json()["session_id"] == sid

    def test_get_nonexistent_session(self):
        resp = client.get("/sessions/nonexistent")
        assert resp.status_code == 404

    def test_delete_session(self):
        created = client.post("/sessions", json=session_create_payload()).json()
        sid = created["session_id"]

        resp = client.delete(f"/sessions/{sid}")
        assert resp.status_code == 204

    def test_create_session_with_metadata(self):
        agent = "01JTESTAGENT00000000000001"
        wsp = "01JTESTWRKSP00000000000001"
        resp = client.post("/sessions", json={
            "agent_session_id": agent,
            "workspace_id": wsp,
            "enterprise_session_id": "ent_001",
            "user_id": "user_abc",
            "caller_id": "pi-agent",
            "metadata": {"env": "prod"},
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["agent_session_id"] == agent
        assert data["workspace_id"] == wsp
        assert data["enterprise_session_id"] == "ent_001"
        assert data["user_id"] == "user_abc"

    def test_get_session_by_external_ids(self):
        agent = "01JTESTAGENT00000000000002"
        wsp = "01JTESTWRKSP00000000000002"
        created = client.post("/sessions", json={
            "agent_session_id": agent,
            "workspace_id": wsp,
            "enterprise_session_id": "ent_lookup_001",
            "caller_id": "pi-agent",
        }).json()

        by_agent = client.get(f"/sessions/by-agent/{agent}")
        by_enterprise = client.get("/sessions/by-enterprise/ent_lookup_001")

        assert by_agent.status_code == 200
        assert by_agent.json()["session_id"] == created["session_id"]
        assert by_enterprise.status_code == 200
        assert by_enterprise.json()["session_id"] == created["session_id"]


class TestExecutionIntegration:
    def test_run_python(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/executions/python",
            json={"code": 'print("hello from sandbox")'},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["execution_id"].startswith("exec_")
        assert "stdout_preview" in data

    def test_run_python_with_error(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/executions/python",
            json={"code": 'raise RuntimeError("oops")'},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "FAILED"

    def test_run_command(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/executions/command",
            json={"command": "echo 'command works'"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "command works" in data.get("stdout_preview", "")

    def test_run_on_inactive_session(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]
        client.delete(f"/sessions/{sid}")

        resp = client.post(
            f"/sessions/{sid}/executions/python",
            json={"code": "print('x')"},
        )
        assert resp.status_code in (404, 400)


class TestFileIntegration:
    def test_write_and_read(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/files/write",
            json={"path": "test.txt", "content": "hello"},
        )
        assert resp.status_code == 201

        resp = client.get(
            f"/sessions/{sid}/files/read",
            params={"path": "test.txt"},
        )
        assert resp.status_code == 200
        assert resp.json()["content"] == "hello"

    def test_list_files(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        client.post(f"/sessions/{sid}/files/write",
                     json={"path": "a.txt", "content": "a"})
        client.post(f"/sessions/{sid}/files/write",
                     json={"path": "b.txt", "content": "b"})

        resp = client.get(f"/sessions/{sid}/files")
        assert resp.status_code == 200
        assert resp.json()["total"] >= 2

    def test_path_escape_blocked(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        resp = client.get(
            f"/sessions/{sid}/files/read",
            params={"path": "../etc/passwd"},
        )
        assert resp.status_code == 403


class TestArtifactIntegration:
    def test_register_and_list(self):
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        # Create a file first, then register it as artifact
        client.post(f"/sessions/{sid}/files/write",
                     json={"path": "output/report.txt", "content": "report data"})

        resp = client.post(
            f"/sessions/{sid}/artifacts/register",
            json={
                "name": "report.txt",
                "path": "output/report.txt",
                "mime_type": "text/plain",
            },
        )
        assert resp.status_code == 201
        art_id = resp.json()["artifact_id"]
        assert art_id.startswith("art_")

        resp = client.get(f"/sessions/{sid}/artifacts")
        assert resp.status_code == 200
        assert resp.json()["total"] == 1

    def test_submit_artifact(self):
        """Explicit artifact submission via POST /artifacts/submit."""
        session = client.post("/sessions", json=session_create_payload()).json()
        sid = session["session_id"]

        # Create a file via bash
        client.post(
            f"/sessions/{sid}/executions/command",
            json={"command": "echo 'chart data' > chart.png"},
        )

        # Explicitly submit as artifact
        resp = client.post(
            f"/sessions/{sid}/artifacts/submit",
            json={
                "name": "chart.png",
                "path": "chart.png",
                "mime_type": "image/png",
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["artifact_id"].startswith("art_")
        assert data["name"] == "chart.png"
        assert data["path"] == "chart.png"
        assert data["size"] > 0

        # List should include it
        resp = client.get(f"/sessions/{sid}/artifacts")
        assert resp.status_code == 200
        assert resp.json()["total"] >= 1
        assert any(a["path"] == "chart.png" for a in resp.json()["artifacts"])


class TestHealthIntegration:
    def test_health_endpoint(self):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert "runtimes" in data
        # Liveness must not leak secrets / env dumps
        body = resp.text.lower()
        assert "api_key" not in body
        assert "password" not in body
        assert "sqlite:///" not in body

    def test_ready_endpoint(self):
        resp = client.get("/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert data["workspace_available"] is True
        # Readiness must not leak secrets / connection strings
        body = resp.text.lower()
        assert "api_key" not in body
        assert "password" not in body
        assert "sqlite:///" not in body

    def test_ready_returns_503_when_workspace_unwritable(self, monkeypatch):
        """Workspace dependency failure → 503 not_ready (not a silent 200)."""
        from sandbox.routers import health as health_router

        monkeypatch.setattr(health_router, "_workspace_ready", lambda: (False, 0.0))
        monkeypatch.setattr(health_router, "_database_ready", lambda: True)

        resp = client.get("/ready")
        assert resp.status_code == 503
        data = resp.json()
        assert data["status"] == "not_ready"
        assert data["workspace_available"] is False

    def test_ready_returns_503_when_database_unavailable(self, monkeypatch):
        """Database dependency failure → 503 not_ready."""
        from sandbox.routers import health as health_router

        monkeypatch.setattr(health_router, "_workspace_ready", lambda: (True, 100.0))
        monkeypatch.setattr(health_router, "_database_ready", lambda: False)

        resp = client.get("/ready")
        assert resp.status_code == 503
        assert resp.json()["status"] == "not_ready"

    def test_metrics_endpoint(self):
        resp = client.get("/metrics")
        assert resp.status_code == 200

    def test_root_endpoint(self):
        resp = client.get("/")
        assert resp.status_code == 200
        assert resp.json()["service"] == "enterprise-sandbox"
