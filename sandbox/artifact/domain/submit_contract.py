"""Strict Agent -> Sandbox contract for ``submit_artifact``."""

from __future__ import annotations

import hmac
import re
from dataclasses import dataclass
from collections.abc import Mapping
from typing import Any

from sandbox.app.domain.files_read_contract import _decode_strict_json_object
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.paths import AGENT_WORKSPACE_PATH
from sandbox.security.path_validation import validate_formal_id

_COMMON = {"identity", "toolExecutionId", "toolCallId", "requestHash", "requestHashVersion"}
_IDENTITY = frozenset({"orgId", "userId", "conversationId", "agentSessionId", "runId", "sandboxSessionId", "traceId", "executionFenceToken"})
_ASCII = re.compile(r"^[\x21-\x7e]+$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
_TRACE = re.compile(r"^[0-9a-f]{32}$")
_MAX_PATH = 512


class InternalArtifactContractError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        super().__init__(message)


def _fail(code: str, message: str) -> None:
    raise InternalArtifactContractError(code, message)


def _str(value: Any, name: str, maximum: int = 255) -> str:
    if type(value) is not str or not value or len(value) > maximum or value != value.strip() or _ASCII.fullmatch(value) is None:
        _fail("ARTIFACT_FIELD_INVALID", f"{name} invalid")
    return value


def _unicode_text(value: Any, name: str, maximum: int) -> str:
    if type(value) is not str or not value or len(value) > maximum or value != value.strip() or any(ord(ch) < 0x20 or ord(ch) == 0x7f for ch in value):
        _fail("ARTIFACT_FIELD_INVALID", f"{name} invalid")
    try:
        value.encode("utf-8", "strict")
    except UnicodeEncodeError:
        _fail("ARTIFACT_FIELD_INVALID", f"{name} invalid")
    return value


def _id(value: Any, name: str) -> str:
    try:
        return validate_formal_id(value, name)
    except (TypeError, ValueError) as exc:
        _fail("ARTIFACT_FIELD_INVALID", f"{name} must be a formal ULID")
        raise AssertionError from exc


def _path(value: Any) -> str:
    path = _str(value, "path", _MAX_PATH)
    prefix = AGENT_WORKSPACE_PATH + "/"
    if not path.startswith(prefix) or path.endswith("/") or "//" in path:
        _fail("ARTIFACT_PATH_INVALID", "path must be under workspace")
    parts = path[len(prefix) :].split("/")
    if not parts or any(not p or p in (".", "..") or "\\" in p or "\x00" in p for p in parts):
        _fail("ARTIFACT_PATH_INVALID", "path traversal rejected")
    if prefix + "/".join(parts) != path:
        _fail("ARTIFACT_PATH_INVALID", "path is not canonical")
    return path


def _claim(value: str, claims: Mapping[str, Any], key: str) -> None:
    other = claims.get(key)
    if type(other) is not str or not hmac.compare_digest(value, other):
        _fail("ARTIFACT_CLAIM_MISMATCH", f"{key} mismatch")


@dataclass(frozen=True, slots=True)
class InternalArtifactCommand:
    path: str
    display_name: str | None
    description: str | None
    identity: dict[str, Any]
    tool_execution_id: str
    tool_call_id: str
    request_hash: str
    request_hash_version: int

    @property
    def org_id(self) -> str: return self.identity["orgId"]
    @property
    def user_id(self) -> str: return self.identity["userId"]
    @property
    def conversation_id(self) -> str: return self.identity["conversationId"]
    @property
    def agent_session_id(self) -> str: return self.identity["agentSessionId"]
    @property
    def run_id(self) -> str: return self.identity["runId"]
    @property
    def sandbox_session_id(self) -> str: return self.identity["sandboxSessionId"]
    @property
    def trace_id(self) -> str: return self.identity["traceId"]
    @property
    def execution_fence_token(self) -> int: return self.identity["executionFenceToken"]


def parse_and_bind_internal_artifact(raw_body: bytes, claims: Mapping[str, Any]) -> InternalArtifactCommand:
    if not isinstance(claims, Mapping) or claims.get("scope") != ["sandbox.artifacts.submit"] or claims.get("tool_name") != "submit_artifact":
        _fail("ARTIFACT_CLAIM_MISMATCH", "scope/tool mismatch")
    try:
        root = _decode_strict_json_object(raw_body)
    except Exception:
        _fail("ARTIFACT_JSON_INVALID", "body is not strict JSON object")
    optional = {"displayName", "description"}
    if frozenset(root) - (_COMMON | {"path"} | optional) or not (_COMMON | {"path"}).issubset(root):
        _fail("ARTIFACT_SCHEMA_INVALID", "body keys invalid")
    ident = root.get("identity")
    if type(ident) is not dict or frozenset(ident) != _IDENTITY:
        _fail("ARTIFACT_SCHEMA_INVALID", "identity keys invalid")
    out_identity: dict[str, Any] = {}
    for key in ("orgId", "userId", "conversationId", "agentSessionId", "runId", "sandboxSessionId"):
        out_identity[key] = _id(ident[key], f"identity.{key}")
        _claim(out_identity[key], claims, {"orgId":"org_id","userId":"user_id","conversationId":"conversation_id","agentSessionId":"agent_session_id","runId":"run_id","sandboxSessionId":"sandbox_session_id"}[key])
    trace = ident["traceId"]
    if type(trace) is not str or _TRACE.fullmatch(trace) is None:
        _fail("ARTIFACT_FIELD_INVALID", "traceId invalid")
    out_identity["traceId"] = trace
    _claim(trace, claims, "trace_id")
    fence = ident["executionFenceToken"]
    if type(fence) is not int or fence <= 0 or fence > 9_007_199_254_740_991 or claims.get("execution_fence_token") != fence:
        _fail("ARTIFACT_CLAIM_MISMATCH", "execution fence mismatch")
    out_identity["executionFenceToken"] = fence
    te = _id(root["toolExecutionId"], "toolExecutionId")
    if claims.get("tool_execution_id") != te: _fail("ARTIFACT_CLAIM_MISMATCH", "toolExecutionId mismatch")
    tc = _str(root["toolCallId"], "toolCallId")
    _claim(tc, claims, "tool_call_id")
    rh = root["requestHash"]
    if type(rh) is not str or _SHA.fullmatch(rh) is None or claims.get("request_hash") != rh: _fail("ARTIFACT_HASH_INVALID", "requestHash invalid")
    rv = root["requestHashVersion"]
    if rv != 1 or claims.get("request_hash_version") != rv: _fail("ARTIFACT_HASH_INVALID", "requestHashVersion invalid")
    path = _path(root["path"])
    display = root.get("displayName")
    if display is not None: display = _unicode_text(display, "displayName", 256)
    description = root.get("description")
    if description is not None: description = _unicode_text(description, "description", 1024)
    args = {"path": path}
    if "displayName" in root: args["displayName"] = display
    if "description" in root: args["description"] = description
    try: computed = compute_tool_request_hash_v1(tool_name="submit_artifact", args=args)
    except Exception as exc:
        _fail("ARTIFACT_HASH_INVALID", "requestHash cannot be computed")
    if computed["requestHash"] != rh: _fail("ARTIFACT_HASH_INVALID", "requestHash mismatch")
    return InternalArtifactCommand(path, display, description, out_identity, te, tc, rh, rv)


__all__ = ["InternalArtifactCommand", "InternalArtifactContractError", "parse_and_bind_internal_artifact"]
