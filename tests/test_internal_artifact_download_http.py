"""Signed owner-scoped HTTP tests for internal Artifact byte delivery."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.config import Settings
from sandbox.routers import internal_artifacts
from sandbox.security.internal_http_auth import (
    INTERNAL_AUTH_HTTP_DETAIL,
    INTERNAL_TOKEN_AUDIENCE,
    INTERNAL_TOKEN_ISSUER,
    INTERNAL_TOKEN_SUBJECT,
    set_replay_store,
)
from sandbox.security.replay_store import InMemoryReplayStore
from sandbox.services.artifact_manager import ArtifactManager
from sandbox.services.artifact_store import (
    FakeFormalArtifactRepository,
    FormalArtifactDualWriter,
)

NOW = 2_000_000_000
KEY = b"artifact-download-test-key-material"
KEY_B64 = base64.urlsafe_b64encode(KEY).decode("ascii").rstrip("=")
KID = "artifact-key-1"
PATH_HTTP = "/internal/v1/artifacts/download"

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
OTHER_USER = "01K0G2PAV8FPMVC9QHJG7JPN60"
CONVERSATION = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SANDBOX_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN54"
TRACE = "0123456789abcdef0123456789abcdef"
FENCE = 7
CONTENT = b"immutable-owner-scoped-artifact"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _identity(*, user_id: str = USER) -> dict[str, Any]:
    return {
        "orgId": ORG,
        "userId": user_id,
        "conversationId": CONVERSATION,
        "agentSessionId": AGENT_SESSION,
        "runId": RUN,
        "sandboxSessionId": SANDBOX_SESSION,
        "traceId": TRACE,
        "executionFenceToken": FENCE,
    }


def _body(
    artifact_id: str,
    *,
    user_id: str = USER,
    extra: dict[str, Any] | None = None,
) -> bytes:
    value: dict[str, Any] = {
        "artifactId": artifact_id,
        "identity": _identity(user_id=user_id),
    }
    if extra:
        value.update(extra)
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


def _token(
    artifact_id: str,
    body: bytes,
    *,
    user_id: str = USER,
    jti: str,
) -> str:
    operation_id = f"{artifact_id}:artifact.download"
    request_hash = hashlib.sha256(body).hexdigest()
    claims = {
        "token_version": 1,
        "iss": INTERNAL_TOKEN_ISSUER,
        "aud": INTERNAL_TOKEN_AUDIENCE,
        "sub": INTERNAL_TOKEN_SUBJECT,
        "org_id": ORG,
        "user_id": user_id,
        "conversation_id": CONVERSATION,
        "agent_session_id": AGENT_SESSION,
        "sandbox_session_id": SANDBOX_SESSION,
        "run_id": RUN,
        "tool_execution_id": operation_id,
        "tool_call_id": operation_id,
        "tool_name": "artifact.download",
        "scope": ["sandbox.artifacts.download"],
        "request_hash": request_hash,
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
        "htm": "POST",
        "htu": PATH_HTTP,
        "body_sha256": request_hash,
        "iat": NOW,
        "nbf": NOW,
        "exp": NOW + 60,
        "jti": jti,
    }
    header = {"alg": "HS256", "kid": KID, "typ": "sandbox-internal+jwt"}
    header_segment = _b64(json.dumps(header, separators=(",", ":")).encode())
    payload_segment = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    signature = _b64(hmac.new(KEY, signing_input, hashlib.sha256).digest())
    return f"{header_segment}.{payload_segment}.{signature}"


@pytest.fixture
def keyed_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    settings = Settings(
        database_url="sqlite:////tmp/internal-artifact-download-http.db",
        allowed_client_cidrs=["127.0.0.1/32"],
        internal_hmac_keyring=json.dumps({KID: KEY_B64}, separators=(",", ":")),
        internal_hmac_active_kid=KID,
        internal_token_leeway_seconds=0,
        api_token="",
        auth_enabled=False,
    )
    monkeypatch.setattr("sandbox.config.settings", settings)
    monkeypatch.setattr("sandbox.security.internal_http_auth.settings", settings)
    return settings


@pytest.fixture
def download_case(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    keyed_settings: Settings,
) -> tuple[FastAPI, Any]:
    _ = keyed_settings
    manager = ArtifactManager(
        formal=FormalArtifactDualWriter(
            FakeFormalArtifactRepository(),
            authoritative=True,
        ),
        auto_wire_formal=False,
    )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "report.bin").write_bytes(CONTENT)
    artifact = manager.submit(
        session_id=SANDBOX_SESSION,
        path="report.bin",
        name="report.bin",
        mime_type="application/octet-stream",
        physical_workspace=workspace,
        org_id=ORG,
        user_id=USER,
        conversation_id=CONVERSATION,
        agent_session_id=AGENT_SESSION,
        run_id=RUN,
    )
    monkeypatch.setattr(internal_artifacts, "artifact_manager", manager)
    monkeypatch.setattr(
        "sandbox.security.internal_http_auth.time.time",
        lambda: NOW,
    )
    app = FastAPI()
    set_replay_store(app, InMemoryReplayStore())
    app.include_router(internal_artifacts.router)
    return app, artifact


def _post(client: TestClient, body: bytes, token: str):
    return client.post(
        PATH_HTTP,
        content=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )


def test_download_streams_snapshot_bytes_and_bound_headers(download_case) -> None:
    app, artifact = download_case
    body = _body(artifact.artifact_id)
    token = _token(artifact.artifact_id, body, jti="artifact-download-ok")

    with TestClient(app) as client:
        response = _post(client, body, token)

    assert response.status_code == 200, response.text
    assert response.content == CONTENT
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-length"] == str(len(CONTENT))
    assert response.headers["x-artifact-id"] == artifact.artifact_id
    assert response.headers["x-artifact-sha256"] == hashlib.sha256(
        CONTENT
    ).hexdigest()
    assert "report.bin" in response.headers["content-disposition"]
    assert response.headers["x-content-type-options"] == "nosniff"


def test_download_is_owner_scoped_and_never_accepts_a_path(download_case) -> None:
    app, artifact = download_case
    foreign_body = _body(artifact.artifact_id, user_id=OTHER_USER)
    foreign_token = _token(
        artifact.artifact_id,
        foreign_body,
        user_id=OTHER_USER,
        jti="artifact-download-foreign",
    )
    path_body = _body(
        artifact.artifact_id,
        extra={"relativePath": "/home/sandbox/workspace/report.bin"},
    )
    path_token = _token(
        artifact.artifact_id,
        path_body,
        jti="artifact-download-path",
    )

    with TestClient(app) as client:
        foreign = _post(client, foreign_body, foreign_token)
        path_attempt = _post(client, path_body, path_token)

    assert foreign.status_code == 404
    assert foreign.json() == {"detail": "Not found"}
    assert path_attempt.status_code == 400
    assert path_attempt.json() == {"detail": "Invalid request"}
    assert "/home/sandbox" not in path_attempt.text


def test_download_token_is_single_use_and_body_bound(download_case) -> None:
    app, artifact = download_case
    body = _body(artifact.artifact_id)
    token = _token(artifact.artifact_id, body, jti="artifact-download-replay")
    tampered_body = _body(
        "01K0G2PAV8FPMVC9QHJG7JPN70",
    )
    tampered_token = _token(
        artifact.artifact_id,
        body,
        jti="artifact-download-tampered",
    )

    with TestClient(app) as client:
        first = _post(client, body, token)
        replay = _post(client, body, token)
        tampered = _post(client, tampered_body, tampered_token)

    assert first.status_code == 200
    assert replay.status_code == 401
    assert replay.json() == {"detail": INTERNAL_AUTH_HTTP_DETAIL}
    assert tampered.status_code == 401
    assert tampered.json() == {"detail": INTERNAL_AUTH_HTTP_DETAIL}
