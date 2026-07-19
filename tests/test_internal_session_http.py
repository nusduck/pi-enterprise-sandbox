"""End-to-end HTTP binding for internal SandboxSession provisioning."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.config import Settings
from sandbox.routers.internal_sessions import router
from sandbox.security.internal_http_auth import set_replay_store
from sandbox.security.replay_store import InMemoryReplayStore
from sandbox.services.formal_session_runtime import set_formal_session_runtime

NOW = 2_000_000_000
KEY = b"s" * 32
KID = "session-key"
ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN51"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN52"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN53"
SANDBOX = "01K0G2PAV8FPMVC9QHJG7JPN54"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN55"
WORKSPACE = "01K0G2PAV8FPMVC9QHJG7JPN56"
PATH = "/internal/v1/sessions/ensure"
BODY = json.dumps({"workspaceId": WORKSPACE}, separators=(",", ":")).encode()


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _token() -> str:
    header = {"alg": "HS256", "kid": KID, "typ": "sandbox-internal+jwt"}
    claims: dict[str, Any] = {
        "token_version": 1,
        "iss": "agent-service",
        "aud": "sandbox-service",
        "sub": "agent-worker",
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "sandbox_session_id": SANDBOX,
        "run_id": None,
        "tool_execution_id": f"{AGENT}:session.ensure",
        "tool_call_id": f"{AGENT}:session.ensure",
        "tool_name": "session.ensure",
        "scope": ["sandbox.sessions.ensure"],
        "request_hash": hashlib.sha256(BODY).hexdigest(),
        "request_hash_version": 1,
        "execution_fence_token": None,
        "trace_id": "0123456789abcdef0123456789abcdef",
        "htm": "POST",
        "htu": PATH,
        "body_sha256": hashlib.sha256(BODY).hexdigest(),
        "iat": NOW,
        "nbf": NOW,
        "exp": NOW + 60,
        "jti": _b64(b"j" * 16),
    }
    head = _b64(json.dumps(header, separators=(",", ":")).encode())
    payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signing = f"{head}.{payload}".encode("ascii")
    return f"{head}.{payload}.{_b64(hmac.new(KEY, signing, hashlib.sha256).digest())}"


def test_internal_session_route_authenticates_and_passes_exact_binding(
    monkeypatch,
) -> None:
    keyring = json.dumps({KID: _b64(KEY)}, separators=(",", ":"))
    settings = Settings(
        database_url="sqlite:////tmp/internal-session-http.db",
        internal_hmac_keyring=keyring,
        internal_hmac_active_kid=KID,
        internal_token_leeway_seconds=0,
        allowed_client_cidrs=["127.0.0.1/32"],
    )
    monkeypatch.setattr("sandbox.security.internal_http_auth.settings", settings)
    monkeypatch.setattr("sandbox.security.internal_http_auth.time.time", lambda: NOW)

    calls: list[tuple[dict[str, Any], str]] = []

    class Runtime:
        def ensure(self, *, claims, workspace_id):
            calls.append((dict(claims), workspace_id))
            return SimpleNamespace(
                sandbox_session_id=SANDBOX,
                agent_session_id=AGENT,
                workspace_id=WORKSPACE,
                status="ACTIVE",
            )

    app = FastAPI()
    set_replay_store(app, InMemoryReplayStore())
    set_formal_session_runtime(app, Runtime())  # type: ignore[arg-type]
    app.include_router(router)

    response = TestClient(app).post(
        PATH,
        content=BODY,
        headers={
            "Authorization": f"Bearer {_token()}",
            "Content-Type": "application/json",
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["workspaceId"] == WORKSPACE
    assert len(calls) == 1
    assert calls[0][0]["sandbox_session_id"] == SANDBOX
    assert calls[0][0]["run_id"] is None
    assert calls[0][0]["execution_fence_token"] is None
    assert calls[0][1] == WORKSPACE
