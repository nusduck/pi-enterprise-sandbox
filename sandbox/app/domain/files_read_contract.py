"""Strict POST /internal/v1/files/read body contract (PR-07B).

Parses dependency-cached exact raw bytes only. Never reserializes the wire
body for hashing (request-hash is recomputed from semantic args). Returns a
frozen :class:`ReadCommand` with no physical workspace paths.
"""

from __future__ import annotations

import hmac
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

from sandbox.app.domain.tool_request_hash import (
    TOOL_REQUEST_HASH_VERSION,
    ToolRequestHashError,
    compute_tool_request_hash_v1,
)
from sandbox.paths import AGENT_SKILL_PATH, AGENT_TEMP_PATH, AGENT_WORKSPACE_PATH
from sandbox.security.internal_auth import JS_MAX_SAFE_INTEGER
from sandbox.security.path_validation import validate_formal_id

# Fixed read contract (must match sandbox-bridge MAX_READ_*).
READ_MAX_BYTES_FIXED = 262_144
READ_LIMIT_MIN = 1
READ_LIMIT_MAX = 50_000
READ_OFFSET_MIN = 0
READ_PATH_MAX_LEN = 512
IDENTIFIER_MAX_LENGTH = 255
TOOL_CALL_ID_MAX_LEN = 255
TRACE_ID_MAX_LEN = 255

_TOOL_NAME_READ = "read"
_SCOPE_FILES_READ = "sandbox.files.read"

_ROOT_KEYS = frozenset(
    {
        "path",
        "offset",
        "limit",
        "maxBytes",
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

_VISIBLE_ASCII_RE = re.compile(r"^[\x21-\x7e]+$")
_LOWER_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class FilesReadContractError(ValueError):
    """Strict body/claim bind failure (safe for logs; never expose secrets)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.name = "FilesReadContractError"


def _fail(code: str, message: str) -> None:
    raise FilesReadContractError(code, message)


def _reject_json_constant(value: str) -> None:
    _fail("FILES_READ_JSON", f"non-finite JSON number is forbidden: {value}")


def _reject_float(_value: str) -> float:
    _fail("FILES_READ_JSON", "JSON float is forbidden")
    raise AssertionError("unreachable")  # pragma: no cover


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Reject duplicate keys (applied recursively by json.loads)."""
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            _fail("FILES_READ_JSON", "duplicate JSON object key")
        out[key] = value
    return out


def _decode_strict_json_object(raw: bytes) -> dict[str, Any]:
    """UTF-8 strict JSON object; reject duplicates, NaN/Inf, floats, trailing."""
    if type(raw) is not bytes:  # noqa: E721
        _fail("FILES_READ_BODY", "body must be exact raw bytes")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        _fail("FILES_READ_JSON", "body is not strict UTF-8")

    # Local import keeps module free of side effects at import time.
    import json

    try:
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
            parse_float=_reject_float,
        )
    except FilesReadContractError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError):
        _fail("FILES_READ_JSON", "body is not strict UTF-8 JSON object")

    if type(value) is not dict:
        _fail("FILES_READ_JSON", "body root must be a JSON object")
    return value


def _require_exact_keys(
    value: Mapping[str, Any], expected: frozenset[str], *, label: str
) -> None:
    if frozenset(value) != expected:
        _fail(
            "FILES_READ_SCHEMA",
            f"{label} has missing or unexpected keys",
        )


def _require_bounded_string(
    value: Any,
    *,
    name: str,
    max_length: int = IDENTIFIER_MAX_LENGTH,
    allow_empty: bool = False,
) -> str:
    if type(value) is not str:  # noqa: E721
        _fail("FILES_READ_FIELD", f"{name} must be a string")
    if (not allow_empty and not value) or len(value) > max_length:
        _fail("FILES_READ_FIELD", f"{name} must be a non-empty bounded string")
    if value != value.strip():
        _fail("FILES_READ_FIELD", f"{name} must not have leading/trailing whitespace")
    if not _VISIBLE_ASCII_RE.fullmatch(value):
        _fail("FILES_READ_FIELD", f"{name} must be visible ASCII")
    return value


def _require_strict_int(
    value: Any, *, name: str, min_v: int, max_v: int
) -> int:
    # bool is a subclass of int — reject explicitly.
    if type(value) is not int:  # noqa: E721
        _fail("FILES_READ_FIELD", f"{name} must be an integer (no coercion)")
    if value < min_v or value > max_v:
        _fail("FILES_READ_FIELD", f"{name} out of allowed range")
    return value


def _require_positive_js_safe_int(value: Any, *, name: str) -> int:
    if type(value) is not int:  # noqa: E721
        _fail("FILES_READ_FIELD", f"{name} must be a positive JS-safe integer")
    if value <= 0 or value > JS_MAX_SAFE_INTEGER:
        _fail("FILES_READ_FIELD", f"{name} must be a positive JS-safe integer")
    return value


def _require_lower_sha256(value: Any, *, name: str) -> str:
    if type(value) is not str or not _LOWER_SHA256_RE.fullmatch(value):
        _fail("FILES_READ_FIELD", f"{name} must be 64 lowercase hex chars")
    return value


def _validate_canonical_workspace_path(path: Any) -> str:
    """Path must already be Agent-canonical under /home/sandbox/workspace/<rel>."""
    if type(path) is not str:  # noqa: E721
        _fail("FILES_READ_PATH", "path must be a string")
    if not path or len(path) > READ_PATH_MAX_LEN:
        _fail("FILES_READ_PATH", "path empty or exceeds max length")
    if "\x00" in path:
        _fail("FILES_READ_PATH", "path contains NUL")
    if "\\" in path:
        _fail("FILES_READ_PATH", "backslash paths rejected")
    if path.endswith("/"):
        _fail("FILES_READ_PATH", "trailing slash rejected")
    if "//" in path:
        _fail("FILES_READ_PATH", "double slash rejected")
    if path != path.strip():
        _fail("FILES_READ_PATH", "path must not have surrounding whitespace")

    root = AGENT_WORKSPACE_PATH  # /home/sandbox/workspace
    if path == root or path == root + "/":
        _fail("FILES_READ_PATH", "workspace root is not a file path")
    prefix = root + "/"
    if not path.startswith(prefix):
        # Explicit skill / tmp denials for clear codes.
        if path == AGENT_SKILL_PATH or path.startswith(AGENT_SKILL_PATH + "/"):
            _fail("FILES_READ_PATH", "skill paths rejected on files.read")
        if path == AGENT_TEMP_PATH or path.startswith(AGENT_TEMP_PATH + "/"):
            _fail("FILES_READ_PATH", "tmp paths rejected on files.read")
        _fail("FILES_READ_PATH", "path must be under /home/sandbox/workspace/<relative>")

    relative = path[len(prefix) :]
    if relative == "":
        _fail("FILES_READ_PATH", "path must include a file name")
    pure = PurePosixPath(relative)
    if pure.is_absolute():
        _fail("FILES_READ_PATH", "invalid relative path")
    parts: list[str] = []
    for seg in pure.parts:
        if seg in ("", "."):
            _fail("FILES_READ_PATH", "empty or '.' path segment rejected")
        if seg == "..":
            _fail("FILES_READ_PATH", "parent traversal rejected")
        if "/" in seg or "\\" in seg or "\x00" in seg:
            _fail("FILES_READ_PATH", "invalid path segment")
        parts.append(seg)
    if not parts:
        _fail("FILES_READ_PATH", "path must include a file name")

    # Reconstruct canonical form — must equal input exactly (already canonical).
    canonical = f"{root}/{'/'.join(parts)}"
    if canonical != path:
        _fail("FILES_READ_PATH", "path is not canonical")
    return path


def _claim_str(claims: Mapping[str, Any], key: str) -> str:
    raw = claims.get(key)
    if type(raw) is not str:  # noqa: E721
        _fail("FILES_READ_CLAIM", f"claim {key} missing or not a string")
    return raw


def _claim_int(claims: Mapping[str, Any], key: str) -> int:
    raw = claims.get(key)
    if type(raw) is not int:  # noqa: E721
        _fail("FILES_READ_CLAIM", f"claim {key} missing or not an integer")
    return raw


def _exact_str_eq(body_value: str, claim_value: str, *, field: str) -> None:
    # Constant-time compare for identity / hash material.
    if len(body_value) != len(claim_value) or not hmac.compare_digest(
        body_value, claim_value
    ):
        _fail("FILES_READ_CLAIM_MISMATCH", f"{field} does not match verified claims")


def _exact_int_eq(body_value: int, claim_value: int, *, field: str) -> None:
    if body_value != claim_value:
        _fail("FILES_READ_CLAIM_MISMATCH", f"{field} does not match verified claims")


@dataclass(frozen=True, slots=True)
class ReadCommand:
    """Authoritative files.read command after strict body + claim bind.

    Contains only logical path and identity — never a physical workspace root.
    """

    path: str
    offset: int
    limit: int
    max_bytes: int
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


def parse_and_bind_files_read(
    raw_body: bytes,
    claims: Mapping[str, Any],
) -> ReadCommand:
    """Parse exact raw body, bind 1:1 to verified claims, recompute request-hash.

    On any failure raises :class:`FilesReadContractError`. Never touches DB or
    filesystem. Does not consume replay / HMAC (already done by dependency).
    """
    if not isinstance(claims, Mapping):
        _fail("FILES_READ_CLAIM", "claims must be a mapping")

    # Scope / tool are fixed by the route dependency; fail closed if wrong.
    scope = claims.get("scope")
    if type(scope) is not list or len(scope) != 1 or type(scope[0]) is not str:
        _fail("FILES_READ_CLAIM", "claim scope invalid")
    if not hmac.compare_digest(scope[0], _SCOPE_FILES_READ):
        _fail("FILES_READ_CLAIM", "claim scope is not sandbox.files.read")
    tool_name = _claim_str(claims, "tool_name")
    if not hmac.compare_digest(tool_name, _TOOL_NAME_READ):
        _fail("FILES_READ_CLAIM", "claim tool_name is not read")

    root = _decode_strict_json_object(raw_body)
    _require_exact_keys(root, _ROOT_KEYS, label="body")

    identity = root["identity"]
    if type(identity) is not dict:
        _fail("FILES_READ_SCHEMA", "identity must be a JSON object")
    _require_exact_keys(identity, _IDENTITY_KEYS, label="identity")

    path = _validate_canonical_workspace_path(root["path"])
    offset = _require_strict_int(
        root["offset"],
        name="offset",
        min_v=READ_OFFSET_MIN,
        max_v=JS_MAX_SAFE_INTEGER,
    )
    limit = _require_strict_int(
        root["limit"],
        name="limit",
        min_v=READ_LIMIT_MIN,
        max_v=READ_LIMIT_MAX,
    )
    max_bytes = _require_strict_int(
        root["maxBytes"],
        name="maxBytes",
        min_v=READ_MAX_BYTES_FIXED,
        max_v=READ_MAX_BYTES_FIXED,
    )
    if max_bytes != READ_MAX_BYTES_FIXED:
        _fail("FILES_READ_FIELD", "maxBytes must equal 262144")

    org_id = _require_bounded_string(identity["orgId"], name="identity.orgId")
    user_id = _require_bounded_string(identity["userId"], name="identity.userId")
    conversation_id = _require_bounded_string(
        identity["conversationId"], name="identity.conversationId"
    )
    agent_session_id = _require_bounded_string(
        identity["agentSessionId"], name="identity.agentSessionId"
    )
    run_id = _require_bounded_string(identity["runId"], name="identity.runId")
    sandbox_session_id = _require_bounded_string(
        identity["sandboxSessionId"], name="identity.sandboxSessionId"
    )
    trace_id = _require_bounded_string(
        identity["traceId"], name="identity.traceId", max_length=TRACE_ID_MAX_LEN
    )
    execution_fence_token = _require_positive_js_safe_int(
        identity["executionFenceToken"], name="identity.executionFenceToken"
    )

    tool_execution_id_raw = _require_bounded_string(
        root["toolExecutionId"], name="toolExecutionId"
    )
    try:
        tool_execution_id = validate_formal_id(tool_execution_id_raw, "toolExecutionId")
    except ValueError:
        _fail("FILES_READ_FIELD", "toolExecutionId must be a formal ULID")

    tool_call_id = _require_bounded_string(
        root["toolCallId"], name="toolCallId", max_length=TOOL_CALL_ID_MAX_LEN
    )
    request_hash = _require_lower_sha256(root["requestHash"], name="requestHash")
    request_hash_version = _require_strict_int(
        root["requestHashVersion"],
        name="requestHashVersion",
        min_v=TOOL_REQUEST_HASH_VERSION,
        max_v=TOOL_REQUEST_HASH_VERSION,
    )
    if request_hash_version != TOOL_REQUEST_HASH_VERSION:
        _fail("FILES_READ_FIELD", "requestHashVersion must be 1")

    # Exact body ↔ claim equality (camel ↔ snake), no coercion.
    _exact_str_eq(org_id, _claim_str(claims, "org_id"), field="orgId")
    _exact_str_eq(user_id, _claim_str(claims, "user_id"), field="userId")
    _exact_str_eq(
        conversation_id,
        _claim_str(claims, "conversation_id"),
        field="conversationId",
    )
    _exact_str_eq(
        agent_session_id,
        _claim_str(claims, "agent_session_id"),
        field="agentSessionId",
    )
    _exact_str_eq(run_id, _claim_str(claims, "run_id"), field="runId")
    _exact_str_eq(
        sandbox_session_id,
        _claim_str(claims, "sandbox_session_id"),
        field="sandboxSessionId",
    )
    _exact_str_eq(trace_id, _claim_str(claims, "trace_id"), field="traceId")
    _exact_int_eq(
        execution_fence_token,
        _claim_int(claims, "execution_fence_token"),
        field="executionFenceToken",
    )
    # Claims may store tool_execution_id in mixed case; formal id is uppercase.
    claim_te = _claim_str(claims, "tool_execution_id")
    try:
        claim_te_formal = validate_formal_id(claim_te, "tool_execution_id")
    except ValueError:
        _fail("FILES_READ_CLAIM", "claim tool_execution_id is not a formal ULID")
    _exact_str_eq(tool_execution_id, claim_te_formal, field="toolExecutionId")
    _exact_str_eq(tool_call_id, _claim_str(claims, "tool_call_id"), field="toolCallId")
    _exact_str_eq(
        request_hash, _claim_str(claims, "request_hash"), field="requestHash"
    )
    _exact_int_eq(
        request_hash_version,
        _claim_int(claims, "request_hash_version"),
        field="requestHashVersion",
    )

    # Recompute request-hash from semantic args only.
    try:
        computed = compute_tool_request_hash_v1(
            tool_name=_TOOL_NAME_READ,
            args={
                "path": path,
                "offset": offset,
                "limit": limit,
                "maxBytes": max_bytes,
            },
        )
    except ToolRequestHashError as exc:
        _fail("FILES_READ_HASH", str(exc) or "request-hash computation failed")

    computed_hash = computed["requestHash"]
    computed_ver = computed["requestHashVersion"]
    if type(computed_hash) is not str or type(computed_ver) is not int:
        _fail("FILES_READ_HASH", "request-hash computation returned invalid types")
    if computed_ver != TOOL_REQUEST_HASH_VERSION:
        _fail("FILES_READ_HASH", "request-hash version must be 1")
    claim_hash = _claim_str(claims, "request_hash")
    # Constant-time: computed == body == claim
    if not (
        hmac.compare_digest(computed_hash, request_hash)
        and hmac.compare_digest(computed_hash, claim_hash)
    ):
        _fail("FILES_READ_HASH", "requestHash does not match recomputed hash")

    return ReadCommand(
        path=path,
        offset=offset,
        limit=limit,
        max_bytes=max_bytes,
        org_id=org_id,
        user_id=user_id,
        conversation_id=conversation_id,
        agent_session_id=agent_session_id,
        run_id=run_id,
        sandbox_session_id=sandbox_session_id,
        trace_id=trace_id,
        execution_fence_token=execution_fence_token,
        tool_execution_id=tool_execution_id,
        tool_call_id=tool_call_id,
        request_hash=request_hash,
        request_hash_version=request_hash_version,
    )


__all__ = [
    "READ_MAX_BYTES_FIXED",
    "FilesReadContractError",
    "ReadCommand",
    "parse_and_bind_files_read",
]
