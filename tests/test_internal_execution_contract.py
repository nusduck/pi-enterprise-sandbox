"""Focused contract and HTTP wiring tests for formal bash/Python execution."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.app.domain.internal_execution_contract import (
    InternalExecutionContractError,
    parse_and_bind_internal_execution,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.config import Settings
from sandbox.routers.internal_executions import router
from sandbox.security.internal_http_auth import set_replay_store
from sandbox.security.replay_store import InMemoryReplayStore
from sandbox.services.formal_execution_runtime import set_formal_execution_runtime

NOW = 2_000_000_000
KEY = b"e" * 32
KID = "execution-key"
ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN54"
TOOL_EXEC = "01K0G2PAV8FPMVC9QHJG7JPN55"
TOOL_CALL = "tc-execution-1"
TRACE = "0123456789abcdef0123456789abcdef"
FENCE = 7


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _args(tool_name: str) -> dict[str, Any]:
    if tool_name == "bash":
        return {"command": "printf ok", "timeoutSeconds": 12, "env": {"MODE": "test"}}
    return {"code": "print('ok')", "args": ["one"], "timeoutSeconds": 13}


def _body_obj(tool_name: str) -> dict[str, Any]:
    args = _args(tool_name)
    hashed = compute_tool_request_hash_v1(tool_name=tool_name, args=args)
    return {
        "identity": {
            "orgId": ORG,
            "userId": USER,
            "conversationId": CONV,
            "agentSessionId": AGENT,
            "runId": RUN,
            "sandboxSessionId": SBX,
            "traceId": TRACE,
            "executionFenceToken": FENCE,
        },
        "toolExecutionId": TOOL_EXEC,
        "toolCallId": TOOL_CALL,
        "requestHash": hashed["requestHash"],
        "requestHashVersion": 1,
        **args,
    }


def _body(tool_name: str) -> bytes:
    return json.dumps(_body_obj(tool_name), separators=(",", ":")).encode()


def _claims(tool_name: str) -> dict[str, Any]:
    body = _body_obj(tool_name)
    return {
        "scope": [f"sandbox.executions.{tool_name}"],
        "tool_name": tool_name,
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "run_id": RUN,
        "sandbox_session_id": SBX,
        "trace_id": TRACE,
        "execution_fence_token": FENCE,
        "tool_execution_id": TOOL_EXEC,
        "tool_call_id": TOOL_CALL,
        "request_hash": body["requestHash"],
        "request_hash_version": 1,
    }


@pytest.mark.parametrize("tool_name", ["bash", "python"])
def test_parse_binds_every_identity_and_preserves_normalized_args(tool_name: str) -> None:
    command = parse_and_bind_internal_execution(
        _body(tool_name), _claims(tool_name), tool_name=tool_name
    )

    assert command.tool_name == tool_name
    assert command.args == _args(tool_name)
    assert command.org_id == ORG
    assert command.user_id == USER
    assert command.conversation_id == CONV
    assert command.agent_session_id == AGENT
    assert command.run_id == RUN
    assert command.sandbox_session_id == SBX
    assert command.tool_execution_id == TOOL_EXEC
    assert command.tool_call_id == TOOL_CALL
    assert command.execution_fence_token == FENCE


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        (lambda body: body.update(extra=True), "EXECUTION_SCHEMA_INVALID"),
        (
            lambda body: body["identity"].update(executionFenceToken=True),
            "EXECUTION_FIELD_INVALID",
        ),
        (lambda body: body.update(timeoutSeconds=1.5), "EXECUTION_JSON_INVALID"),
        (lambda body: body.update(env={"OPENAI_API_KEY": "secret"}), "EXECUTION_ENV_INVALID"),
        (lambda body: body.update(command="changed"), "EXECUTION_HASH_INVALID"),
    ],
)
def test_bash_contract_fails_closed(mutation, expected_code: str) -> None:
    body = _body_obj("bash")
    mutation(body)

    with pytest.raises(InternalExecutionContractError) as caught:
        parse_and_bind_internal_execution(
            json.dumps(body, separators=(",", ":")).encode(),
            _claims("bash"),
            tool_name="bash",
        )

    assert caught.value.code == expected_code


def test_duplicate_json_key_and_claim_mismatch_fail_closed() -> None:
    duplicate = _body("bash")[:-1] + b',"toolCallId":"duplicate"}'
    with pytest.raises(InternalExecutionContractError) as duplicate_error:
        parse_and_bind_internal_execution(duplicate, _claims("bash"), tool_name="bash")
    assert duplicate_error.value.code == "EXECUTION_JSON_INVALID"

    claims = _claims("bash")
    claims["run_id"] = "01K0G2PAV8FPMVC9QHJG7JPN99"
    with pytest.raises(InternalExecutionContractError) as mismatch_error:
        parse_and_bind_internal_execution(_body("bash"), claims, tool_name="bash")
    assert mismatch_error.value.code == "EXECUTION_CLAIM_MISMATCH"


def _token(tool_name: str, body: bytes, *, jti: bytes = b"j" * 16) -> str:
    path = f"/internal/v1/executions/{tool_name}"
    claims = {
        "token_version": 1,
        "iss": "agent-service",
        "aud": "sandbox-service",
        "sub": "agent-worker",
        **{
            key: value
            for key, value in _claims(tool_name).items()
            if key not in {"scope", "tool_name"}
        },
        "tool_name": tool_name,
        "scope": [f"sandbox.executions.{tool_name}"],
        "htm": "POST",
        "htu": path,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "iat": NOW,
        "nbf": NOW,
        "exp": NOW + 60,
        "jti": _b64(jti),
    }
    header = {"alg": "HS256", "kid": KID, "typ": "sandbox-internal+jwt"}
    head = _b64(json.dumps(header, separators=(",", ":")).encode())
    payload = _b64(json.dumps(claims, separators=(",", ":")).encode())
    signing = f"{head}.{payload}".encode("ascii")
    signature = _b64(hmac.new(KEY, signing, hashlib.sha256).digest())
    return f"{head}.{payload}.{signature}"


@pytest.mark.parametrize("tool_name", ["bash", "python"])
def test_internal_execution_route_authenticates_and_forwards_exact_bytes(
    monkeypatch, tool_name: str
) -> None:
    settings = Settings(
        database_url="sqlite:////tmp/internal-execution-http.db",
        internal_hmac_keyring=json.dumps({KID: _b64(KEY)}, separators=(",", ":")),
        internal_hmac_active_kid=KID,
        internal_token_leeway_seconds=0,
        allowed_client_cidrs=["127.0.0.1/32"],
    )
    monkeypatch.setattr("sandbox.security.internal_http_auth.settings", settings)
    monkeypatch.setattr("sandbox.security.internal_http_auth.time.time", lambda: NOW)
    calls: list[tuple[dict[str, Any], bytes, str]] = []

    class Runtime:
        async def handle(self, *, claims, raw_body, tool_name):
            calls.append((dict(claims), raw_body, tool_name))
            from fastapi.responses import JSONResponse

            return JSONResponse({"exitCode": 0})

    app = FastAPI()
    set_replay_store(app, InMemoryReplayStore())
    set_formal_execution_runtime(app, Runtime())  # type: ignore[arg-type]
    app.include_router(router)
    body = _body(tool_name)

    response = TestClient(app).post(
        f"/internal/v1/executions/{tool_name}",
        content=body,
        headers={"Authorization": f"Bearer {_token(tool_name, body)}"},
    )

    assert response.status_code == 200, response.text
    assert len(calls) == 1
    assert calls[0][0]["tool_execution_id"] == TOOL_EXEC
    assert calls[0][1] == body
    assert calls[0][2] == tool_name
