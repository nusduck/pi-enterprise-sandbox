"""Strict contracts for Agent internal files.write/files.edit routes."""
from __future__ import annotations

import hmac
import base64
import binascii
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sandbox.app.domain.tool_request_hash import (
    TOOL_REQUEST_HASH_VERSION,
    compute_tool_request_hash_v1,
)
from sandbox.app.domain.files_read_contract import _decode_strict_json_object
from sandbox.paths import AGENT_WORKSPACE_PATH
from sandbox.security.internal_auth import JS_MAX_SAFE_INTEGER
from sandbox.security.path_validation import validate_formal_id

_ID_RE = re.compile(r"^[\x21-\x7e]+$")
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_TRACE_RE = re.compile(r"^[0-9a-f]{32}$")
_ROOT_COMMON = {"path", "identity", "toolExecutionId", "toolCallId", "requestHash", "requestHashVersion"}
_IDENTITY_KEYS = frozenset({"orgId", "userId", "conversationId", "agentSessionId", "runId", "sandboxSessionId", "traceId", "executionFenceToken"})
_MAX_PATH = 512
_MAX_CONTENT_BYTES = 16 * 1024 * 1024


class FilesWriteContractError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _fail(code: str, msg: str) -> None:
    raise FilesWriteContractError(code, msg)


def _decode(raw: bytes) -> dict[str, Any]:
    try:
        return _decode_strict_json_object(raw)
    except Exception as exc:
        if isinstance(exc, FilesWriteContractError):
            raise
        _fail("FILES_WRITE_JSON", "body is not strict JSON object")


def _str(v: Any, name: str, max_len: int = 255) -> str:
    if type(v) is not str or not v or len(v) > max_len or v != v.strip() or not _ID_RE.fullmatch(v):
        _fail("FILES_WRITE_FIELD", f"{name} invalid")
    return v


def _int(v: Any, name: str, min_v: int = 1) -> int:
    if type(v) is not int or v < min_v or v > JS_MAX_SAFE_INTEGER:
        _fail("FILES_WRITE_FIELD", f"{name} invalid")
    return v


def _path(v: Any) -> str:
    if type(v) is not str or not v or len(v) > _MAX_PATH or "\x00" in v or "\\" in v or v.endswith("/") or "//" in v:
        _fail("FILES_WRITE_PATH", "path invalid")
    prefix = AGENT_WORKSPACE_PATH + "/"
    if not v.startswith(prefix):
        _fail("FILES_WRITE_PATH", "path must be under workspace")
    parts = v[len(prefix):].split("/")
    if not parts or any(not p or p in (".", "..") for p in parts):
        _fail("FILES_WRITE_PATH", "path traversal rejected")
    canonical = prefix + "/".join(parts)
    if canonical != v:
        _fail("FILES_WRITE_PATH", "path is not canonical")
    return v


def _identity(root: Mapping[str, Any], claims: Mapping[str, Any]) -> dict[str, Any]:
    ident = root.get("identity")
    if type(ident) is not dict or frozenset(ident) != _IDENTITY_KEYS:
        _fail("FILES_WRITE_SCHEMA", "identity schema invalid")
    out: dict[str, Any] = {}
    for key in ("orgId", "userId", "conversationId", "agentSessionId", "runId", "sandboxSessionId", "traceId"):
        val = _str(ident[key], f"identity.{key}")
        if key == "traceId":
            if not _TRACE_RE.fullmatch(val):
                _fail("FILES_WRITE_FIELD", "identity.traceId invalid")
        else:
            try:
                val = validate_formal_id(val, f"identity.{key}")
            except ValueError:
                _fail("FILES_WRITE_FIELD", f"identity.{key} invalid")
        claim_key = {"orgId":"org_id","userId":"user_id","conversationId":"conversation_id","agentSessionId":"agent_session_id","runId":"run_id","sandboxSessionId":"sandbox_session_id","traceId":"trace_id"}[key]
        c = claims.get(claim_key)
        if type(c) is not str or not hmac.compare_digest(val, c):
            _fail("FILES_WRITE_CLAIM_MISMATCH", f"{key} does not match claims")
        out[key] = val
    fence = _int(ident["executionFenceToken"], "identity.executionFenceToken")
    if type(claims.get("execution_fence_token")) is not int or fence != claims["execution_fence_token"]:
        _fail("FILES_WRITE_CLAIM_MISMATCH", "executionFenceToken does not match claims")
    out["executionFenceToken"] = fence
    return out


def _common(root: dict[str, Any], claims: Mapping[str, Any], *, tool: str, scope: str) -> tuple[dict[str, Any], dict[str, Any]]:
    if claims.get("scope") != [scope] or claims.get("tool_name") != tool:
        _fail("FILES_WRITE_CLAIM", "scope/tool mismatch")
    ident = _identity(root, claims)
    te_raw = _str(root.get("toolExecutionId"), "toolExecutionId")
    try:
        te = validate_formal_id(te_raw, "toolExecutionId")
    except ValueError:
        _fail("FILES_WRITE_FIELD", "toolExecutionId invalid")
    try:
        claim_te = validate_formal_id(str(claims.get("tool_execution_id", "")), "tool_execution_id")
    except ValueError:
        _fail("FILES_WRITE_CLAIM", "claim tool_execution_id invalid")
    if claim_te != te:
        _fail("FILES_WRITE_CLAIM_MISMATCH", "toolExecutionId does not match claims")
    tc = _str(root.get("toolCallId"), "toolCallId")
    if claims.get("tool_call_id") != tc:
        _fail("FILES_WRITE_CLAIM_MISMATCH", "toolCallId does not match claims")
    rh = root.get("requestHash")
    if type(rh) is not str or not _HASH_RE.fullmatch(rh) or claims.get("request_hash") != rh:
        _fail("FILES_WRITE_HASH", "requestHash invalid or mismatched")
    rv = root.get("requestHashVersion")
    if type(rv) is not int or rv != TOOL_REQUEST_HASH_VERSION or claims.get("request_hash_version") != rv:
        _fail("FILES_WRITE_HASH", "requestHashVersion invalid or mismatched")
    return ident, {"toolExecutionId": te, "toolCallId": tc, "requestHash": rh, "requestHashVersion": rv}


@dataclass(frozen=True, slots=True)
class WriteCommand:
    path: str; content: str; encoding: str; identity: dict[str, Any]; tool_execution_id: str; tool_call_id: str; request_hash: str; request_hash_version: int


@dataclass(frozen=True, slots=True)
class EditCommand:
    path: str; old_text: str; new_text: str; expected_hash: str | None; expected_version: str | None; identity: dict[str, Any]; tool_execution_id: str; tool_call_id: str; request_hash: str; request_hash_version: int


def _check_hash(tool: str, args: dict[str, Any], supplied: str) -> None:
    try:
        computed = compute_tool_request_hash_v1(tool_name=tool, args=args)["requestHash"]
    except Exception as exc:
        _fail("FILES_WRITE_HASH", "request hash computation failed")
    if not hmac.compare_digest(str(computed), supplied):
        _fail("FILES_WRITE_HASH", "requestHash does not match semantic arguments")


def parse_and_bind_files_write(raw_body: bytes, claims: Mapping[str, Any]) -> WriteCommand:
    root = _decode(raw_body)
    expected = _ROOT_COMMON | {"content", "encoding"}
    if frozenset(root) != expected:
        _fail("FILES_WRITE_SCHEMA", "body keys invalid")
    ident, c = _common(root, claims, tool="write", scope="sandbox.files.write")
    path = _path(root["path"])
    content = root["content"]
    if type(content) is not str:
        _fail("FILES_WRITE_FIELD", "content must be a string")
    encoding = root["encoding"]
    if encoding not in ("utf-8", "base64"):
        _fail("FILES_WRITE_FIELD", "encoding must be utf-8 or base64")
    if encoding == "utf-8":
        try:
            content_bytes = content.encode("utf-8", "strict")
        except UnicodeEncodeError as exc:
            _fail("FILES_WRITE_FIELD", "content encoding invalid")
    else:
        try:
            # validate=True rejects non-alphabet characters and malformed
            # padding. The limit applies to decoded bytes, not the JSON/base64
            # representation, which is the actual storage cost.
            content_bytes = base64.b64decode(content.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error, ValueError):
            _fail("FILES_WRITE_FIELD", "base64 content invalid")
    if len(content_bytes) > _MAX_CONTENT_BYTES:
        _fail("FILES_WRITE_FIELD", "content too large")
    _check_hash("write", {"path": path, "content": content, "encoding": encoding}, c["requestHash"])
    return WriteCommand(path, content, encoding, ident, c["toolExecutionId"], c["toolCallId"], c["requestHash"], c["requestHashVersion"])


def parse_and_bind_files_edit(raw_body: bytes, claims: Mapping[str, Any]) -> EditCommand:
    root = _decode(raw_body)
    base = _ROOT_COMMON | {"oldText", "newText"}
    if frozenset(root) - (base | {"expectedHash", "expectedVersion"}) or not base.issubset(root):
        _fail("FILES_WRITE_SCHEMA", "body keys invalid")
    if "expectedHash" not in root and "expectedVersion" not in root:
        _fail("FILE_VERSION_PRECONDITION_REQUIRED", "expectedHash or expectedVersion required")
    ident, c = _common(root, claims, tool="edit", scope="sandbox.files.edit")
    path = _path(root["path"])
    old_text, new_text = root["oldText"], root["newText"]
    if type(old_text) is not str or type(new_text) is not str:
        _fail("FILES_WRITE_FIELD", "oldText/newText must be strings")
    try:
        old_bytes = old_text.encode("utf-8", "strict") if type(old_text) is str else b""
        new_bytes = new_text.encode("utf-8", "strict") if type(new_text) is str else b""
    except UnicodeEncodeError:
        old_bytes = new_bytes = b""
    if len(old_bytes) > _MAX_CONTENT_BYTES or len(new_bytes) > _MAX_CONTENT_BYTES:
        _fail("FILES_WRITE_FIELD", "edit text too large")
    eh = root.get("expectedHash")
    ev = root.get("expectedVersion")
    if eh is not None and (type(eh) is not str or not _HASH_RE.fullmatch(eh)):
        _fail("FILES_WRITE_FIELD", "expectedHash invalid")
    if ev is not None and (type(ev) is not str or not ev or len(ev) > 255 or not _ID_RE.fullmatch(ev)):
        _fail("FILES_WRITE_FIELD", "expectedVersion invalid")
    args = {"path": path, "oldText": old_text, "newText": new_text}
    if "expectedHash" in root: args["expectedHash"] = eh
    if "expectedVersion" in root: args["expectedVersion"] = ev
    _check_hash("edit", args, c["requestHash"])
    return EditCommand(path, old_text, new_text, eh, ev, ident, c["toolExecutionId"], c["toolCallId"], c["requestHash"], c["requestHashVersion"])


__all__ = ["FilesWriteContractError", "WriteCommand", "EditCommand", "parse_and_bind_files_write", "parse_and_bind_files_edit"]
