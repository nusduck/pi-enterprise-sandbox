"""Strict Agent -> Sandbox contracts for managed process tools."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.security.path_validation import validate_formal_id

_TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_ASCII_RE = re.compile(r"^[\x21-\x7e]+$")
_PROCESS_SIGNALS = frozenset({"TERM", "KILL", "INT"})
_IDENTITY_KEYS = frozenset({"orgId", "userId", "conversationId", "agentSessionId", "runId", "sandboxSessionId", "traceId", "executionFenceToken"})
_COMMON_KEYS = frozenset({"identity", "toolExecutionId", "toolCallId", "requestHash", "requestHashVersion"})
_TOOL_KEYS = {
    "process_start": frozenset({"command", "env", "timeoutSeconds"}),
    "process_status": frozenset({"processId"}),
    "process_read": frozenset({"processId", "stream", "cursor", "limit"}),
    "process_kill": frozenset({"processId", "signal"}),
}


class InternalProcessContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise InternalProcessContractError("PROCESS_JSON_INVALID", "duplicate JSON key")
        out[key] = value
    return out


def _decode(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_strict_object,
                           parse_float=lambda value: (_ for _ in ()).throw(InternalProcessContractError("PROCESS_JSON_INVALID", "float not allowed")))
    except InternalProcessContractError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise InternalProcessContractError("PROCESS_JSON_INVALID", "invalid JSON") from exc
    if type(value) is not dict:
        raise InternalProcessContractError("PROCESS_SCHEMA_INVALID", "body must be object")
    return value


def _id(value: Any, field: str) -> str:
    try:
        return validate_formal_id(value, field)
    except (TypeError, ValueError) as exc:
        raise InternalProcessContractError("PROCESS_FIELD_INVALID", f"{field} must be a formal ULID") from exc


def _ascii(value: Any, field: str, max_len: int = 255) -> str:
    if type(value) is not str or not value or len(value) > max_len or value != value.strip() or _ASCII_RE.fullmatch(value) is None:
        raise InternalProcessContractError("PROCESS_FIELD_INVALID", f"{field} invalid")
    return value


def _int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or value < minimum or value > maximum:
        raise InternalProcessContractError("PROCESS_FIELD_INVALID", f"{field} invalid")
    return value


def _exact(value: str, claims: Mapping[str, Any], key: str) -> None:
    claim = claims.get(key)
    if type(claim) is not str or not hmac.compare_digest(value, claim):
        raise InternalProcessContractError("PROCESS_CLAIM_MISMATCH", f"{key} mismatch")


@dataclass(frozen=True, slots=True)
class InternalProcessCommand:
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


def parse_and_bind_internal_process(raw_body: bytes, claims: Mapping[str, Any], *, tool_name: str) -> InternalProcessCommand:
    if tool_name not in _TOOL_KEYS or not isinstance(claims, Mapping):
        raise InternalProcessContractError("PROCESS_TOOL_INVALID", "unsupported process tool")
    scope = claims.get("scope")
    if scope != [f"sandbox.processes.{tool_name}"] or claims.get("tool_name") != tool_name:
        raise InternalProcessContractError("PROCESS_CLAIM_MISMATCH", "scope/tool mismatch")
    root = _decode(raw_body)
    if frozenset(root) != _COMMON_KEYS | _TOOL_KEYS[tool_name]:
        raise InternalProcessContractError("PROCESS_SCHEMA_INVALID", "body keys do not match contract")
    identity = root.get("identity")
    if type(identity) is not dict or frozenset(identity) != _IDENTITY_KEYS:
        raise InternalProcessContractError("PROCESS_SCHEMA_INVALID", "identity keys do not match contract")
    org_id, user_id, conversation_id = (_id(identity[k], f"identity.{k}") for k in ("orgId", "userId", "conversationId"))
    agent_session_id, run_id, sandbox_session_id = (_id(identity[k], f"identity.{k}") for k in ("agentSessionId", "runId", "sandboxSessionId"))
    trace_id = identity["traceId"]
    if type(trace_id) is not str or _TRACE_RE.fullmatch(trace_id) is None:
        raise InternalProcessContractError("PROCESS_FIELD_INVALID", "traceId invalid")
    fence = _int(identity["executionFenceToken"], "executionFenceToken", 1, 9_007_199_254_740_991)
    tool_execution_id = _id(root["toolExecutionId"], "toolExecutionId")
    tool_call_id = _ascii(root["toolCallId"], "toolCallId")
    request_hash = root["requestHash"]
    if type(request_hash) is not str or _HASH_RE.fullmatch(request_hash) is None:
        raise InternalProcessContractError("PROCESS_FIELD_INVALID", "requestHash invalid")
    version = _int(root["requestHashVersion"], "requestHashVersion", 1, 1)
    for body_value, key in ((org_id,"org_id"),(user_id,"user_id"),(conversation_id,"conversation_id"),(agent_session_id,"agent_session_id"),(run_id,"run_id"),(sandbox_session_id,"sandbox_session_id"),(trace_id,"trace_id"),(tool_execution_id,"tool_execution_id"),(tool_call_id,"tool_call_id"),(request_hash,"request_hash")):
        _exact(body_value, claims, key)
    if claims.get("execution_fence_token") != fence:
        raise InternalProcessContractError("PROCESS_CLAIM_MISMATCH", "fence mismatch")
    args: dict[str, Any]
    if tool_name == "process_start":
        command = root["command"]
        if type(command) is not str or not command.strip() or len(command) > 8192:
            raise InternalProcessContractError("PROCESS_FIELD_INVALID", "command invalid")
        env = root["env"]
        if type(env) is not dict or len(env) > 32 or any(type(k) is not str or type(v) is not str or len(k) > 64 or len(v) > 1024 for k,v in env.items()):
            raise InternalProcessContractError("PROCESS_FIELD_INVALID", "env invalid")
        args = {"command": command, "env": dict(env), "timeoutSeconds": _int(root["timeoutSeconds"], "timeoutSeconds", 1, 86_400)}
    elif tool_name == "process_status":
        args = {"processId": _id(root["processId"], "processId")}
    elif tool_name == "process_read":
        args = {"processId": _id(root["processId"], "processId"), "stream": root["stream"], "cursor": _ascii(root["cursor"], "cursor", 128), "limit": _int(root["limit"], "limit", 1, 65_536)}
        if args["stream"] not in ("stdout", "stderr"):
            raise InternalProcessContractError("PROCESS_FIELD_INVALID", "stream invalid")
    else:
        process_signal = _ascii(root["signal"], "signal", 16)
        if process_signal not in _PROCESS_SIGNALS:
            raise InternalProcessContractError("PROCESS_FIELD_INVALID", "signal invalid")
        args = {"processId": _id(root["processId"], "processId"), "signal": process_signal}
    try:
        computed = compute_tool_request_hash_v1(tool_name=tool_name, args=args)
    except Exception as exc:
        raise InternalProcessContractError("PROCESS_HASH_INVALID", "request hash cannot be computed") from exc
    if computed["requestHash"] != request_hash or computed["requestHashVersion"] != version:
        raise InternalProcessContractError("PROCESS_HASH_INVALID", "requestHash mismatch")
    return InternalProcessCommand(tool_name, args, org_id, user_id, conversation_id, agent_session_id, run_id, sandbox_session_id, trace_id, fence, tool_execution_id, tool_call_id, request_hash, version)


__all__ = ["InternalProcessCommand", "InternalProcessContractError", "parse_and_bind_internal_process"]
