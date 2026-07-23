"""Sandbox tool request-hash v1 (PR-07B batch 2A).

Strict cross-language contract shared with Node
``agent/src/domain/tool/tool-request-hash.js`` and golden fixture
``tests/fixtures/contracts/sandbox-tool-request-hash-v1.json``.

Envelope: ``{"v": 1, "tool": <toolName>, "args": <normalized args>}``
Hash: SHA-256 lowercase hex of compact UTF-8 JSON with ASCII key byte-order sort.

Fail-closed: rejects float (including 1.0), unsafe int, bytes, custom objects,
cycles, non-ASCII keys, lone surrogates. Does NOT use ``default=str``.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any, Mapping, MutableSet

TOOL_REQUEST_HASH_VERSION = 1
TOOL_NAME_MAX_LEN = 255

# Printable ASCII keys only (space through tilde).
_ASCII_KEY_RE = re.compile(r"^[\x20-\x7E]+$")

# JS Number.MAX_SAFE_INTEGER / MIN_SAFE_INTEGER
_JS_MAX_SAFE = 9_007_199_254_740_991
_JS_MIN_SAFE = -9_007_199_254_740_991

# Private sentinel: omitted args default to {} (Node: args === undefined → {}).
# Explicit args=None must canonicalize as JSON null (Node: args: null → null).
_ARGS_OMITTED: Any = object()


class ToolRequestHashError(ValueError):
    """Invalid input for request-hash v1 (fail closed)."""

    def __init__(self, message: str, code: str = "TOOL_REQUEST_HASH_INVALID") -> None:
        super().__init__(message)
        self.code = code


def _has_lone_surrogate(s: str) -> bool:
    """Return True if *s* contains any Unicode surrogate code point.

    Python str uses code points (not UTF-16 units), so any value in
    U+D800..U+DFFF is illegal for this contract (including pairs).
    """
    for ch in s:
        o = ord(ch)
        if 0xD800 <= o <= 0xDFFF:
            return True
    return False


def assert_tool_request_tool_name(tool_name: Any) -> str:
    if not isinstance(tool_name, str):
        raise ToolRequestHashError(
            "toolName must be a non-empty already-trimmed string",
            "TOOL_REQUEST_HASH_BAD_TOOL_NAME",
        )
    if not tool_name or tool_name != tool_name.strip():
        raise ToolRequestHashError(
            "toolName must be a non-empty already-trimmed string",
            "TOOL_REQUEST_HASH_BAD_TOOL_NAME",
        )
    if len(tool_name) > TOOL_NAME_MAX_LEN:
        raise ToolRequestHashError(
            f"toolName exceeds max length {TOOL_NAME_MAX_LEN}",
            "TOOL_REQUEST_HASH_BAD_TOOL_NAME",
        )
    if _has_lone_surrogate(tool_name):
        raise ToolRequestHashError(
            "toolName contains lone Unicode surrogate",
            "TOOL_REQUEST_HASH_BAD_TOOL_NAME",
        )
    return tool_name


def _json_string(s: str) -> str:
    """JSON-encode a string (ensure_ascii=False; no lone surrogates)."""
    if _has_lone_surrogate(s):
        raise ToolRequestHashError(
            "string contains lone Unicode surrogate",
            "TOOL_REQUEST_HASH_LONE_SURROGATE",
        )
    # standard json.dumps escapes controls; keep Unicode as UTF-8 in output
    # via ensure_ascii=False so composed/decomposed code points are preserved.
    return json.dumps(s, ensure_ascii=False, separators=(",", ":"))


def _canonicalize_value(value: Any, stack: MutableSet[int]) -> str:
    if value is None:
        return "null"

    if isinstance(value, bool):
        # Must precede int — bool is a subclass of int in Python.
        return "true" if value else "false"

    if isinstance(value, str):
        return _json_string(value)

    if isinstance(value, float):
        # Reject all floats, including 1.0 and nan/inf.
        raise ToolRequestHashError(
            "float is not allowed in request-hash args",
            "TOOL_REQUEST_HASH_FLOAT",
        )

    if isinstance(value, int):
        if value > _JS_MAX_SAFE or value < _JS_MIN_SAFE:
            raise ToolRequestHashError(
                "integer outside JS safe integer range",
                "TOOL_REQUEST_HASH_UNSAFE_INT",
            )
        return str(value)

    if isinstance(value, (bytes, bytearray, memoryview)):
        raise ToolRequestHashError(
            "Buffer/bytes are not allowed",
            "TOOL_REQUEST_HASH_BAD_TYPE",
        )

    if isinstance(value, list):
        obj_id = id(value)
        if obj_id in stack:
            raise ToolRequestHashError(
                "cyclic structure is not allowed",
                "TOOL_REQUEST_HASH_CYCLE",
            )
        stack.add(obj_id)
        try:
            parts = [_canonicalize_value(v, stack) for v in value]
            return "[" + ",".join(parts) + "]"
        finally:
            stack.discard(obj_id)

    if isinstance(value, tuple):
        raise ToolRequestHashError(
            "tuple is not allowed (use list)",
            "TOOL_REQUEST_HASH_BAD_TYPE",
        )

    if isinstance(value, dict):
        obj_id = id(value)
        if obj_id in stack:
            raise ToolRequestHashError(
                "cyclic structure is not allowed",
                "TOOL_REQUEST_HASH_CYCLE",
            )
        # Only plain dict — Mapping subclasses with non-str keys rejected below.
        if type(value) is not dict:
            raise ToolRequestHashError(
                "custom objects are not allowed",
                "TOOL_REQUEST_HASH_BAD_TYPE",
            )
        stack.add(obj_id)
        try:
            keys: list[str] = []
            for k in value.keys():
                if not isinstance(k, str):
                    raise ToolRequestHashError(
                        "object keys must be ASCII printable strings",
                        "TOOL_REQUEST_HASH_NON_ASCII_KEY",
                    )
                if not _ASCII_KEY_RE.match(k):
                    raise ToolRequestHashError(
                        "object keys must be ASCII printable strings",
                        "TOOL_REQUEST_HASH_NON_ASCII_KEY",
                    )
                keys.append(k)
            keys.sort()  # ASCII / UTF-8 byte order for pure ASCII keys
            parts = [
                f"{_json_string(k)}:{_canonicalize_value(value[k], stack)}"
                for k in keys
            ]
            return "{" + ",".join(parts) + "}"
        finally:
            stack.discard(obj_id)

    # Reject math.nan via float already; anything else (set, custom, complex…)
    raise ToolRequestHashError(
        f"unsupported type {type(value).__name__}",
        "TOOL_REQUEST_HASH_BAD_TYPE",
    )


def canonical_tool_request_json_v1(
    *,
    tool_name: str,
    args: Any = _ARGS_OMITTED,
) -> str:
    """Return compact canonical envelope JSON for request-hash v1.

    Omitted ``args`` defaults to ``{}``. Explicit ``args=None`` is JSON null.
    """
    name = assert_tool_request_tool_name(tool_name)
    payload = {} if args is _ARGS_OMITTED else args
    stack: set[int] = set()
    args_json = _canonicalize_value(payload, stack)
    # Envelope keys sorted: args, tool, v
    return (
        '{"args":'
        + args_json
        + ',"tool":'
        + _json_string(name)
        + ',"v":'
        + str(TOOL_REQUEST_HASH_VERSION)
        + "}"
    )


def compute_tool_request_hash_v1(
    *,
    tool_name: str,
    args: Any = _ARGS_OMITTED,
) -> dict[str, Any]:
    """Return ``{requestHash, requestHashVersion, canonicalJson}``."""
    canonical_json = canonical_tool_request_json_v1(tool_name=tool_name, args=args)
    request_hash = hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()
    return {
        "requestHash": request_hash,
        "requestHashVersion": TOOL_REQUEST_HASH_VERSION,
        "canonicalJson": canonical_json,
    }
