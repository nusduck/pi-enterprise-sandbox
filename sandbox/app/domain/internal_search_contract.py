"""Strict Agent -> Sandbox contracts for workspace search tools.

`ls`, `find` and `grep` are read-only and take no path outside the session's
workspace or its private temp tree — the search service resolves and clamps
that itself. Everything else follows the same fail-closed shape as the process
contract: exact key sets, claim binding on every identity field, and a
recomputed request hash that must match the one the Agent signed.
"""

from __future__ import annotations

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
_COMMON_KEYS = frozenset(
    {"identity", "toolExecutionId", "toolCallId", "requestHash", "requestHashVersion"}
)
_TOOL_KEYS = {
    "ls": frozenset({"path", "depth", "includeHidden"}),
    "find": frozenset({"path", "pattern", "type", "maxDepth", "limit"}),
    "grep": frozenset(
        {"path", "query", "glob", "regex", "caseSensitive", "context", "limit", "outputMode"}
    ),
}

# Mirrors the model-facing schema in sandbox-bridge; the service clamps again.
MAX_SEARCH_PATH_LEN = 512
MAX_PATTERN_LEN = 512
MAX_QUERY_LEN = 1024
LS_MAX_DEPTH = 5
FIND_MAX_DEPTH = 20
FIND_MAX_LIMIT = 500
GREP_MAX_LIMIT = 500
GREP_MAX_CONTEXT = 5
_FIND_TYPES = frozenset({"file", "dir", "symlink"})
_GREP_OUTPUT_MODES = frozenset({"content", "files_with_matches", "count"})


class InternalSearchContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise InternalSearchContractError("SEARCH_JSON_INVALID", "duplicate JSON key")
        out[key] = value
    return out


def _reject_float(_value: str) -> Any:
    raise InternalSearchContractError("SEARCH_JSON_INVALID", "float not allowed")


def _decode(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_strict_object,
            parse_float=_reject_float,
        )
    except InternalSearchContractError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise InternalSearchContractError("SEARCH_JSON_INVALID", "invalid JSON") from exc
    if type(value) is not dict:
        raise InternalSearchContractError("SEARCH_SCHEMA_INVALID", "body must be object")
    return value


def _id(value: Any, field: str) -> str:
    try:
        return validate_formal_id(value, field)
    except (TypeError, ValueError) as exc:
        raise InternalSearchContractError(
            "SEARCH_FIELD_INVALID", f"{field} must be a formal ULID"
        ) from exc


def _ascii(value: Any, field: str, max_len: int = 255) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > max_len
        or value != value.strip()
        or _ASCII_RE.fullmatch(value) is None
    ):
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    return value


def _int(value: Any, field: str, minimum: int, maximum: int) -> int:
    # bool is an int subclass in Python; reject it so `true` cannot pass as 1.
    if type(value) is not int or value < minimum or value > maximum:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    return value


def _bool(value: Any, field: str) -> bool:
    if type(value) is not bool:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    return value


def _text(value: Any, field: str, max_len: int, *, allow_empty: bool = False) -> str:
    if type(value) is not str or len(value) > max_len:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    if not allow_empty and not value.strip():
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    if "\x00" in value:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", f"{field} invalid")
    return value


def _exact(value: str, claims: Mapping[str, Any], key: str) -> None:
    claim = claims.get(key)
    if type(claim) is not str or not hmac.compare_digest(value, claim):
        raise InternalSearchContractError("SEARCH_CLAIM_MISMATCH", f"{key} mismatch")


@dataclass(frozen=True, slots=True)
class InternalSearchCommand:
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


def _search_args(tool_name: str, root: Mapping[str, Any]) -> dict[str, Any]:
    path = _text(root["path"], "path", MAX_SEARCH_PATH_LEN)
    if tool_name == "ls":
        return {
            "path": path,
            "depth": _int(root["depth"], "depth", 0, LS_MAX_DEPTH),
            "includeHidden": _bool(root["includeHidden"], "includeHidden"),
        }
    if tool_name == "find":
        find_type = root["type"]
        if find_type is not None and find_type not in _FIND_TYPES:
            raise InternalSearchContractError("SEARCH_FIELD_INVALID", "type invalid")
        return {
            "path": path,
            "pattern": _text(root["pattern"], "pattern", MAX_PATTERN_LEN),
            "type": find_type,
            "maxDepth": _int(root["maxDepth"], "maxDepth", 0, FIND_MAX_DEPTH),
            "limit": _int(root["limit"], "limit", 1, FIND_MAX_LIMIT),
        }
    glob = root["glob"]
    if glob is not None:
        glob = _text(glob, "glob", MAX_PATTERN_LEN)
    output_mode = root["outputMode"]
    if output_mode not in _GREP_OUTPUT_MODES:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", "outputMode invalid")
    return {
        "path": path,
        "query": _text(root["query"], "query", MAX_QUERY_LEN),
        "glob": glob,
        "regex": _bool(root["regex"], "regex"),
        "caseSensitive": _bool(root["caseSensitive"], "caseSensitive"),
        "context": _int(root["context"], "context", 0, GREP_MAX_CONTEXT),
        "limit": _int(root["limit"], "limit", 1, GREP_MAX_LIMIT),
        "outputMode": output_mode,
    }


def parse_and_bind_internal_search(
    raw_body: bytes, claims: Mapping[str, Any], *, tool_name: str
) -> InternalSearchCommand:
    if tool_name not in _TOOL_KEYS or not isinstance(claims, Mapping):
        raise InternalSearchContractError("SEARCH_TOOL_INVALID", "unsupported search tool")
    if claims.get("scope") != [f"sandbox.files.{tool_name}"] or claims.get("tool_name") != tool_name:
        raise InternalSearchContractError("SEARCH_CLAIM_MISMATCH", "scope/tool mismatch")

    root = _decode(raw_body)
    if frozenset(root) != _COMMON_KEYS | _TOOL_KEYS[tool_name]:
        raise InternalSearchContractError(
            "SEARCH_SCHEMA_INVALID", "body keys do not match contract"
        )
    identity = root.get("identity")
    if type(identity) is not dict or frozenset(identity) != _IDENTITY_KEYS:
        raise InternalSearchContractError(
            "SEARCH_SCHEMA_INVALID", "identity keys do not match contract"
        )

    org_id, user_id, conversation_id = (
        _id(identity[k], f"identity.{k}") for k in ("orgId", "userId", "conversationId")
    )
    agent_session_id, run_id, sandbox_session_id = (
        _id(identity[k], f"identity.{k}")
        for k in ("agentSessionId", "runId", "sandboxSessionId")
    )
    trace_id = identity["traceId"]
    if type(trace_id) is not str or _TRACE_RE.fullmatch(trace_id) is None:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", "traceId invalid")
    fence = _int(
        identity["executionFenceToken"], "executionFenceToken", 1, 9_007_199_254_740_991
    )

    tool_execution_id = _id(root["toolExecutionId"], "toolExecutionId")
    tool_call_id = _ascii(root["toolCallId"], "toolCallId")
    request_hash = root["requestHash"]
    if type(request_hash) is not str or _HASH_RE.fullmatch(request_hash) is None:
        raise InternalSearchContractError("SEARCH_FIELD_INVALID", "requestHash invalid")
    version = _int(root["requestHashVersion"], "requestHashVersion", 1, 1)

    for body_value, key in (
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
    ):
        _exact(body_value, claims, key)
    if claims.get("execution_fence_token") != fence:
        raise InternalSearchContractError("SEARCH_CLAIM_MISMATCH", "fence mismatch")

    args = _search_args(tool_name, root)
    try:
        computed = compute_tool_request_hash_v1(tool_name=tool_name, args=args)
    except Exception as exc:
        raise InternalSearchContractError(
            "SEARCH_HASH_INVALID", "request hash cannot be computed"
        ) from exc
    if computed["requestHash"] != request_hash or computed["requestHashVersion"] != version:
        raise InternalSearchContractError("SEARCH_HASH_INVALID", "requestHash mismatch")

    return InternalSearchCommand(
        tool_name,
        args,
        org_id,
        user_id,
        conversation_id,
        agent_session_id,
        run_id,
        sandbox_session_id,
        trace_id,
        fence,
        tool_execution_id,
        tool_call_id,
        request_hash,
        version,
    )


__all__ = [
    "FIND_MAX_DEPTH",
    "FIND_MAX_LIMIT",
    "GREP_MAX_CONTEXT",
    "GREP_MAX_LIMIT",
    "InternalSearchCommand",
    "InternalSearchContractError",
    "LS_MAX_DEPTH",
    "MAX_PATTERN_LEN",
    "MAX_QUERY_LEN",
    "MAX_SEARCH_PATH_LEN",
    "parse_and_bind_internal_search",
]
