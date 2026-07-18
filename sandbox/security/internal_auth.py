"""Strict authentication for the Agent -> Sandbox internal HTTP plane.

This module is deliberately independent from :mod:`sandbox.auth`, which
authenticates end users on the legacy public surface.  Internal tokens are
short-lived, request-bound HS256 JWTs.  The implementation uses only the
Python standard library so verification cannot silently inherit permissive
defaults from a general-purpose JWT package.

The verifier is intentionally fail-closed:

* the compact token, each segment, header, and claim set are bounded;
* base64url must be canonical and unpadded;
* JSON duplicate keys and non-finite numbers are rejected;
* the header and claims use exact schemas;
* a ``kid`` selects exactly one injected key; there is no fallback key;
* the signature, time window, request method/path/body, tool, and scope are
  all bound before a caller may dispatch work.

Routes and replay protection are separate concerns and are not implemented
here.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import time
from collections.abc import Mapping
from typing import Any

TOKEN_MAX_BYTES = 16_384
HEADER_SEGMENT_MAX_BYTES = 512
PAYLOAD_SEGMENT_MAX_BYTES = 12_288
SIGNATURE_SEGMENT_MAX_BYTES = 128

KEY_ID_MAX_LENGTH = 128
IDENTIFIER_MAX_LENGTH = 255
PATH_MAX_LENGTH = 2_048
MAX_TOKEN_TTL_SECONDS = 120
MAX_CLOCK_LEEWAY_SECONDS = 5
JS_MAX_SAFE_INTEGER = 9_007_199_254_740_991

INTERNAL_TOKEN_TYPE = "sandbox-internal+jwt"
INTERNAL_TOKEN_VERSION = 1
REQUEST_HASH_VERSION = 1
INTERNAL_HTTP_METHOD = "POST"

_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_LOWER_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_VISIBLE_ASCII_RE = re.compile(r"^[\x21-\x7e]+$")

_HEADER_KEYS = frozenset({"alg", "kid", "typ"})
_CLAIM_KEYS = frozenset(
    {
        "token_version",
        "iss",
        "aud",
        "sub",
        "org_id",
        "user_id",
        "conversation_id",
        "agent_session_id",
        "sandbox_session_id",
        "run_id",
        "tool_execution_id",
        "tool_call_id",
        "tool_name",
        "scope",
        "request_hash",
        "request_hash_version",
        "execution_fence_token",
        "trace_id",
        "htm",
        "htu",
        "body_sha256",
        "iat",
        "nbf",
        "exp",
        "jti",
    }
)


class InternalAuthError(ValueError):
    """Typed, non-secret-bearing internal-authentication failure.

    ``code`` is stable enough for a later HTTP adapter to map failures without
    parsing exception messages.  Callers must not expose ``message`` to
    untrusted clients.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise InternalAuthError(code, message)


def _reject_json_constant(value: str) -> None:
    _fail("INTERNAL_TOKEN_JSON", f"non-finite JSON number is forbidden: {value}")


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            _fail("INTERNAL_TOKEN_JSON", "duplicate JSON object key")
        out[key] = value
    return out


def _decode_json_object(raw: bytes, *, label: str) -> dict[str, Any]:
    try:
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except InternalAuthError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
        _fail("INTERNAL_TOKEN_JSON", f"{label} is not strict UTF-8 JSON")
    if type(value) is not dict:
        _fail("INTERNAL_TOKEN_JSON", f"{label} must be a JSON object")
    return value


def _decode_segment(segment: str, *, label: str, max_bytes: int) -> bytes:
    if not segment or len(segment) > max_bytes:
        _fail(
            "INTERNAL_TOKEN_SEGMENT_SIZE",
            f"{label} segment is empty or exceeds its encoded size limit",
        )
    if not _BASE64URL_RE.fullmatch(segment):
        _fail(
            "INTERNAL_TOKEN_BASE64",
            f"{label} must use unpadded base64url characters only",
        )
    # A base64 string with length mod 4 == 1 cannot encode whole bytes.
    if len(segment) % 4 == 1:
        _fail("INTERNAL_TOKEN_BASE64", f"{label} has an invalid base64url length")
    try:
        raw = base64.b64decode(
            segment + ("=" * (-len(segment) % 4)),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, TypeError):
        _fail("INTERNAL_TOKEN_BASE64", f"{label} is invalid base64url")
    canonical = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    if not hmac.compare_digest(canonical, segment):
        _fail("INTERNAL_TOKEN_BASE64", f"{label} is not canonical base64url")
    return raw


def _require_exact_keys(
    value: Mapping[str, Any], expected: frozenset[str], *, label: str
) -> None:
    actual = frozenset(value)
    if actual != expected:
        _fail(
            f"INTERNAL_TOKEN_{label.upper()}_SCHEMA",
            f"{label} has missing or unexpected keys",
        )


def _require_visible_ascii(
    value: Any,
    *,
    name: str,
    max_length: int = IDENTIFIER_MAX_LENGTH,
) -> str:
    if (
        type(value) is not str
        or not value
        or len(value) > max_length
        or not _VISIBLE_ASCII_RE.fullmatch(value)
    ):
        _fail(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            f"{name} must be non-empty bounded visible ASCII",
        )
    return value


def _require_positive_safe_int(value: Any, *, name: str) -> int:
    if type(value) is not int or value <= 0 or value > JS_MAX_SAFE_INTEGER:
        _fail(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            f"{name} must be a positive JavaScript-safe integer",
        )
    return value


def _require_version(value: Any, *, name: str) -> int:
    if type(value) is not int or value != 1:
        _fail("INTERNAL_TOKEN_CLAIM_VALUE", f"{name} must be integer 1")
    return value


def _require_lower_sha256(value: Any, *, name: str) -> str:
    if type(value) is not str or not _LOWER_SHA256_RE.fullmatch(value):
        _fail(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            f"{name} must be a lowercase SHA-256 hex digest",
        )
    return value


def _require_raw_absolute_path(value: Any, *, name: str) -> str:
    path = _require_visible_ascii(value, name=name, max_length=PATH_MAX_LENGTH)
    if not path.startswith("/") or "?" in path or "#" in path:
        _fail(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            f"{name} must be an absolute raw ASCII path without query or fragment",
        )
    return path


def _validate_header(header: dict[str, Any]) -> str:
    _require_exact_keys(header, _HEADER_KEYS, label="header")
    if header["alg"] != "HS256":
        _fail("INTERNAL_TOKEN_ALGORITHM", "only HS256 is accepted")
    if header["typ"] != INTERNAL_TOKEN_TYPE:
        _fail("INTERNAL_TOKEN_TYPE", "unexpected internal token type")
    return _require_visible_ascii(
        header["kid"], name="kid", max_length=KEY_ID_MAX_LENGTH
    )


def _validate_keyring(keys: Mapping[str, bytes], kid: str) -> bytes:
    if not isinstance(keys, Mapping):
        _fail("INTERNAL_TOKEN_KEY_CONFIG", "keyring must be a mapping")
    for configured_kid, configured_key in keys.items():
        if (
            type(configured_kid) is not str
            or not configured_kid
            or len(configured_kid) > KEY_ID_MAX_LENGTH
            or not _VISIBLE_ASCII_RE.fullmatch(configured_kid)
            or type(configured_key) is not bytes
            or len(configured_key) < 32
        ):
            _fail(
                "INTERNAL_TOKEN_KEY_CONFIG",
                "every key id and signing key must satisfy the keyring contract",
            )
    if kid not in keys:
        _fail("INTERNAL_TOKEN_UNKNOWN_KID", "unknown signing key id")
    key = keys[kid]
    return key


def _validate_claims(
    claims: dict[str, Any],
    *,
    expected_issuer: str,
    expected_audience: str,
    expected_subject: str,
    now: int,
    leeway: int,
) -> None:
    _require_exact_keys(claims, _CLAIM_KEYS, label="claims")

    _require_version(claims["token_version"], name="token_version")
    _require_version(claims["request_hash_version"], name="request_hash_version")

    string_claims = (
        "iss",
        "aud",
        "sub",
        "org_id",
        "user_id",
        "conversation_id",
        "agent_session_id",
        "sandbox_session_id",
        "run_id",
        "tool_execution_id",
        "tool_call_id",
        "tool_name",
        "trace_id",
        "jti",
    )
    for name in string_claims:
        _require_visible_ascii(claims[name], name=name)
    scope = claims["scope"]
    if type(scope) is not list or len(scope) != 1:
        _fail(
            "INTERNAL_TOKEN_CLAIM_VALUE",
            "scope must be an array containing exactly one string",
        )
    _require_visible_ascii(scope[0], name="scope[0]")

    _require_lower_sha256(claims["request_hash"], name="request_hash")
    _require_lower_sha256(claims["body_sha256"], name="body_sha256")
    _require_positive_safe_int(
        claims["execution_fence_token"], name="execution_fence_token"
    )
    iat = _require_positive_safe_int(claims["iat"], name="iat")
    nbf = _require_positive_safe_int(claims["nbf"], name="nbf")
    exp = _require_positive_safe_int(claims["exp"], name="exp")

    if claims["htm"] != INTERNAL_HTTP_METHOD:
        _fail("INTERNAL_TOKEN_CLAIM_VALUE", "htm must be POST")
    _require_raw_absolute_path(claims["htu"], name="htu")

    if claims["iss"] != expected_issuer:
        _fail("INTERNAL_TOKEN_ISSUER", "issuer mismatch")
    if claims["aud"] != expected_audience:
        _fail("INTERNAL_TOKEN_AUDIENCE", "audience mismatch")
    if claims["sub"] != expected_subject:
        _fail("INTERNAL_TOKEN_SUBJECT", "subject mismatch")

    if nbf != iat:
        _fail("INTERNAL_TOKEN_TIME", "nbf must equal iat")
    ttl = exp - iat
    if ttl <= 0 or ttl > MAX_TOKEN_TTL_SECONDS:
        _fail("INTERNAL_TOKEN_TIME", "token TTL is outside the accepted range")
    if now + leeway < nbf:
        _fail("INTERNAL_TOKEN_NOT_YET_VALID", "token is not yet valid")
    # exp is exclusive.  Leeway extends validity up to, but not including,
    # exp + leeway.
    if now >= exp + leeway:
        _fail("INTERNAL_TOKEN_EXPIRED", "token has expired")


def verify_internal_token(
    token: str,
    *,
    keys: Mapping[str, bytes],
    expected_issuer: str,
    expected_audience: str,
    expected_subject: str,
    now: int | None = None,
    leeway: int = 0,
) -> dict[str, Any]:
    """Verify and return a strict internal-token claim dictionary.

    ``keys`` is a ``kid -> bytes`` mapping.  Keys shorter than 256 bits are
    rejected.  ``now`` exists for deterministic tests and must be an actual
    integer when supplied.  ``leeway`` is deliberately capped at five seconds.
    """

    if type(token) is not str:
        _fail("INTERNAL_TOKEN_FORMAT", "token must be text")
    try:
        token_bytes = token.encode("ascii", errors="strict")
    except UnicodeEncodeError:
        _fail("INTERNAL_TOKEN_FORMAT", "token must be ASCII")
    if not token_bytes or len(token_bytes) > TOKEN_MAX_BYTES:
        _fail("INTERNAL_TOKEN_SIZE", "token is empty or exceeds its size limit")

    segments = token.split(".")
    if len(segments) != 3:
        _fail("INTERNAL_TOKEN_FORMAT", "token must have exactly three segments")
    header_segment, payload_segment, signature_segment = segments

    header_raw = _decode_segment(
        header_segment, label="header", max_bytes=HEADER_SEGMENT_MAX_BYTES
    )
    payload_raw = _decode_segment(
        payload_segment, label="payload", max_bytes=PAYLOAD_SEGMENT_MAX_BYTES
    )
    signature = _decode_segment(
        signature_segment, label="signature", max_bytes=SIGNATURE_SEGMENT_MAX_BYTES
    )
    if len(signature) != hashlib.sha256().digest_size:
        _fail("INTERNAL_TOKEN_SIGNATURE", "HS256 signature must be 32 bytes")

    header = _decode_json_object(header_raw, label="header")
    kid = _validate_header(header)
    key = _validate_keyring(keys, kid)

    signing_input = f"{header_segment}.{payload_segment}".encode("ascii")
    expected_signature = hmac.new(key, signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected_signature):
        _fail("INTERNAL_TOKEN_SIGNATURE", "signature mismatch")

    claims = _decode_json_object(payload_raw, label="claims")

    for name, value in (
        ("expected_issuer", expected_issuer),
        ("expected_audience", expected_audience),
        ("expected_subject", expected_subject),
    ):
        _require_visible_ascii(value, name=name)
    if type(leeway) is not int or not 0 <= leeway <= MAX_CLOCK_LEEWAY_SECONDS:
        _fail(
            "INTERNAL_TOKEN_TIME_CONFIG",
            "leeway must be an integer from zero through five",
        )
    if now is None:
        effective_now = int(time.time())
    elif type(now) is int and 0 < now <= JS_MAX_SAFE_INTEGER:
        effective_now = now
    else:
        _fail(
            "INTERNAL_TOKEN_TIME_CONFIG",
            "now must be a positive JavaScript-safe integer",
        )

    _validate_claims(
        claims,
        expected_issuer=expected_issuer,
        expected_audience=expected_audience,
        expected_subject=expected_subject,
        now=effective_now,
        leeway=leeway,
    )
    return claims


def verify_internal_request(
    token: str,
    *,
    keys: Mapping[str, bytes],
    expected_issuer: str,
    expected_audience: str,
    expected_subject: str,
    method: str,
    raw_path: bytes,
    raw_query: bytes,
    raw_body: bytes,
    expected_scope: str,
    expected_tool_name: str,
    path_sandbox_session_id: str | None = None,
    now: int | None = None,
    leeway: int = 0,
) -> dict[str, Any]:
    """Verify a token and bind it to the exact incoming HTTP request.

    Body verification hashes the exact bytes supplied by the HTTP server.  It
    never parses or reserializes JSON.  ``raw_path`` is compared byte-for-byte
    as an ASCII string and a non-empty raw query is always rejected.
    """

    claims = verify_internal_token(
        token,
        keys=keys,
        expected_issuer=expected_issuer,
        expected_audience=expected_audience,
        expected_subject=expected_subject,
        now=now,
        leeway=leeway,
    )

    if (
        type(method) is not str
        or not method.isascii()
        or method != method.upper()
        or method != claims["htm"]
    ):
        _fail("INTERNAL_REQUEST_METHOD", "HTTP method does not match token")
    if type(raw_path) is not bytes:
        _fail("INTERNAL_REQUEST_PATH", "raw path must be ASCII bytes")
    try:
        request_path = raw_path.decode("ascii", errors="strict")
    except UnicodeDecodeError:
        _fail("INTERNAL_REQUEST_PATH", "raw path must be ASCII bytes")
    try:
        request_path = _require_raw_absolute_path(request_path, name="raw_path")
    except InternalAuthError:
        _fail("INTERNAL_REQUEST_PATH", "raw path is not an absolute ASCII path")
    if not hmac.compare_digest(request_path, claims["htu"]):
        _fail("INTERNAL_REQUEST_PATH", "raw path does not match token")
    if type(raw_query) is not bytes or raw_query:
        _fail("INTERNAL_REQUEST_QUERY", "internal requests must have no query")
    if type(raw_body) is not bytes:
        _fail("INTERNAL_REQUEST_BODY", "raw body must be bytes")
    body_digest = hashlib.sha256(raw_body).hexdigest()
    if not hmac.compare_digest(body_digest, claims["body_sha256"]):
        _fail("INTERNAL_REQUEST_BODY", "raw body digest does not match token")

    scope = _require_visible_ascii(expected_scope, name="expected_scope")
    if not hmac.compare_digest(scope, claims["scope"][0]):
        _fail("INTERNAL_REQUEST_SCOPE", "scope does not match endpoint")
    tool_name = _require_visible_ascii(expected_tool_name, name="expected_tool_name")
    if not hmac.compare_digest(tool_name, claims["tool_name"]):
        _fail("INTERNAL_REQUEST_TOOL", "tool name does not match endpoint")

    if path_sandbox_session_id is not None:
        session_id = _require_visible_ascii(
            path_sandbox_session_id, name="path_sandbox_session_id"
        )
        if not hmac.compare_digest(session_id, claims["sandbox_session_id"]):
            _fail(
                "INTERNAL_REQUEST_SESSION",
                "path sandbox session does not match token",
            )
    return claims


__all__ = [
    "HEADER_SEGMENT_MAX_BYTES",
    "INTERNAL_HTTP_METHOD",
    "INTERNAL_TOKEN_TYPE",
    "INTERNAL_TOKEN_VERSION",
    "InternalAuthError",
    "JS_MAX_SAFE_INTEGER",
    "MAX_CLOCK_LEEWAY_SECONDS",
    "MAX_TOKEN_TTL_SECONDS",
    "PAYLOAD_SEGMENT_MAX_BYTES",
    "REQUEST_HASH_VERSION",
    "SIGNATURE_SEGMENT_MAX_BYTES",
    "TOKEN_MAX_BYTES",
    "verify_internal_request",
    "verify_internal_token",
]
