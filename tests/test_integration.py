"""Integration tests — end-to-end Sandbox Service via TestClient."""

import pytest
from fastapi.testclient import TestClient

from sandbox.main import app
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager


@pytest.fixture(autouse=True)
def cleanup():
    yield
    # Reset state between tests
    for session in session_manager.list_active():
        session_manager.delete(session.session_id)
        workspace_manager.remove_workspace(session.session_id)


client = TestClient(app)


class TestSessionIntegration:
    def test_create_session(self):
        resp = client.post("/sessions", json={"caller_id": "test"})
        assert resp.status_code == 201
        data = resp.json()
        assert data["session_id"].startswith("sandbox_")
        assert data["status"] == "RUNNING"

    def test_get_session(self):
        created = client.post("/sessions", json={}).json()
        sid = created["session_id"]

        resp = client.get(f"/sessions/{sid}")
        assert resp.status_code == 200
        assert resp.json()["session_id"] == sid

    def test_get_nonexistent_session(self):
        resp = client.get("/sessions/nonexistent")
        assert resp.status_code == 404

    def test_delete_session(self):
        created = client.post("/sessions", json={}).json()
        sid = created["session_id"]

        resp = client.delete(f"/sessions/{sid}")
        assert resp.status_code == 204

    def test_create_session_with_metadata(self):
        resp = client.post("/sessions", json={
            "agent_session_id": "pi_001",
            "user_id": "user_abc",
            "caller_id": "pi-agent",
            "metadata": {"env": "prod"},
        })
        assert resp.status_code == 201
        data = resp.json()
        assert data["agent_session_id"] == "pi_001"
        assert data["user_id"] == "user_abc"


class TestExecutionIntegration:
    def test_run_python(self):
        session = client.post("/sessions", json={}).json()
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
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/executions/python",
            json={"code": 'raise RuntimeError("oops")'},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["status"] == "FAILED"

    def test_run_command(self):
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]

        resp = client.post(
            f"/sessions/{sid}/executions/command",
            json={"command": "echo 'command works'"},
        )
        assert resp.status_code == 201
        data = resp.json()
        assert "command works" in data.get("stdout_preview", "")

    def test_run_on_inactive_session(self):
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]
        client.delete(f"/sessions/{sid}")

        resp = client.post(
            f"/sessions/{sid}/executions/python",
            json={"code": "print('x')"},
        )
        assert resp.status_code in (404, 400)


class TestFileIntegration:
    def test_write_and_read(self):
        session = client.post("/sessions", json={}).json()
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
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]

        client.post(f"/sessions/{sid}/files/write",
                     json={"path": "a.txt", "content": "a"})
        client.post(f"/sessions/{sid}/files/write",
                     json={"path": "b.txt", "content": "b"})

        resp = client.get(f"/sessions/{sid}/files")
        assert resp.status_code == 200
        assert resp.json()["total"] >= 2

    def test_path_escape_blocked(self):
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]

        resp = client.get(
            f"/sessions/{sid}/files/read",
            params={"path": "../etc/passwd"},
        )
        assert resp.status_code == 403


class TestArtifactIntegration:
    def test_register_and_list(self):
        session = client.post("/sessions", json={}).json()
        sid = session["session_id"]
        ws = session["workspace_path"]

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


class TestHealthIntegration:
    def test_health_endpoint(self):
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert "runtimes" in data

    def test_ready_endpoint(self):
        resp = client.get("/ready")
        assert resp.status_code == 200

    def test_metrics_endpoint(self):
        resp = client.get("/metrics")
        assert resp.status_code == 200

    def test_root_endpoint(self):
        resp = client.get("/")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/html") or "enterprise-sandbox" in resp.text
