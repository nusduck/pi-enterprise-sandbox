"""Strict POST /internal/v1/files/read body contract (offline, no network)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from sandbox.app.domain.files_read_contract import (
    READ_MAX_BYTES_FIXED,
    FilesReadContractError,
    parse_and_bind_files_read,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.security.internal_auth import JS_MAX_SAFE_INTEGER

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
TE = "01K0G2PAV8FPMVC9QHJG7JPN5K"
TC = "tc-read-1"
TRACE = "0123456789abcdef0123456789abcdef"
PATH = "/home/sandbox/workspace/notes/a.txt"
FENCE = 7


def _hash_for(
    path: str = PATH,
    offset: int = 0,
    limit: int = 100,
    max_bytes: int = READ_MAX_BYTES_FIXED,
) -> str:
    return compute_tool_request_hash_v1(
        tool_name="read",
        args={
            "path": path,
            "offset": offset,
            "limit": limit,
            "maxBytes": max_bytes,
        },
    )["requestHash"]


def claims(**updates: Any) -> dict[str, Any]:
    h = _hash_for()
    out: dict[str, Any] = {
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "sandbox_session_id": SBX,
        "run_id": RUN,
        "tool_execution_id": TE,
        "tool_call_id": TC,
        "tool_name": "read",
        "scope": ["sandbox.files.read"],
        "request_hash": h,
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
    }
    out.update(updates)
    return out


def body_dict(**updates: Any) -> dict[str, Any]:
    h = _hash_for()
    out: dict[str, Any] = {
        "path": PATH,
        "offset": 0,
        "limit": 100,
        "maxBytes": READ_MAX_BYTES_FIXED,
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
        "toolExecutionId": TE,
        "toolCallId": TC,
        "requestHash": h,
        "requestHashVersion": 1,
    }
    # Shallow top-level updates; identity nested via identity=...
    for k, v in updates.items():
        if k == "identity" and isinstance(v, dict) and isinstance(out["identity"], dict):
            idn = dict(out["identity"])
            idn.update(v)
            out["identity"] = idn
        else:
            out[k] = v
    return out


def raw(obj: dict[str, Any] | str | bytes) -> bytes:
    if isinstance(obj, bytes):
        return obj
    if isinstance(obj, str):
        return obj.encode("utf-8")
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class TestHappyPath:
    def test_valid_body_binds(self) -> None:
        cmd = parse_and_bind_files_read(raw(body_dict()), claims())
        assert cmd.path == PATH
        assert cmd.offset == 0
        assert cmd.limit == 100
        assert cmd.max_bytes == READ_MAX_BYTES_FIXED
        assert cmd.tool_execution_id == TE
        assert cmd.org_id == ORG
        assert not hasattr(cmd, "workspace_id")
        assert "workspace" not in cmd.__dataclass_fields__

    def test_offset_above_50000_js_safe_ok(self) -> None:
        offset = 60_000
        h = _hash_for(offset=offset)
        b = body_dict(offset=offset, requestHash=h)
        c = claims(request_hash=h)
        cmd = parse_and_bind_files_read(raw(b), c)
        assert cmd.offset == 60_000

    def test_offset_at_js_safe_max(self) -> None:
        offset = JS_MAX_SAFE_INTEGER
        h = _hash_for(offset=offset)
        cmd = parse_and_bind_files_read(
            raw(body_dict(offset=offset, requestHash=h)),
            claims(request_hash=h),
        )
        assert cmd.offset == JS_MAX_SAFE_INTEGER


class TestJsonStrictness:
    def test_duplicate_key_rejected(self) -> None:
        h = _hash_for()
        text = (
            '{"path":"%s","path":"%s","offset":0,"limit":100,"maxBytes":%d,'
            '"identity":{"orgId":"%s","userId":"%s","conversationId":"%s",'
            '"agentSessionId":"%s","runId":"%s","sandboxSessionId":"%s",'
            '"traceId":"%s","executionFenceToken":%d},"toolExecutionId":"%s",'
            '"toolCallId":"%s","requestHash":"%s","requestHashVersion":1}'
            % (
                PATH,
                PATH,
                READ_MAX_BYTES_FIXED,
                ORG,
                USER,
                CONV,
                AGENT,
                RUN,
                SBX,
                TRACE,
                FENCE,
                TE,
                TC,
                h,
            )
        )
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(text), claims())
        assert ei.value.code == "FILES_READ_JSON"

    def test_nested_duplicate_key_rejected(self) -> None:
        h = _hash_for()
        text = (
            '{"path":"%s","offset":0,"limit":100,"maxBytes":%d,'
            '"identity":{"orgId":"%s","orgId":"%s","userId":"%s",'
            '"conversationId":"%s","agentSessionId":"%s","runId":"%s",'
            '"sandboxSessionId":"%s","traceId":"%s","executionFenceToken":%d},'
            '"toolExecutionId":"%s","toolCallId":"%s","requestHash":"%s",'
            '"requestHashVersion":1}'
            % (
                PATH,
                READ_MAX_BYTES_FIXED,
                ORG,
                ORG,
                USER,
                CONV,
                AGENT,
                RUN,
                SBX,
                TRACE,
                FENCE,
                TE,
                TC,
                h,
            )
        )
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(text), claims())
        assert ei.value.code == "FILES_READ_JSON"

    def test_invalid_utf8(self) -> None:
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(b"\xff\xfe{}", claims())
        assert ei.value.code == "FILES_READ_JSON"

    def test_nan_rejected(self) -> None:
        # Python json allows NaN by default; we reject via parse_constant.
        text = raw(body_dict()).decode("utf-8").replace('"offset":0', '"offset":NaN')
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(text.encode("utf-8"), claims())

    def test_float_rejected(self) -> None:
        h = _hash_for()
        # limit as float 1.0
        text = (
            '{"path":"%s","offset":0,"limit":1.0,"maxBytes":%d,'
            '"identity":{"orgId":"%s","userId":"%s","conversationId":"%s",'
            '"agentSessionId":"%s","runId":"%s","sandboxSessionId":"%s",'
            '"traceId":"%s","executionFenceToken":%d},"toolExecutionId":"%s",'
            '"toolCallId":"%s","requestHash":"%s","requestHashVersion":1}'
            % (
                PATH,
                READ_MAX_BYTES_FIXED,
                ORG,
                USER,
                CONV,
                AGENT,
                RUN,
                SBX,
                TRACE,
                FENCE,
                TE,
                TC,
                h,
            )
        )
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(text), claims())

    def test_trailing_content_rejected(self) -> None:
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(body_dict()) + b"\n{}", claims())


class TestSchemaAndTypes:
    def test_extra_root_key(self) -> None:
        b = body_dict()
        b["extra"] = 1
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(b), claims())
        assert ei.value.code == "FILES_READ_SCHEMA"

    def test_missing_root_key(self) -> None:
        b = body_dict()
        del b["limit"]
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(b), claims())

    def test_extra_identity_key(self) -> None:
        b = body_dict()
        b["identity"]["extra"] = "x"
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(b), claims())

    def test_bool_offset_rejected(self) -> None:
        b = body_dict(offset=True)
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(b), claims())

    def test_max_bytes_not_fixed_rejected(self) -> None:
        for bad in (1, 262143, 262145, 100):
            h = _hash_for(max_bytes=bad) if bad == 1 else _hash_for()
            b = body_dict(maxBytes=bad, requestHash=h if bad in (1,) else _hash_for())
            # maxBytes != 262144 fails before hash; use any hash
            b = body_dict(maxBytes=bad)
            with pytest.raises(FilesReadContractError):
                parse_and_bind_files_read(raw(b), claims())


class TestClaimMismatch:
    @pytest.mark.parametrize(
        "body_patch,claim_patch,field_hint",
        [
            ({"identity": {"orgId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}}, {}, "orgId"),
            ({"identity": {"userId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}}, {}, "userId"),
            (
                {"identity": {"conversationId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}},
                {},
                "conversationId",
            ),
            (
                {"identity": {"agentSessionId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}},
                {},
                "agentSessionId",
            ),
            ({"identity": {"runId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}}, {}, "runId"),
            (
                {"identity": {"sandboxSessionId": "01K0G2PAV8FPMVC9QHJG7JPNXX"}},
                {},
                "sandboxSessionId",
            ),
            ({"identity": {"traceId": "f" * 32}}, {}, "traceId"),
            ({"identity": {"executionFenceToken": 99}}, {}, "executionFenceToken"),
            ({"toolCallId": "other-tc"}, {}, "toolCallId"),
            (
                {"toolExecutionId": "01K0G2PAV8FPMVC9QHJG7JPNXX"},
                {},
                "toolExecutionId",
            ),
            ({"requestHashVersion": 2}, {}, "requestHashVersion"),
        ],
    )
    def test_each_claim_body_mismatch(
        self,
        body_patch: dict[str, Any],
        claim_patch: dict[str, Any],
        field_hint: str,
    ) -> None:
        b = body_dict(**body_patch)
        # Keep hash consistent with path args when not testing hash.
        if "requestHash" not in body_patch and "offset" not in body_patch:
            pass
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(b), claims(**claim_patch))
        assert ei.value.code in (
            "FILES_READ_CLAIM_MISMATCH",
            "FILES_READ_FIELD",
            "FILES_READ_HASH",
        )

    def test_semantic_hash_mismatch(self) -> None:
        # Body args say path notes/a.txt but requestHash is for another path.
        other = _hash_for(path="/home/sandbox/workspace/other.txt")
        b = body_dict(requestHash=other)
        c = claims(request_hash=other)
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(b), c)
        assert ei.value.code == "FILES_READ_HASH"

    def test_body_hash_differs_from_claim(self) -> None:
        other = "ab" * 32
        b = body_dict(requestHash=other)
        with pytest.raises(FilesReadContractError):
            parse_and_bind_files_read(raw(b), claims())


class TestPathCanonical:
    @pytest.mark.parametrize(
        "path",
        [
            "notes/a.txt",
            "/home/sandbox/workspace/notes/../a.txt",
            "/home/sandbox/workspace/./a.txt",
            "/home/sandbox/workspace//a.txt",
            "/home/sandbox/workspace/a.txt/",
            r"/home/sandbox/workspace\a.txt",
            "/home/sandbox/skill/x.md",
            "/tmp/x.txt",
            "/home/sandbox/workspace",
            "/etc/passwd",
        ],
    )
    def test_non_canonical_path_rejected(self, path: str) -> None:
        h = _hash_for(path=path)
        b = body_dict(path=path, requestHash=h)
        c = claims(request_hash=h)
        with pytest.raises(FilesReadContractError) as ei:
            parse_and_bind_files_read(raw(b), c)
        assert ei.value.code in ("FILES_READ_PATH", "FILES_READ_HASH", "FILES_READ_FIELD")
