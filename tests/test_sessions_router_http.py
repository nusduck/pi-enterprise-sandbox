"""HTTP-level tests for DELETE /sessions/{session_id} (workspace GC endpoint).

Public plane (Actor auth via service token + X-Acting-* headers), not the
internal HMAC plane — mirrors how Agent's conversation-delete cleanup call
(D2 triage: conversation delete triggers Sandbox workspace GC) is expected
to authenticate. The router is a thin adapter; FormalSessionRuntime.remove_owned
itself is covered in tests/test_formal_session_runtime.py.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.config import Settings
from sandbox.routers.session_workspace import router
from sandbox.services.formal_session_runtime import (
    SessionProvisioningError,
    set_formal_session_runtime,
)
from sandbox.services.workspace_manager import WorkspaceCleanupError

ORG = "01K0G2PAV8FPMVC9QHJG7JPN60"
USER = "01K0G2PAV8FPMVC9QHJG7JPN61"
SESSION = "01K0G2PAV8FPMVC9QHJG7JPN62"
API_TOKEN = "sessions-router-test-secret"  # noqa: S105 — test fixture only


class _StubRuntime:
    def __init__(self, *, result: bool = True, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self._result = result
        self._error = error

    def remove_owned(self, session_id: str, *, org_id: str, user_id: str) -> bool:
        self.calls.append((session_id, org_id, user_id))
        if self._error is not None:
            raise self._error
        return self._result


def _client(monkeypatch, runtime) -> TestClient:
    settings = Settings(
        database_url="sqlite:////tmp/sessions-router-http.db",
        auth_enabled=True,
        api_token=API_TOKEN,
    )
    monkeypatch.setattr("sandbox.security.ownership.settings", settings)
    app = FastAPI()
    set_formal_session_runtime(app, runtime)  # type: ignore[arg-type]
    app.include_router(router)
    return TestClient(app)


def _acting_headers() -> dict[str, str]:
    return {
        "X-API-Key": API_TOKEN,
        "X-Acting-User-Id": USER,
        "X-Acting-Organization-Id": ORG,
    }


def test_delete_session_removes_owned_workspace(monkeypatch) -> None:
    runtime = _StubRuntime(result=True)
    client = _client(monkeypatch, runtime)

    resp = client.delete(f"/sessions/{SESSION}", headers=_acting_headers())

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sessionId": SESSION, "removed": True}
    assert runtime.calls == [(SESSION, ORG, USER)]


def test_delete_session_is_idempotent_when_already_removed(monkeypatch) -> None:
    runtime = _StubRuntime(result=False)
    client = _client(monkeypatch, runtime)

    resp = client.delete(f"/sessions/{SESSION}", headers=_acting_headers())

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"sessionId": SESSION, "removed": False}


def test_delete_session_requires_actor_auth(monkeypatch) -> None:
    runtime = _StubRuntime()
    client = _client(monkeypatch, runtime)

    resp = client.delete(f"/sessions/{SESSION}")

    assert resp.status_code == 401
    assert runtime.calls == []


def test_delete_session_surfaces_workspace_cleanup_failure_as_503(monkeypatch) -> None:
    runtime = _StubRuntime(error=WorkspaceCleanupError("rmtree failed"))
    client = _client(monkeypatch, runtime)

    resp = client.delete(f"/sessions/{SESSION}", headers=_acting_headers())

    assert resp.status_code == 503


def test_delete_session_surfaces_provisioning_error_status(monkeypatch) -> None:
    runtime = _StubRuntime(
        error=SessionProvisioningError(
            "SESSION_PERSISTENCE_FAILED", "Session persistence unavailable", status=503
        )
    )
    client = _client(monkeypatch, runtime)

    resp = client.delete(f"/sessions/{SESSION}", headers=_acting_headers())

    assert resp.status_code == 503


def test_delete_session_503_when_runtime_unset(monkeypatch) -> None:
    settings = Settings(
        database_url="sqlite:////tmp/sessions-router-http.db",
        auth_enabled=True,
        api_token=API_TOKEN,
    )
    monkeypatch.setattr("sandbox.security.ownership.settings", settings)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)

    resp = client.delete(f"/sessions/{SESSION}", headers=_acting_headers())

    assert resp.status_code == 503
