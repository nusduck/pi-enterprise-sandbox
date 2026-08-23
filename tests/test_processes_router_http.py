"""HTTP-level tests for the session-scoped managed-process control routes.

Public plane (service token + X-Acting-* headers), the same auth as the other
session-owned routes — not the internal HMAC plane, which only the model's
claimed ToolExecutions can use. These routes are what the BFF calls when a
person watching a long process in the browser asks for its output or stops it.

Regression they exist for: Agent called a `/processes/{id}/...` surface Sandbox
no longer serves, so every logs/read/signal/stdin/cancel came back 404 while
list and status worked.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.config import Settings
from sandbox.routers.session_processes import router
from sandbox.services.formal_session_runtime import (
    FormalPublicSession,
    set_formal_session_runtime,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN60"
USER = "01K0G2PAV8FPMVC9QHJG7JPN61"
SESSION = "01K0G2PAV8FPMVC9QHJG7JPN62"
OTHER_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN63"
PROCESS = "01K0G2PAV8FPMVC9QHJG7JPN64"
API_TOKEN = "processes-router-test-secret"  # noqa: S105 — test fixture only


class _StubSessionRuntime:
    """Owns exactly one session, for exactly one tenant."""

    def resolve_owned(self, session_id, *, org_id, user_id):
        if session_id != SESSION or org_id != ORG or user_id != USER:
            return None
        return FormalPublicSession(
            session_id=SESSION,
            user_id=USER,
            agent_session_id="01K0G2PAV8FPMVC9QHJG7JPN65",
            workspace_id="01K0G2PAV8FPMVC9QHJG7JPN66",
            status="active",
            created_at="2026-08-01T00:00:00Z",
            updated_at="2026-08-01T00:00:00Z",
            metadata={"organization_id": ORG},
        )


class _StubProcessManager:
    def __init__(self, *, owned: bool = True, live: bool = True) -> None:
        self.calls: list[tuple] = []
        self._owned = owned
        self._live = live

    def _entry(self):
        return {"process_id": PROCESS, "status": "running", "session_id": SESSION}

    def get_owned(self, process_id, *, org_id, user_id, sandbox_session_id):
        self.calls.append(("get", process_id, org_id, user_id, sandbox_session_id))
        return self._entry() if self._owned else None

    def logs_owned(self, process_id, *, offset, limit, **owner):
        self.calls.append(("logs", process_id, offset, limit, owner))
        if not self._owned:
            return None
        return {"stdout": "TICK_1\n", "stderr": "", "next_offset": 7, "completed": False}

    def read_stream_owned(self, process_id, *, stream, cursor, limit, **owner):
        self.calls.append(("read", process_id, stream, cursor, limit, owner))
        if not self._owned:
            return None
        return {"process_id": process_id, "stream": stream, "next_cursor": "0-7"}

    def signal_process_owned(self, process_id, sig, **owner):
        self.calls.append(("signal", process_id, sig, owner))
        if not self._owned:
            return {"error": "not found", "status": "not_found", "ok": False}
        if not self._live:
            return {"status": "unavailable", "ok": False}
        return {"ok": True, "signaled": True, "status": "running"}

    def write_stdin_owned(self, process_id, data, *, eof, **owner):
        self.calls.append(("stdin", process_id, data, eof, owner))
        if not self._owned:
            return {"error": "not found", "status": "not_found", "ok": False}
        return {"ok": True, "status": "running"}

    def cancel_owned(self, process_id, **owner):
        self.calls.append(("cancel", process_id, owner))
        if not self._owned:
            return {"error": "not found", "status": "not_found", "ok": False}
        return {"ok": True, "cancelled": True, "status": "cancel_requested"}


def _client(monkeypatch, manager) -> TestClient:
    settings = Settings(
        database_url="sqlite:////tmp/processes-router-http.db",
        auth_enabled=True,
        api_token=API_TOKEN,
    )
    monkeypatch.setattr("sandbox.security.ownership.settings", settings)
    monkeypatch.setattr("sandbox.routers.session_processes.process_manager", manager)
    app = FastAPI()
    set_formal_session_runtime(app, _StubSessionRuntime())  # type: ignore[arg-type]
    app.include_router(router)
    return TestClient(app)


def _headers(user: str = USER, org: str = ORG) -> dict[str, str]:
    return {
        "X-API-Key": API_TOKEN,
        "X-Acting-User-Id": user,
        "X-Acting-Organization-Id": org,
    }


def _url(suffix: str = "", session: str = SESSION) -> str:
    return f"/sessions/{session}/processes/{PROCESS}{suffix}"


def test_logs_read_and_control_reach_the_owner_scoped_manager(monkeypatch) -> None:
    manager = _StubProcessManager()
    client = _client(monkeypatch, manager)

    logs = client.get(_url("/logs"), params={"offset": 7}, headers=_headers())
    assert logs.status_code == 200, logs.text
    assert logs.json()["stdout"] == "TICK_1\n"
    assert logs.json()["process_id"] == PROCESS

    read = client.get(
        _url("/read"),
        params={"stream": "stderr", "cursor": "0-3", "limit": 64},
        headers=_headers(),
    )
    assert read.status_code == 200, read.text
    assert read.json()["stream"] == "stderr"

    signal = client.post(_url("/signal"), json={"signal": "sigkill"}, headers=_headers())
    assert signal.status_code == 200, signal.text
    assert signal.json()["signaled"] is True

    stdin = client.post(_url("/stdin"), json={"data": "y\n"}, headers=_headers())
    assert stdin.status_code == 200, stdin.text

    cancel = client.post(_url("/cancel"), headers=_headers())
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["cancelled"] is True

    owner = {"org_id": ORG, "user_id": USER, "sandbox_session_id": SESSION}
    assert manager.calls[0] == ("logs", PROCESS, 7, None, owner)
    assert manager.calls[2][1:4] == (PROCESS, "SIGKILL", owner)
    assert manager.calls[3][1:3] == (PROCESS, "y\n")


def test_another_tenant_sees_only_a_404(monkeypatch) -> None:
    manager = _StubProcessManager()
    client = _client(monkeypatch, manager)

    foreign = client.get(_url("/logs"), headers=_headers(user="01K0G2PAV8FPMVC9QHJG7JPN67"))
    assert foreign.status_code == 404
    other_session = client.post(_url("/cancel", session=OTHER_SESSION), headers=_headers())
    assert other_session.status_code == 404
    assert manager.calls == [], "ownership is settled before the manager is touched"


def test_a_process_outside_the_session_is_a_404(monkeypatch) -> None:
    manager = _StubProcessManager(owned=False)
    client = _client(monkeypatch, manager)

    assert client.get(_url(), headers=_headers()).status_code == 404
    assert client.get(_url("/logs"), headers=_headers()).status_code == 404
    assert client.get(_url("/read"), headers=_headers()).status_code == 404
    assert client.post(_url("/signal"), json={}, headers=_headers()).status_code == 404
    assert client.post(_url("/stdin"), json={"data": ""}, headers=_headers()).status_code == 404
    assert client.post(_url("/cancel"), headers=_headers()).status_code == 404


def test_control_after_a_restart_is_a_conflict_not_a_404(monkeypatch) -> None:
    # The row outlived the live handle: the process is observable and can never
    # be controlled again. Saying "not found" would be a lie about ownership.
    manager = _StubProcessManager(live=False)
    client = _client(monkeypatch, manager)

    resp = client.post(_url("/signal"), json={"signal": "SIGTERM"}, headers=_headers())
    assert resp.status_code == 409, resp.text


def test_invalid_control_arguments_are_client_errors(monkeypatch) -> None:
    manager = _StubProcessManager()
    client = _client(monkeypatch, manager)

    assert client.post(_url("/signal"), json={"signal": "SIGSTOP"}, headers=_headers()).status_code == 400
    assert client.get(_url("/read"), params={"stream": "both"}, headers=_headers()).status_code == 400
    assert client.get(_url("/read"), params={"limit": 0}, headers=_headers()).status_code == 400
    assert client.get(_url("/logs"), params={"offset": -1}, headers=_headers()).status_code == 400
    assert manager.calls == []


def test_routes_require_an_actor(monkeypatch) -> None:
    manager = _StubProcessManager()
    client = _client(monkeypatch, manager)

    assert client.get(_url("/logs")).status_code == 401
    assert client.post(_url("/cancel")).status_code == 401
