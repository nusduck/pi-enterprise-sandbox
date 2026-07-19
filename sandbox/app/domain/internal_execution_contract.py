"""Strict Agent -> Sandbox contracts for claimed bash and Python tools."""

from __future__ import annotations

import hmac
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from sandbox.app.domain.tool_request_hash import (
    TOOL_REQUEST_HASH_VERSION,
    ToolRequestHashError,
    compute_tool_request_hash_v1,
)
from sandbox.security.path_validation import validate_formal_id

JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_BASH_COMMAND_LEN = 8_192
MAX_EXECUTION_TIMEOUT_SECONDS = 600
MAX_PYTHON_CODE_BYTES = 256 * 1024
MAX_PYTHON_ARGS = 32
MAX_PYTHON_ARG_LEN = 1_024
MAX_ENV_KEYS = 32
MAX_ENV_KEY_LEN = 64
MAX_ENV_VALUE_LEN = 1_024

_COMMON_KEYS = frozenset(
    {
        "identity",
        "toolExecutionId",
        "toolCallId",
        "requestHash",
        "requestHashVersion",
    }
)
_IDENTITY_KEYS = frozenset(
    {
        "orgId",
        "userId",
        "conversationId",
        "agentSessionId",
        "runId",
        "sandboxSessionId",
        "traceId",
        "executionFenceToken",
    }
)
_TOOL_KEYS = {
    "bash": frozenset({"command", "timeoutSeconds", "env"}),
    "python": frozenset({"code", "args", "timeoutSeconds"}),
}
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
_VISIBLE_ASCII_RE = re.compile(r"^[\x21-\x7e]+$")
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_SENSITIVE_ENV_KEY_RE = re.compile(
    r"^(?:AWS_|AZURE_|GCP_|GOOGLE_|OPENAI_|ANTHROPIC_|API[_-]?KEY|SECRET|"
    r"PASSWORD|TOKEN|AUTHORIZATION|BEARER|PRIVATE[_-]?KEY|SSH_|HOME|PATH|LD_|DYLD_)",
    re.IGNORECASE,
)


class InternalExecutionContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _fail(code: str, message: str) -> None:
    raise InternalExecutionContractError(code, message)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            _fail("EXECUTION_JSON_INVALID", "duplicate JSON key")
        out[key] = value
    return out


def _reject_number(value: str) -> None:
    _fail("EXECUTION_JSON_INVALID", f"unsupported JSON number {value}")


def _decode(raw_body: bytes) -> dict[str, Any]:
    if type(raw_body) is not bytes:  # noqa: E721
        _fail("EXECUTION_BODY_INVALID", "body must be bytes")
    try:
        value = json.loads(
            raw_body.decode("utf-8", errors="strict"),
            object_pairs_hook=_strict_object,
            parse_float=_reject_number,
            parse_constant=_reject_number,
        )
    except InternalExecutionContractError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        _fail("EXECUTION_JSON_INVALID", "body must be strict JSON")
    if type(value) is not dict:
        _fail("EXECUTION_JSON_INVALID", "body must be an object")
    return value


def _strict_int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:  # noqa: E721
        _fail("EXECUTION_FIELD_INVALID", f"{name} must be an integer in range")
    return value


def _visible_ascii(value: Any, name: str, maximum: int = 255) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > maximum
        or value != value.strip()
        or _VISIBLE_ASCII_RE.fullmatch(value) is None
    ):
        _fail("EXECUTION_FIELD_INVALID", f"{name} must be bounded visible ASCII")
    return value


def _formal_id(value: Any, name: str) -> str:
    try:
        return validate_formal_id(value, name)
    except (TypeError, ValueError):
        _fail("EXECUTION_FIELD_INVALID", f"{name} must be a formal ULID")


def _exact_str(body: str, claims: Mapping[str, Any], claim_key: str) -> None:
    claim = claims.get(claim_key)
    if type(claim) is not str or not hmac.compare_digest(body, claim):
        _fail("EXECUTION_CLAIM_MISMATCH", f"{claim_key} mismatch")


def _normalize_env(value: Any) -> dict[str, str]:
    if type(value) is not dict or len(value) > MAX_ENV_KEYS:
        _fail("EXECUTION_ENV_INVALID", "env must be a bounded object")
    out: dict[str, str] = {}
    for key, item in value.items():
        if (
            type(key) is not str
            or not key
            or len(key) > MAX_ENV_KEY_LEN
            or _ENV_KEY_RE.fullmatch(key) is None
            or _SENSITIVE_ENV_KEY_RE.search(key) is not None
        ):
            _fail("EXECUTION_ENV_INVALID", "env key is invalid or denied")
        if type(item) is not str or len(item) > MAX_ENV_VALUE_LEN:
            _fail("EXECUTION_ENV_INVALID", "env value must be a bounded string")
        out[key] = item
    return out


@dataclass(frozen=True, slots=True)
class InternalExecutionCommand:
    tool_name: str
    args: dict[str, Any]
    org_id: str
    user_id: str
    conversation_id: str
    agent_session_id: str
    run_id: str
    sandbox_session_id: str
    trace_id: str
    execution_fence_token: int
    tool_execution_id: str
    tool_call_id: str
    request_hash: str
    request_hash_version: int


def parse_and_bind_internal_execution(
    raw_body: bytes,
    claims: Mapping[str, Any],
    *,
    tool_name: str,
) -> InternalExecutionCommand:
    """Parse, normalize, hash, and bind a bash/Python request to HMAC claims."""
    if tool_name not in _TOOL_KEYS or not isinstance(claims, Mapping):
        _fail("EXECUTION_TOOL_INVALID", "unsupported execution tool")
    scope = claims.get("scope")
    expected_scope = f"sandbox.executions.{tool_name}"
    if scope != [expected_scope] or claims.get("tool_name") != tool_name:
        _fail("EXECUTION_CLAIM_MISMATCH", "scope or tool mismatch")

    root = _decode(raw_body)
    expected_keys = _COMMON_KEYS | _TOOL_KEYS[tool_name]
    if frozenset(root) != expected_keys:
        _fail("EXECUTION_SCHEMA_INVALID", "body keys do not match contract")
    identity = root.get("identity")
    if type(identity) is not dict or frozenset(identity) != _IDENTITY_KEYS:
        _fail("EXECUTION_SCHEMA_INVALID", "identity keys do not match contract")

    org_id = _formal_id(identity["orgId"], "identity.orgId")
    user_id = _formal_id(identity["userId"], "identity.userId")
    conversation_id = _formal_id(identity["conversationId"], "identity.conversationId")
    agent_session_id = _formal_id(identity["agentSessionId"], "identity.agentSessionId")
    run_id = _formal_id(identity["runId"], "identity.runId")
    sandbox_session_id = _formal_id(identity["sandboxSessionId"], "identity.sandboxSessionId")
    trace_id = identity["traceId"]
    if type(trace_id) is not str or _TRACE_RE.fullmatch(trace_id) is None:
        _fail("EXECUTION_FIELD_INVALID", "identity.traceId must be lowercase hex32")
    fence = _strict_int(
        identity["executionFenceToken"],
        "identity.executionFenceToken",
        1,
        JS_MAX_SAFE_INTEGER,
    )
    tool_execution_id = _formal_id(root["toolExecutionId"], "toolExecutionId")
    tool_call_id = _visible_ascii(root["toolCallId"], "toolCallId")
    request_hash = root["requestHash"]
    if type(request_hash) is not str or _SHA256_RE.fullmatch(request_hash) is None:
        _fail("EXECUTION_FIELD_INVALID", "requestHash must be lowercase sha256")
    request_hash_version = _strict_int(
        root["requestHashVersion"], "requestHashVersion", 1, 1
    )

    claim_pairs = (
        (org_id, "org_id"),
        (user_id, "user_id"),
        (conversation_id, "conversation_id"),
        (agent_session_id, "agent_session_id"),
        (run_id, "run_id"),
        (sandbox_session_id, "sandbox_session_id"),
        (trace_id, "trace_id"),
        (tool_execution_id, "tool_execution_id"),
        (tool_call_id, "tool_call_id"),
        (request_hash, "request_hash"),
    )
    for body_value, claim_key in claim_pairs:
        _exact_str(body_value, claims, claim_key)
    if claims.get("execution_fence_token") != fence:
        _fail("EXECUTION_CLAIM_MISMATCH", "execution_fence_token mismatch")
    if claims.get("request_hash_version") != request_hash_version:
        _fail("EXECUTION_CLAIM_MISMATCH", "request_hash_version mismatch")

    if tool_name == "bash":
        command = root["command"]
        if type(command) is not str or not command.strip() or len(command) > MAX_BASH_COMMAND_LEN:
            _fail("EXECUTION_FIELD_INVALID", "command is empty or too long")
        args = {
            "command": command,
            "timeoutSeconds": _strict_int(
                root["timeoutSeconds"], "timeoutSeconds", 1, MAX_EXECUTION_TIMEOUT_SECONDS
            ),
            "env": _normalize_env(root["env"]),
        }
    else:
        code = root["code"]
        if type(code) is not str or not code.strip():
            _fail("EXECUTION_FIELD_INVALID", "code is required")
        try:
            code_size = len(code.encode("utf-8"))
        except UnicodeEncodeError:
            _fail("EXECUTION_FIELD_INVALID", "code must be UTF-8")
        if code_size > MAX_PYTHON_CODE_BYTES:
            _fail("EXECUTION_FIELD_INVALID", "code is too large")
        raw_args = root["args"]
        if type(raw_args) is not list or len(raw_args) > MAX_PYTHON_ARGS:
            _fail("EXECUTION_FIELD_INVALID", "args must be a bounded array")
        python_args: list[str] = []
        for item in raw_args:
            if type(item) is not str or len(item) > MAX_PYTHON_ARG_LEN:
                _fail("EXECUTION_FIELD_INVALID", "python arg is invalid")
            python_args.append(item)
        args = {
            "code": code,
            "args": python_args,
            "timeoutSeconds": _strict_int(
                root["timeoutSeconds"], "timeoutSeconds", 1, MAX_EXECUTION_TIMEOUT_SECONDS
            ),
        }

    try:
        computed = compute_tool_request_hash_v1(tool_name=tool_name, args=args)
    except ToolRequestHashError as exc:
        _fail("EXECUTION_HASH_INVALID", str(exc))
    if (
        computed["requestHashVersion"] != TOOL_REQUEST_HASH_VERSION
        or not hmac.compare_digest(computed["requestHash"], request_hash)
    ):
        _fail("EXECUTION_HASH_INVALID", "requestHash does not match normalized args")

    return InternalExecutionCommand(
        tool_name=tool_name,
        args=args,
        org_id=org_id,
        user_id=user_id,
        conversation_id=conversation_id,
        agent_session_id=agent_session_id,
        run_id=run_id,
        sandbox_session_id=sandbox_session_id,
        trace_id=trace_id,
        execution_fence_token=fence,
        tool_execution_id=tool_execution_id,
        tool_call_id=tool_call_id,
        request_hash=request_hash,
        request_hash_version=request_hash_version,
    )


__all__ = [
    "InternalExecutionCommand",
    "InternalExecutionContractError",
    "parse_and_bind_internal_execution",
]
