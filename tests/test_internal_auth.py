"""Focused security tests for the strict Agent -> Sandbox token verifier."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

import pytest

from sandbox.security.internal_auth import (
    HEADER_SEGMENT_MAX_BYTES,
    JS_MAX_SAFE_INTEGER,
    PAYLOAD_SEGMENT_MAX_BYTES,
    SIGNATURE_SEGMENT_MAX_BYTES,
    TOKEN_MAX_BYTES,
    InternalAuthError,
    verify_internal_request,
    verify_internal_token,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
GOLDEN_FIXTURE_PATH = (
    REPO_ROOT
    / "packages"
    / "contracts"
    / "fixtures"
    / "agent-sandbox-internal-hmac-hs256-v1.json"
)

NOW = 2_000_000_000
KEY = b"k" * 32
KEYS = {"key-1": KEY}
PATH = "/internal/v1/sessions/sandbox_1/files/write"
BODY = b'{"path":"report.txt","content":"ok"}'


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def claims(**updates: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "token_version": 1,
        "iss": "agent-service",
        "aud": "sandbox-service",
        "sub": "agent-worker",
        "org_id": "org_1",
        "user_id": "user_1",
        "conversation_id": "conversation_1",
        "agent_session_id": "agent_session_1",
        "sandbox_session_id": "sandbox_1",
        "run_id": "run_1",
        "tool_execution_id": "tool_execution_1",
        "tool_call_id": "tool_call_1",
        "tool_name": "write",
        "scope": ["sandbox.files.write"],
        "request_hash": "a" * 64,
        "request_hash_version": 1,
        "execution_fence_token": 7,
        "trace_id": "0123456789abcdef0123456789abcdef",
        "htm": "POST",
        "htu": PATH,
        "body_sha256": hashlib.sha256(BODY).hexdigest(),
        "iat": NOW,
        "nbf": NOW,
        "exp": NOW + 60,
        "jti": "jti_1",
    }
    out.update(updates)
    return out


def token(
    payload: dict[str, Any] | None = None,
    *,
    header: dict[str, Any] | None = None,
    key: bytes = KEY,
    header_raw: bytes | None = None,
    payload_raw: bytes | None = None,
) -> str:
    header_obj = (
        {"alg": "HS256", "kid": "key-1", "typ": "sandbox-internal+jwt"}
        if header is None
        else header
    )
    header_segment = b64(
        header_raw
        if header_raw is not None
        else json.dumps(header_obj, separators=(",", ":")).encode()
    )
    payload_segment = b64(
        payload_raw
        if payload_raw is not None
        else json.dumps(
            claims() if payload is None else payload, separators=(",", ":")
        ).encode()
    )
    signing_input = f"{header_segment}.{payload_segment}".encode()
    signature = b64(hmac.new(key, signing_input, hashlib.sha256).digest())
    return f"{header_segment}.{payload_segment}.{signature}"


def verify(value: str, **updates: Any) -> dict[str, Any]:
    options = {
        "keys": KEYS,
        "expected_issuer": "agent-service",
        "expected_audience": "sandbox-service",
        "expected_subject": "agent-worker",
        "now": NOW,
    }
    options.update(updates)
    return verify_internal_token(value, **options)


def verify_request(value: str, **updates: Any) -> dict[str, Any]:
    options = {
        "keys": KEYS,
        "expected_issuer": "agent-service",
        "expected_audience": "sandbox-service",
        "expected_subject": "agent-worker",
        "method": "POST",
        "raw_path": PATH.encode("ascii"),
        "raw_query": b"",
        "raw_body": BODY,
        "expected_scope": "sandbox.files.write",
        "expected_tool_name": "write",
        "path_sandbox_session_id": "sandbox_1",
        "now": NOW,
    }
    options.update(updates)
    return verify_internal_request(value, **options)


def assert_code(code: str, call: Any) -> None:
    with pytest.raises(InternalAuthError) as error:
        call()
    assert error.value.code == code


def test_good_handcrafted_token_and_request_binding() -> None:
    value = token()
    assert verify(value)["run_id"] == "run_1"
    assert verify_request(value)["tool_execution_id"] == "tool_execution_1"


def test_pre_run_session_ensure_is_the_only_null_run_fence_profile() -> None:
    session_path = b"/internal/v1/sessions/ensure"
    body = b'{"workspaceId":"01K0G2PAV8FPMVC9QHJG7JPN55"}'
    base = claims(
        run_id=None,
        execution_fence_token=None,
        tool_name="session.ensure",
        scope=["sandbox.sessions.ensure"],
        tool_execution_id="agent_session_1:session.ensure",
        tool_call_id="agent_session_1:session.ensure",
        htu=session_path.decode("ascii"),
        request_hash=hashlib.sha256(body).hexdigest(),
        body_sha256=hashlib.sha256(body).hexdigest(),
    )
    verified = verify_internal_request(
        token(base),
        keys=KEYS,
        expected_issuer="agent-service",
        expected_audience="sandbox-service",
        expected_subject="agent-worker",
        method="POST",
        raw_path=session_path,
        raw_query=b"",
        raw_body=body,
        expected_scope="sandbox.sessions.ensure",
        expected_tool_name="session.ensure",
        now=NOW,
    )
    assert verified["run_id"] is None
    assert verified["execution_fence_token"] is None

    for invalid in (
        {**base, "tool_name": "write"},
        {**base, "scope": ["sandbox.files.write"]},
        {**base, "htu": "/internal/v1/sessions/not-ensure"},
        {**base, "run_id": "run_1"},
        {**base, "execution_fence_token": 1},
    ):
        assert_code(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            lambda invalid=invalid: verify(token(invalid)),
        )


@pytest.mark.parametrize(
    ("header", "code"),
    [
        ({"alg": "none", "kid": "key-1", "typ": "sandbox-internal+jwt"}, "INTERNAL_TOKEN_ALGORITHM"),
        ({"alg": "RS256", "kid": "key-1", "typ": "sandbox-internal+jwt"}, "INTERNAL_TOKEN_ALGORITHM"),
        ({"alg": "HS256", "kid": "missing", "typ": "sandbox-internal+jwt"}, "INTERNAL_TOKEN_UNKNOWN_KID"),
        ({"alg": "HS256", "kid": "key-1", "typ": "JWT"}, "INTERNAL_TOKEN_TYPE"),
        ({"alg": "HS256", "kid": "key-1", "typ": "sandbox-internal+jwt", "x": 1}, "INTERNAL_TOKEN_HEADER_SCHEMA"),
    ],
)
def test_header_algorithm_kid_type_and_exact_schema(
    header: dict[str, Any], code: str
) -> None:
    assert_code(code, lambda: verify(token(header=header)))


def test_bad_signature_and_weak_key_fail() -> None:
    value = token()
    bad = value[:-1] + ("A" if value[-1] != "A" else "B")
    assert_code("INTERNAL_TOKEN_SIGNATURE", lambda: verify(bad))
    assert_code(
        "INTERNAL_TOKEN_KEY_CONFIG",
        lambda: verify(value, keys={"key-1": b"short"}),
    )
    assert_code(
        "INTERNAL_TOKEN_KEY_CONFIG",
        lambda: verify(value, keys={"key-1": KEY, "future-key": b"short"}),
    )


@pytest.mark.parametrize(
    "raw",
    [
        b'{"alg":"HS256","kid":"key-1","kid":"key-1","typ":"sandbox-internal+jwt"}',
        b'{"alg":"HS256","kid":"key-1","typ":"sandbox-internal+jwt","x":NaN}',
    ],
)
def test_header_duplicate_keys_and_non_finite_json_reject(raw: bytes) -> None:
    assert_code("INTERNAL_TOKEN_JSON", lambda: verify(token(header_raw=raw)))


def test_payload_duplicate_keys_and_non_finite_json_reject() -> None:
    base = json.dumps(claims(), separators=(",", ":"))
    duplicate = base[:-1] + ',"iss":"agent-service"}'
    assert_code(
        "INTERNAL_TOKEN_JSON",
        lambda: verify(token(payload_raw=duplicate.encode())),
    )
    infinite = base.replace(f'"iat":{NOW}', '"iat":Infinity')
    assert_code(
        "INTERNAL_TOKEN_JSON",
        lambda: verify(token(payload_raw=infinite.encode())),
    )


@pytest.mark.parametrize(
    ("mutate", "expected_code"),
    [
        (lambda value: value + ".extra", "INTERNAL_TOKEN_FORMAT"),
        (lambda value: value.rsplit(".", 1)[0], "INTERNAL_TOKEN_FORMAT"),
        (lambda value: value.replace(".", "=", 1), "INTERNAL_TOKEN_FORMAT"),
        (
            lambda value: "." + value.split(".", 1)[1],
            "INTERNAL_TOKEN_SEGMENT_SIZE",
        ),
    ],
)
def test_compact_format_and_padding_reject(
    mutate: Any, expected_code: str
) -> None:
    assert_code(
        expected_code,
        lambda: verify(mutate(token())),
    )


def test_padding_inside_each_compact_segment_rejects() -> None:
    parts = token().split(".")
    for index in range(3):
        mutated = list(parts)
        mutated[index] += "="
        assert_code(
            "INTERNAL_TOKEN_BASE64",
            lambda mutated=mutated: verify(".".join(mutated)),
        )


def test_noncanonical_base64url_rejects_unused_bits() -> None:
    value = token()
    header_segment, payload_segment, signature_segment = value.split(".")
    # The 32-byte HS256 signature has one byte of unused low bits in its last
    # base64url character.  Flip only those bits; permissive decoders produce
    # the same bytes, while canonical round-trip validation must reject it.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    index = alphabet.index(signature_segment[-1])
    replacement = alphabet[index ^ 1]
    noncanonical = (
        f"{header_segment}.{payload_segment}.{signature_segment[:-1]}{replacement}"
    )
    assert_code("INTERNAL_TOKEN_BASE64", lambda: verify(noncanonical))


def test_token_and_segment_caps_reject_before_json_or_signature() -> None:
    assert_code(
        "INTERNAL_TOKEN_SIZE",
        lambda: verify("A" * (TOKEN_MAX_BYTES + 1)),
    )
    huge_header = "A" * (HEADER_SEGMENT_MAX_BYTES + 1)
    assert_code(
        "INTERNAL_TOKEN_SEGMENT_SIZE",
        lambda: verify(f"{huge_header}.e30.AAAA"),
    )
    huge_payload = "A" * (PAYLOAD_SEGMENT_MAX_BYTES + 1)
    assert_code(
        "INTERNAL_TOKEN_SEGMENT_SIZE",
        lambda: verify(f"e30.{huge_payload}.AAAA"),
    )
    huge_signature = "A" * (SIGNATURE_SEGMENT_MAX_BYTES + 1)
    assert_code(
        "INTERNAL_TOKEN_SEGMENT_SIZE",
        lambda: verify(f"e30.e30.{huge_signature}"),
    )


def test_extra_and_missing_claims_reject() -> None:
    extra = claims(extra=True)
    assert_code("INTERNAL_TOKEN_CLAIMS_SCHEMA", lambda: verify(token(extra)))
    missing = claims()
    del missing["jti"]
    assert_code("INTERNAL_TOKEN_CLAIMS_SCHEMA", lambda: verify(token(missing)))


@pytest.mark.parametrize("value", [True, 1.0, "1"])
@pytest.mark.parametrize(
    "name",
    [
        "token_version",
        "request_hash_version",
        "execution_fence_token",
        "iat",
        "nbf",
        "exp",
    ],
)
def test_numeric_claims_reject_bool_float_and_string(name: str, value: Any) -> None:
    assert_code(
        "INTERNAL_TOKEN_CLAIM_VALUE",
        lambda: verify(token(claims(**{name: value}))),
    )


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("execution_fence_token", JS_MAX_SAFE_INTEGER + 1),
        ("iat", JS_MAX_SAFE_INTEGER + 1),
        ("nbf", JS_MAX_SAFE_INTEGER + 1),
        ("exp", JS_MAX_SAFE_INTEGER + 1),
        ("execution_fence_token", 0),
    ],
)
def test_numeric_claims_reject_unsafe_or_nonpositive(name: str, value: Any) -> None:
    assert_code(
        "INTERNAL_TOKEN_CLAIM_VALUE",
        lambda: verify(token(claims(**{name: value}))),
    )


def test_ttl_nbf_and_leeway_boundaries() -> None:
    assert_code(
        "INTERNAL_TOKEN_TIME",
        lambda: verify(token(claims(exp=NOW))),
    )
    assert_code(
        "INTERNAL_TOKEN_TIME",
        lambda: verify(token(claims(exp=NOW + 121))),
    )
    assert_code(
        "INTERNAL_TOKEN_TIME",
        lambda: verify(token(claims(nbf=NOW + 1))),
    )

    future = token(claims(iat=NOW + 5, nbf=NOW + 5, exp=NOW + 65))
    assert_code("INTERNAL_TOKEN_NOT_YET_VALID", lambda: verify(future, leeway=4))
    assert verify(future, leeway=5)["iat"] == NOW + 5

    expired = token(claims(iat=NOW - 60, nbf=NOW - 60, exp=NOW))
    assert_code("INTERNAL_TOKEN_EXPIRED", lambda: verify(expired))
    assert verify(expired, leeway=1)["exp"] == NOW
    assert_code(
        "INTERNAL_TOKEN_EXPIRED",
        lambda: verify(expired, leeway=1, now=NOW + 1),
    )
    for bad in (-1, 6, True, 1.0):
        assert_code(
            "INTERNAL_TOKEN_TIME_CONFIG",
            lambda bad=bad: verify(token(), leeway=bad),
        )


@pytest.mark.parametrize(
    ("option", "value", "code"),
    [
        ("expected_issuer", "other", "INTERNAL_TOKEN_ISSUER"),
        ("expected_audience", "other", "INTERNAL_TOKEN_AUDIENCE"),
        ("expected_subject", "other", "INTERNAL_TOKEN_SUBJECT"),
    ],
)
def test_wrong_expected_issuer_audience_subject(
    option: str, value: str, code: str
) -> None:
    assert_code(code, lambda: verify(token(), **{option: value}))


@pytest.mark.parametrize(
    ("claim", "value"),
    [
        ("scope", "sandbox.files.write"),
        ("scope", []),
        ("scope", ["sandbox.files.write", "sandbox.files.read"]),
        ("scope", [1]),
        ("tool_name", ""),
        ("request_hash", "A" * 64),
        ("body_sha256", "0" * 63),
        ("htm", "GET"),
        ("htu", "internal/relative"),
        ("htu", PATH + "?x=1"),
        ("htu", PATH + "#x"),
        ("org_id", "x" * 256),
    ],
)
def test_strict_claim_values(claim: str, value: Any) -> None:
    assert_code(
        "INTERNAL_TOKEN_CLAIM_VALUE",
        lambda: verify(token(claims(**{claim: value}))),
    )


@pytest.mark.parametrize(
    ("updates", "code"),
    [
        ({"method": "GET"}, "INTERNAL_REQUEST_METHOD"),
        ({"method": "post"}, "INTERNAL_REQUEST_METHOD"),
        ({"raw_path": (PATH + "/other").encode()}, "INTERNAL_REQUEST_PATH"),
        ({"raw_path": (PATH + "?x=1").encode()}, "INTERNAL_REQUEST_PATH"),
        ({"raw_path": PATH}, "INTERNAL_REQUEST_PATH"),
        ({"raw_path": b"/internal/\xff"}, "INTERNAL_REQUEST_PATH"),
        ({"raw_query": b"x=1"}, "INTERNAL_REQUEST_QUERY"),
        ({"raw_query": ""}, "INTERNAL_REQUEST_QUERY"),
        ({"raw_body": BODY + b" "}, "INTERNAL_REQUEST_BODY"),
        ({"raw_body": bytearray(BODY)}, "INTERNAL_REQUEST_BODY"),
        ({"expected_scope": "sandbox.files.read"}, "INTERNAL_REQUEST_SCOPE"),
        ({"expected_tool_name": "read"}, "INTERNAL_REQUEST_TOOL"),
        ({"path_sandbox_session_id": "sandbox_2"}, "INTERNAL_REQUEST_SESSION"),
    ],
)
def test_request_binding_rejects_mutations(
    updates: dict[str, Any], code: str
) -> None:
    assert_code(code, lambda: verify_request(token(), **updates))


def test_body_hash_uses_exact_raw_bytes_without_json_reserialization() -> None:
    equivalent_json = b'{"content":"ok","path":"report.txt"}'
    assert json.loads(equivalent_json) == json.loads(BODY)
    assert_code(
        "INTERNAL_REQUEST_BODY",
        lambda: verify_request(token(), raw_body=equivalent_json),
    )


def _load_golden_fixture() -> dict[str, Any]:
    with GOLDEN_FIXTURE_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _decode_fixture_key(fixture: dict[str, Any]) -> dict[str, bytes]:
    encoded = fixture["key"]["keyBase64url"]
    assert type(encoded) is str
    assert all(ch not in encoded for ch in "+/=")
    raw = base64.urlsafe_b64decode(encoded + ("=" * (-len(encoded) % 4)))
    assert len(raw) >= 32
    return {fixture["key"]["kid"]: raw}


def _token_for_invalid_row(
    fixture: dict[str, Any], row: dict[str, Any]
) -> str:
    if "token" in row:
        return row["token"]
    ref = row["tokenRef"]
    for positive in fixture["valid"]:
        if positive["id"] == ref:
            return positive["expectedToken"]
    raise AssertionError(f"missing tokenRef {ref}")


def test_cross_language_golden_fixture_metadata() -> None:
    fixture = _load_golden_fixture()
    assert fixture["version"] == 1
    assert fixture["contract"] == "agent-sandbox-internal-hmac-hs256-v1"
    assert fixture["subject"] == "agent-worker"
    assert len(fixture["valid"]) >= 1
    assert len(fixture["invalid"]) >= 1


@pytest.mark.parametrize(
    "row_id",
    [
        "deterministic-issue-and-verify",
    ],
)
def test_cross_language_golden_verify_token_and_request(row_id: str) -> None:
    fixture = _load_golden_fixture()
    row = next(item for item in fixture["valid"] if item["id"] == row_id)
    keys = _decode_fixture_key(fixture)
    request = row["request"]

    claims = verify_internal_token(
        row["expectedToken"],
        keys=keys,
        expected_issuer=fixture["issuer"],
        expected_audience=fixture["audience"],
        expected_subject=fixture["subject"],
        now=fixture["now"],
    )
    assert claims == row["expectedClaims"]

    bound = verify_internal_request(
        row["expectedToken"],
        keys=keys,
        expected_issuer=fixture["issuer"],
        expected_audience=fixture["audience"],
        expected_subject=fixture["subject"],
        method=request["method"],
        raw_path=request["rawPath"].encode("ascii"),
        raw_query=request["rawQuery"].encode("ascii"),
        raw_body=request["rawBodyUtf8"].encode("utf-8"),
        expected_scope=request["expectedScope"],
        expected_tool_name=request["expectedToolName"],
        path_sandbox_session_id=request["pathSandboxSessionId"],
        now=fixture["now"],
    )
    assert bound["run_id"] == row["expectedClaims"]["run_id"]
    assert bound["scope"] == ["execute:command"]


@pytest.mark.parametrize(
    "row_id",
    [
        "tampered-signature",
        "body-mismatch",
    ],
)
def test_cross_language_golden_negative_vectors(row_id: str) -> None:
    fixture = _load_golden_fixture()
    row = next(item for item in fixture["invalid"] if item["id"] == row_id)
    keys = _decode_fixture_key(fixture)
    token_value = _token_for_invalid_row(fixture, row)

    if row["kind"] == "signature":
        assert_code(
            row["pythonErrorCode"],
            lambda: verify_internal_token(
                token_value,
                keys=keys,
                expected_issuer=fixture["issuer"],
                expected_audience=fixture["audience"],
                expected_subject=fixture["subject"],
                now=fixture["now"],
            ),
        )
        return

    if row["kind"] == "body":
        positive = next(
            item for item in fixture["valid"] if item["id"] == row["tokenRef"]
        )
        request = positive["request"]
        assert_code(
            row["pythonErrorCode"],
            lambda: verify_internal_request(
                token_value,
                keys=keys,
                expected_issuer=fixture["issuer"],
                expected_audience=fixture["audience"],
                expected_subject=fixture["subject"],
                method=request["method"],
                raw_path=request["rawPath"].encode("ascii"),
                raw_query=request["rawQuery"].encode("ascii"),
                raw_body=row["rawBodyUtf8"].encode("utf-8"),
                expected_scope=request["expectedScope"],
                expected_tool_name=request["expectedToolName"],
                path_sandbox_session_id=request["pathSandboxSessionId"],
                now=fixture["now"],
            ),
        )
        return

    raise AssertionError(f"unknown invalid kind: {row['kind']}")
