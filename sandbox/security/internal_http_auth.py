"""FastAPI adapter for Agent -> Sandbox internal HMAC authentication.

Wiring only: Bearer extraction from ASGI headers, ASGI raw path/query/body
binding with a bounded body reader, token verify, and atomic replay consume.
Endpoints declare expected scope / tool / path session id; this module never
parses or reserializes JSON bodies.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, NoReturn

from fastapi import HTTPException, Request

from sandbox.config import settings
from sandbox.security.internal_auth import (
    InternalAuthError,
    verify_internal_request,
)
from sandbox.security.replay_store import (
    ReplayStore,
    ReplayStoreUnavailableError,
    ReplayStoreValidationError,
)
from sandbox.trace import get_trace_id

logger = logging.getLogger("sandbox.security.internal_auth")

# Fixed service identity for the internal plane (plan §16.2 / golden fixtures).
INTERNAL_TOKEN_ISSUER = "agent-service"
INTERNAL_TOKEN_AUDIENCE = "sandbox-service"
INTERNAL_TOKEN_SUBJECT = "agent-worker"

# Unified client-facing details — never include codes, claims, or secrets.
INTERNAL_AUTH_HTTP_DETAIL = "Invalid or missing internal authentication"
INTERNAL_BODY_TOO_LARGE_DETAIL = "Request body too large"
INTERNAL_BAD_REQUEST_DETAIL = "Invalid request"
INTERNAL_SERVICE_UNAVAILABLE_DETAIL = "Service temporarily unavailable"

# app.state attribute for explicit ReplayStore injection (never auto memory).
REPLAY_STORE_STATE_KEY = "internal_replay_store"


@dataclass(frozen=True, slots=True)
class InternalAuthContext:
    """Verified internal request claims after token + replay checks."""

    claims: Mapping[str, Any]

    @property
    def org_id(self) -> str:
        return str(self.claims["org_id"])

    @property
    def user_id(self) -> str:
        return str(self.claims["user_id"])

    @property
    def sandbox_session_id(self) -> str:
        return str(self.claims["sandbox_session_id"])

    @property
    def run_id(self) -> str | None:
        value = self.claims["run_id"]
        return None if value is None else str(value)

    @property
    def tool_name(self) -> str:
        return str(self.claims["tool_name"])

    @property
    def jti(self) -> str:
        return str(self.claims["jti"])


def _deny(*, code: str, log_message: str) -> NoReturn:
    """Raise a uniform 401 without leaking verifier details to the client."""
    logger.warning("internal auth denied code=%s %s", code, log_message)
    raise HTTPException(status_code=401, detail=INTERNAL_AUTH_HTTP_DETAIL)


def _bad_request(*, code: str, log_message: str) -> NoReturn:
    logger.warning("internal auth bad request code=%s %s", code, log_message)
    raise HTTPException(status_code=400, detail=INTERNAL_BAD_REQUEST_DETAIL)


def _payload_too_large(*, code: str, log_message: str) -> NoReturn:
    logger.warning("internal auth body limit code=%s %s", code, log_message)
    raise HTTPException(status_code=413, detail=INTERNAL_BODY_TOO_LARGE_DETAIL)


def _service_unavailable(*, code: str, log_message: str) -> NoReturn:
    """Raise a uniform 503 without leaking store/keyring internals."""
    logger.warning("internal auth unavailable code=%s %s", code, log_message)
    raise HTTPException(
        status_code=503, detail=INTERNAL_SERVICE_UNAVAILABLE_DETAIL
    )


def _iter_asgi_headers(scope: Mapping[str, Any]) -> list[tuple[bytes, bytes]]:
    headers = scope.get("headers")
    if not isinstance(headers, (list, tuple)):
        _bad_request(
            code="INTERNAL_HTTP_HEADERS",
            log_message="ASGI headers missing or not a sequence",
        )
    out: list[tuple[bytes, bytes]] = []
    for item in headers:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            _bad_request(
                code="INTERNAL_HTTP_HEADERS",
                log_message="ASGI header entry malformed",
            )
        name, value = item[0], item[1]
        if type(name) is not bytes or type(value) is not bytes:
            _bad_request(
                code="INTERNAL_HTTP_HEADERS",
                log_message="ASGI header name/value must be bytes",
            )
        out.append((name, value))
    return out


def _header_values(headers: Sequence[tuple[bytes, bytes]], name: bytes) -> list[bytes]:
    target = name.lower()
    return [value for key, value in headers if key.lower() == target]


def extract_bearer_token(authorization: str) -> str:
    """Require exact ``Bearer <token>`` (single space, non-empty token)."""
    if type(authorization) is not str or not authorization:
        _deny(code="INTERNAL_HTTP_BEARER", log_message="missing Authorization")
    # Scheme is case-sensitive "Bearer" for a strict internal plane.
    if not authorization.startswith("Bearer "):
        _deny(code="INTERNAL_HTTP_BEARER", log_message="Authorization is not Bearer")
    token = authorization[len("Bearer ") :]
    if not token or token != token.strip() or any(c.isspace() for c in token):
        _deny(code="INTERNAL_HTTP_BEARER", log_message="Bearer token empty or malformed")
    return token


def extract_authorization_bearer_from_scope(scope: Mapping[str, Any]) -> str:
    """Require exactly one ASGI ``Authorization`` header; return Bearer token.

    Does not use ``request.headers`` (which can collapse or pick among duplicates).
    """
    headers = _iter_asgi_headers(scope)
    values = _header_values(headers, b"authorization")
    if len(values) == 0:
        _deny(code="INTERNAL_HTTP_BEARER", log_message="Authorization header missing")
    if len(values) > 1:
        _deny(code="INTERNAL_HTTP_BEARER", log_message="duplicate Authorization headers")
    raw = values[0]
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError:
        _deny(code="INTERNAL_HTTP_BEARER", log_message="Authorization is not ASCII")
    return extract_bearer_token(text)


def parse_content_length_from_scope(scope: Mapping[str, Any]) -> int | None:
    """Return Content-Length if present; None if absent.

    Rejects duplicates, non-ASCII, non-decimal, and empty values. Missing is OK
    (chunked / streaming body still subject to the byte cap).
    """
    headers = _iter_asgi_headers(scope)
    values = _header_values(headers, b"content-length")
    if len(values) == 0:
        return None
    if len(values) > 1:
        _bad_request(
            code="INTERNAL_HTTP_CONTENT_LENGTH",
            log_message="duplicate Content-Length headers",
        )
    raw = values[0]
    if not raw or any(b < 0x30 or b > 0x39 for b in raw):
        # Strict ASCII decimal digits only (rejects '-', '+', spaces, floats).
        _bad_request(
            code="INTERNAL_HTTP_CONTENT_LENGTH",
            log_message="Content-Length is not a non-negative decimal integer",
        )
    # Leading zeros are accepted as decimal (HTTP allows "0", "01" → 1).
    return int(raw)


async def read_bounded_raw_body(request: Request, *, max_bytes: int) -> bytes:
    """Read raw body via ``request.stream()`` with a hard byte cap.

    * Content-Length, when present, is checked before streaming; values above
      ``max_bytes`` yield 413 without reading.
    * Missing Content-Length is allowed; the stream is still capped.
    * If the peer sends more bytes than declared Content-Length, fail closed.
    * Exact bytes are cached on the Request so later ``body()`` / ``json()``
      reuse the same buffer (no re-parse / re-serialize of the wire body).
    """
    if type(max_bytes) is not int or isinstance(max_bytes, bool) or max_bytes < 1:
        # Defensive: settings validation should already enforce this.
        _payload_too_large(
            code="INTERNAL_HTTP_BODY_LIMIT_CONFIG",
            log_message="invalid max body configuration",
        )

    # Reuse a prior bounded read (same request, dependency + endpoint).
    cached = getattr(request, "_body", None)
    if type(cached) is bytes:
        if len(cached) > max_bytes:
            _payload_too_large(
                code="INTERNAL_HTTP_BODY_LIMIT",
                log_message="cached body exceeds limit",
            )
        return cached

    declared = parse_content_length_from_scope(request.scope)
    if declared is not None and declared > max_bytes:
        _payload_too_large(
            code="INTERNAL_HTTP_BODY_LIMIT",
            log_message="Content-Length exceeds max body bytes",
        )

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        if type(chunk) is not bytes:
            _bad_request(
                code="INTERNAL_HTTP_BODY",
                log_message="stream chunk is not bytes",
            )
        if not chunk:
            continue
        total += len(chunk)
        if total > max_bytes:
            _payload_too_large(
                code="INTERNAL_HTTP_BODY_LIMIT",
                log_message="stream exceeded max body bytes",
            )
        if declared is not None and total > declared:
            _bad_request(
                code="INTERNAL_HTTP_CONTENT_LENGTH",
                log_message="body longer than Content-Length",
            )
        chunks.append(chunk)

    body = b"".join(chunks)
    # Starlette caches on _body; body()/json() will reuse without re-streaming.
    request._body = body  # noqa: SLF001 — intentional ASGI/Starlette cache
    return body


def read_raw_path_and_query(request: Request) -> tuple[bytes, bytes]:
    """Return ASGI ``raw_path`` and ``query_string`` bytes; fail closed if missing."""
    scope = request.scope
    raw_path = scope.get("raw_path")
    if type(raw_path) is not bytes or not raw_path:
        _deny(code="INTERNAL_HTTP_RAW_PATH", log_message="ASGI raw_path unavailable")
    raw_query = scope.get("query_string", b"")
    if type(raw_query) is not bytes:
        _deny(code="INTERNAL_HTTP_RAW_QUERY", log_message="ASGI query_string not bytes")
    return raw_path, raw_query


def get_replay_store(request: Request) -> ReplayStore | None:
    """Return the explicitly injected replay store, or None if unconfigured."""
    return getattr(request.app.state, REPLAY_STORE_STATE_KEY, None)


def set_replay_store(app: Any, store: ReplayStore | None) -> None:
    """Explicitly inject (or clear) the replay store on ``app.state``."""
    setattr(app.state, REPLAY_STORE_STATE_KEY, store)


def _resolve_max_body_bytes(max_body_bytes: int | None) -> int:
    """Endpoint cap must be strict positive and never exceed the global cap."""
    global_cap = settings.internal_max_request_body_bytes
    if type(global_cap) is not int or isinstance(global_cap, bool) or global_cap < 1:
        _payload_too_large(
            code="INTERNAL_HTTP_BODY_LIMIT_CONFIG",
            log_message="invalid global max body configuration",
        )
    if max_body_bytes is None:
        return global_cap
    if (
        type(max_body_bytes) is not int
        or isinstance(max_body_bytes, bool)
        or max_body_bytes < 1
    ):
        _payload_too_large(
            code="INTERNAL_HTTP_BODY_LIMIT_CONFIG",
            log_message="invalid endpoint max body configuration",
        )
    if max_body_bytes > global_cap:
        _payload_too_large(
            code="INTERNAL_HTTP_BODY_LIMIT_CONFIG",
            log_message="endpoint max body exceeds global cap",
        )
    return max_body_bytes


async def authenticate_internal_request(
    request: Request,
    *,
    expected_scope: str,
    expected_tool_name: str,
    path_sandbox_session_id: str | None = None,
    now: int | None = None,
    max_body_bytes: int | None = None,
) -> InternalAuthContext:
    """Verify Bearer + request binding + replay; return typed claims context.

    Body is read with a hard size limit (endpoint-specific if provided, else
    global settings) before verify/replay. Content-Length over the effective
    cap yields 413 without streaming; the stream is also hard-capped.
    Does not parse or reserialize the body — only hashes the exact raw bytes.

    Replay store missing/unavailable is 503 (service down). Malformed token,
    signature failure, and duplicate jti remain 401.
    """
    store = get_replay_store(request)
    if store is None:
        _service_unavailable(
            code="INTERNAL_HTTP_REPLAY_UNCONFIGURED",
            log_message="replay store missing",
        )

    keys = settings.internal_hmac_keys
    if not keys:
        # Production startup validation rejects empty keyring; HTTP still
        # fail-closed without leaking configuration details.
        _deny(code="INTERNAL_HTTP_KEYRING_UNCONFIGURED", log_message="keyring empty")

    # Authorization before body so duplicate/malformed auth never touches store.
    token = extract_authorization_bearer_from_scope(request.scope)
    raw_path, raw_query = read_raw_path_and_query(request)

    max_body = _resolve_max_body_bytes(max_body_bytes)
    raw_body = await read_bounded_raw_body(request, max_bytes=max_body)

    leeway = int(settings.internal_token_leeway_seconds)
    effective_now = int(time.time()) if now is None else now

    try:
        claims = verify_internal_request(
            token,
            keys=keys,
            expected_issuer=INTERNAL_TOKEN_ISSUER,
            expected_audience=INTERNAL_TOKEN_AUDIENCE,
            expected_subject=INTERNAL_TOKEN_SUBJECT,
            method=request.method,
            raw_path=raw_path,
            raw_query=raw_query,
            raw_body=raw_body,
            expected_scope=expected_scope,
            expected_tool_name=expected_tool_name,
            path_sandbox_session_id=path_sandbox_session_id,
            now=effective_now,
            leeway=leeway,
        )
    except InternalAuthError as exc:
        _deny(code=exc.code, log_message="token or request binding failed")

    request_trace_id = get_trace_id()
    claim_trace_id = str(claims["trace_id"]).strip().lower()
    if request_trace_id is not None and claim_trace_id != request_trace_id:
        _deny(
            code="INTERNAL_HTTP_TRACE_MISMATCH",
            log_message="trace context does not match signed claim",
        )

    try:
        consumed = await store.consume(
            issuer=str(claims["iss"]),
            audience=str(claims["aud"]),
            jti=str(claims["jti"]),
            expires_at=int(claims["exp"]),
            now=effective_now,
            leeway=leeway,
        )
    except ReplayStoreValidationError:
        _deny(code="INTERNAL_HTTP_REPLAY_INVALID", log_message="replay inputs invalid")
    except ReplayStoreUnavailableError:
        _service_unavailable(
            code="INTERNAL_HTTP_REPLAY_UNAVAILABLE",
            log_message="replay store unavailable",
        )
    except Exception:
        logger.exception("internal auth replay store unexpected failure")
        _service_unavailable(
            code="INTERNAL_HTTP_REPLAY_UNAVAILABLE",
            log_message="replay store error",
        )

    if not consumed:
        _deny(code="INTERNAL_HTTP_REPLAY_DUPLICATE", log_message="jti already consumed")

    return InternalAuthContext(claims=claims)


def require_internal_auth(
    *,
    expected_scope: str,
    expected_tool_name: str,
    path_sandbox_session_id: str | None = None,
    path_sandbox_session_param: str | None = None,
    max_body_bytes: int | None = None,
) -> Callable[..., Any]:
    """FastAPI dependency factory for internal routes.

    Pass a fixed ``path_sandbox_session_id`` and/or a path-parameter name
    (``path_sandbox_session_param``) resolved from ``request.path_params``.

    Optional ``max_body_bytes`` is an endpoint-specific hard cap that must be a
    strict positive int and must not exceed the global
    ``internal_max_request_body_bytes`` setting (enforced at request time).
    """
    if max_body_bytes is not None:
        if (
            type(max_body_bytes) is not int
            or isinstance(max_body_bytes, bool)
            or max_body_bytes < 1
        ):
            raise ValueError("max_body_bytes must be a strict positive int")

    async def _dependency(request: Request) -> InternalAuthContext:
        session_id = path_sandbox_session_id
        if path_sandbox_session_param is not None:
            raw = request.path_params.get(path_sandbox_session_param)
            if raw is None or (type(raw) is not str) or not raw:
                _deny(
                    code="INTERNAL_HTTP_PATH_SESSION",
                    log_message="path sandbox session param missing",
                )
            session_id = raw
        return await authenticate_internal_request(
            request,
            expected_scope=expected_scope,
            expected_tool_name=expected_tool_name,
            path_sandbox_session_id=session_id,
            max_body_bytes=max_body_bytes,
        )

    return _dependency


__all__ = [
    "INTERNAL_AUTH_HTTP_DETAIL",
    "INTERNAL_BAD_REQUEST_DETAIL",
    "INTERNAL_BODY_TOO_LARGE_DETAIL",
    "INTERNAL_SERVICE_UNAVAILABLE_DETAIL",
    "INTERNAL_TOKEN_AUDIENCE",
    "INTERNAL_TOKEN_ISSUER",
    "INTERNAL_TOKEN_SUBJECT",
    "REPLAY_STORE_STATE_KEY",
    "InternalAuthContext",
    "authenticate_internal_request",
    "extract_authorization_bearer_from_scope",
    "extract_bearer_token",
    "get_replay_store",
    "parse_content_length_from_scope",
    "read_bounded_raw_body",
    "read_raw_path_and_query",
    "require_internal_auth",
    "set_replay_store",
]
