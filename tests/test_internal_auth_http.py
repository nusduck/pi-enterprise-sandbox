"""Wiring tests: internal HMAC config + FastAPI adapter + legacy auth boundary.

Does not register production tool routes. Uses an isolated FastAPI app for
dependency wiring and the real sandbox app only for middleware boundary checks.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

import pytest
from fastapi import Depends, FastAPI, Request
from fastapi.testclient import TestClient

from sandbox.config import Settings, settings
from sandbox.main import app as sandbox_app
from sandbox.security.internal_http_auth import (
    INTERNAL_AUTH_HTTP_DETAIL,
    INTERNAL_BAD_REQUEST_DETAIL,
    INTERNAL_BODY_TOO_LARGE_DETAIL,
    INTERNAL_SERVICE_UNAVAILABLE_DETAIL,
    INTERNAL_TOKEN_AUDIENCE,
    INTERNAL_TOKEN_ISSUER,
    INTERNAL_TOKEN_SUBJECT,
    InternalAuthContext,
    authenticate_internal_request,
    extract_authorization_bearer_from_scope,
    extract_bearer_token,
    parse_content_length_from_scope,
    read_bounded_raw_body,
    require_internal_auth,
    set_replay_store,
)
from sandbox.security.public_routes import is_internal_v1_route, is_public_route
from sandbox.security.replay_store import (
    InMemoryReplayStore,
    ReplayStoreUnavailableError,
)

NOW = 2_000_000_000
KEY = b"k" * 32
KEY_B64 = base64.urlsafe_b64encode(KEY).decode("ascii").rstrip("=")
KID = "key-1"
PATH = "/internal/v1/sessions/sandbox_1/files/write"
BODY = b'{"path":"report.txt","content":"ok"}'
SCOPE = "sandbox.files.write"
TOOL = "write"


def _keyring_json(keys: dict[str, bytes] | None = None) -> str:
    material = keys if keys is not None else {KID: KEY}
    encoded = {
        kid: base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        for kid, raw in material.items()
    }
    return json.dumps(encoded, separators=(",", ":"))


def claims(**updates: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "token_version": 1,
        "iss": INTERNAL_TOKEN_ISSUER,
        "aud": INTERNAL_TOKEN_AUDIENCE,
        "sub": INTERNAL_TOKEN_SUBJECT,
        "org_id": "org_1",
        "user_id": "user_1",
        "conversation_id": "conversation_1",
        "agent_session_id": "agent_session_1",
        "sandbox_session_id": "sandbox_1",
        "run_id": "run_1",
        "tool_execution_id": "tool_execution_1",
        "tool_call_id": "tool_call_1",
        "tool_name": TOOL,
        "scope": [SCOPE],
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
        "jti": "jti_wiring_1",
    }
    out.update(updates)
    return out


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def make_token(
    payload: dict[str, Any] | None = None,
    *,
    kid: str = KID,
    key: bytes = KEY,
) -> str:
    header = {"alg": "HS256", "kid": kid, "typ": "sandbox-internal+jwt"}
    header_segment = b64(json.dumps(header, separators=(",", ":")).encode())
    payload_segment = b64(
        json.dumps(payload if payload is not None else claims(), separators=(",", ":")).encode()
    )
    signing_input = f"{header_segment}.{payload_segment}".encode()
    signature = b64(hmac.new(key, signing_input, hashlib.sha256).digest())
    return f"{header_segment}.{payload_segment}.{signature}"


def _settings_with_keyring(**overrides: Any) -> Settings:
    base = {
        "database_url": "sqlite:////tmp/internal-auth-http.db",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "internal_hmac_keyring": _keyring_json(),
        "internal_hmac_active_kid": KID,
        "internal_token_leeway_seconds": 0,
        "api_token": "",
        "auth_enabled": False,
    }
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
def keyed_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    s = _settings_with_keyring()
    monkeypatch.setattr("sandbox.config.settings", s)
    monkeypatch.setattr("sandbox.security.internal_http_auth.settings", s)
    monkeypatch.setattr("sandbox.main.settings", s)
    return s


def _build_probe_app(
    store: InMemoryReplayStore | None,
    *,
    expected_scope: str = SCOPE,
    expected_tool: str = TOOL,
    session_param: str | None = "session_id",
) -> FastAPI:
    probe = FastAPI()
    set_replay_store(probe, store)

    dep = require_internal_auth(
        expected_scope=expected_scope,
        expected_tool_name=expected_tool,
        path_sandbox_session_param=session_param,
    )

    @probe.post("/internal/v1/sessions/{session_id}/files/write")
    async def _probe(
        session_id: str,
        request: Request,
        ctx: InternalAuthContext = Depends(dep),
    ) -> dict[str, Any]:
        # Endpoint must be able to re-read the same raw bytes after auth.
        again = await request.body()
        return {
            "ok": True,
            "run_id": ctx.run_id,
            "jti": ctx.jti,
            "sandbox_session_id": ctx.sandbox_session_id,
            "path_session_id": session_id,
            "body_len": len(again),
            "body_sha256": hashlib.sha256(again).hexdigest(),
        }

    # Fixed session binding (no path param) for path/htu mismatch cases.
    fixed_dep = require_internal_auth(
        expected_scope=expected_scope,
        expected_tool_name=expected_tool,
        path_sandbox_session_id="sandbox_1",
    )

    @probe.post("/internal/v1/probe")
    async def _fixed(
        request: Request,
        ctx: InternalAuthContext = Depends(fixed_dep),
    ) -> dict[str, Any]:
        again = await request.body()
        return {"ok": True, "run_id": ctx.run_id, "body_len": len(again)}

    return probe


class SpyReplayStore:
    """Counts consume() calls; optional inner store or forced failure."""

    def __init__(
        self,
        inner: InMemoryReplayStore | None = None,
        *,
        fail: bool = False,
    ) -> None:
        self.inner = inner if inner is not None else InMemoryReplayStore()
        self.fail = fail
        self.calls = 0

    async def consume(self, **kwargs: Any) -> bool:
        self.calls += 1
        if self.fail:
            raise ReplayStoreUnavailableError("down")
        return await self.inner.consume(**kwargs)


def _asgi_request(
    *,
    app: FastAPI,
    path: str = PATH,
    method: str = "POST",
    headers: list[tuple[bytes, bytes]],
    body: bytes = BODY,
    body_chunks: list[bytes] | None = None,
) -> Request:
    """Build a Starlette Request with controlled ASGI headers and body stream."""
    from starlette.requests import Request as StarletteRequest

    chunks = list(body_chunks) if body_chunks is not None else [body]
    state = {"i": 0}

    async def receive() -> dict[str, Any]:
        i = state["i"]
        if i >= len(chunks):
            return {"type": "http.request", "body": b"", "more_body": False}
        chunk = chunks[i]
        state["i"] = i + 1
        more = state["i"] < len(chunks)
        return {"type": "http.request", "body": chunk, "more_body": more}

    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 50000),
        "server": ("test", 80),
        "app": app,
    }
    return StarletteRequest(scope, receive)


# ── Config ─────────────────────────────────────────────────────────────


class TestInternalKeyringConfig:
    def test_parses_valid_keyring_and_active_kid(self) -> None:
        s = _settings_with_keyring()
        assert list(s.internal_hmac_keys.keys()) == [KID]
        assert s.internal_hmac_keys[KID] == KEY
        assert s.internal_hmac_active_kid == KID
        assert s.internal_token_leeway_seconds == 0

    def test_empty_keyring_is_allowed(self) -> None:
        s = Settings(
            database_url="sqlite:////tmp/internal-auth-empty.db",
            allowed_client_cidrs=["127.0.0.1/32"],
            internal_hmac_keyring="",
            internal_hmac_active_kid="",
        )
        assert s.internal_hmac_keys == {}

    def test_active_kid_must_exist(self) -> None:
        with pytest.raises(ValueError, match="activeKid|ACTIVE_KID|keyring"):
            _settings_with_keyring(internal_hmac_active_kid="missing")

    def test_rejects_short_key(self) -> None:
        short = base64.urlsafe_b64encode(b"short").decode().rstrip("=")
        with pytest.raises(ValueError, match="keyring|32"):
            _settings_with_keyring(
                internal_hmac_keyring=json.dumps({KID: short}),
            )

    def test_rejects_padded_base64url(self) -> None:
        padded = base64.urlsafe_b64encode(KEY).decode("ascii")  # with padding
        assert "=" in padded
        with pytest.raises(ValueError, match="keyring|base64url|canonical"):
            _settings_with_keyring(
                internal_hmac_keyring=json.dumps({KID: padded}),
            )

    def test_rejects_leeway_out_of_range(self) -> None:
        with pytest.raises(ValueError, match="LEEWAY"):
            _settings_with_keyring(internal_token_leeway_seconds=6)

    def test_requires_both_keyring_and_active_kid(self) -> None:
        with pytest.raises(ValueError, match="ACTIVE_KID"):
            Settings(
                database_url="sqlite:////tmp/internal-auth-half.db",
                allowed_client_cidrs=["127.0.0.1/32"],
                internal_hmac_keyring=_keyring_json(),
                internal_hmac_active_kid="",
            )
        with pytest.raises(ValueError, match="KEYRING"):
            Settings(
                database_url="sqlite:////tmp/internal-auth-half2.db",
                allowed_client_cidrs=["127.0.0.1/32"],
                internal_hmac_keyring="",
                internal_hmac_active_kid=KID,
            )

    def test_multiple_keys_up_to_limit(self) -> None:
        keys = {f"k{i}": bytes([i]) * 32 for i in range(2)}
        s = _settings_with_keyring(
            internal_hmac_keyring=_keyring_json(keys),
            internal_hmac_active_kid="k0",
        )
        assert len(s.internal_hmac_keys) == 2


# ── Route boundary helpers ─────────────────────────────────────────────


class TestInternalRouteBoundary:
    def test_internal_v1_prefix_is_precise(self) -> None:
        assert is_internal_v1_route("/internal/v1") is True
        assert is_internal_v1_route("/internal/v1/") is True
        assert is_internal_v1_route("/internal/v1/sessions/x") is True
        assert is_internal_v1_route("/internal") is False
        assert is_internal_v1_route("/internal/v10/x") is False
        assert is_internal_v1_route("/internal/v1x") is False
        assert is_internal_v1_route("/sessions") is False
        # Must not be treated as public.
        assert is_public_route("/internal/v1/sessions/x") is False


# ── Bearer helper ──────────────────────────────────────────────────────


class TestBearerExtraction:
    def test_exact_bearer(self) -> None:
        assert extract_bearer_token("Bearer abc.def.ghi") == "abc.def.ghi"

    def test_missing_or_wrong_scheme(self) -> None:
        from fastapi import HTTPException

        for value in (None, "", "Basic x", "bearer x", "Bearer", "Bearer  ", "Bearer a b"):
            with pytest.raises(HTTPException) as exc:
                extract_bearer_token(value)  # type: ignore[arg-type]
            assert exc.value.status_code == 401
            assert exc.value.detail == INTERNAL_AUTH_HTTP_DETAIL

    def test_asgi_requires_exactly_one_authorization(self) -> None:
        from fastapi import HTTPException

        # Missing
        with pytest.raises(HTTPException) as exc:
            extract_authorization_bearer_from_scope({"headers": []})
        assert exc.value.status_code == 401

        # Duplicate
        with pytest.raises(HTTPException) as exc2:
            extract_authorization_bearer_from_scope(
                {
                    "headers": [
                        (b"authorization", b"Bearer a.b.c"),
                        (b"authorization", b"Bearer d.e.f"),
                    ]
                }
            )
        assert exc2.value.status_code == 401
        assert exc2.value.detail == INTERNAL_AUTH_HTTP_DETAIL

        # Non-bytes value
        with pytest.raises(HTTPException) as exc3:
            extract_authorization_bearer_from_scope(
                {"headers": [(b"authorization", "Bearer a.b.c")]}  # type: ignore[list-item]
            )
        assert exc3.value.status_code == 400

        # Non-ASCII
        with pytest.raises(HTTPException) as exc4:
            extract_authorization_bearer_from_scope(
                {"headers": [(b"authorization", b"Bearer caf\xc3\xa9")]}
            )
        assert exc4.value.status_code == 401

        # Exactly one OK
        tok = extract_authorization_bearer_from_scope(
            {"headers": [(b"authorization", b"Bearer abc.def.ghi")]}
        )
        assert tok == "abc.def.ghi"

    def test_content_length_parser_strict(self) -> None:
        from fastapi import HTTPException

        assert parse_content_length_from_scope({"headers": []}) is None
        assert (
            parse_content_length_from_scope(
                {"headers": [(b"content-length", b"42")]}
            )
            == 42
        )
        with pytest.raises(HTTPException) as exc:
            parse_content_length_from_scope(
                {
                    "headers": [
                        (b"content-length", b"1"),
                        (b"content-length", b"2"),
                    ]
                }
            )
        assert exc.value.status_code == 400
        for bad in (b"-1", b"1.5", b"+3", b" 4", b"4 ", b"", b"0x10", b"1e2"):
            with pytest.raises(HTTPException) as exc_bad:
                parse_content_length_from_scope(
                    {"headers": [(b"content-length", bad)]}
                )
            assert exc_bad.value.status_code == 400
            assert exc_bad.value.detail == INTERNAL_BAD_REQUEST_DETAIL


# ── HTTP dependency wiring ─────────────────────────────────────────────


class TestInternalAuthHttpWiring:
    def test_valid_request(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        store = InMemoryReplayStore()
        client = TestClient(_build_probe_app(store))
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert body["run_id"] == "run_1"
        assert body["jti"] == "jti_wiring_1"
        # Endpoint re-read same raw body after auth dependency.
        assert body["body_len"] == len(BODY)
        assert body["body_sha256"] == hashlib.sha256(BODY).hexdigest()
        # No secret leakage
        assert KEY_B64 not in resp.text
        assert "signature" not in resp.text.lower()

    def test_missing_bearer(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        resp = client.post(PATH, content=BODY)
        assert resp.status_code == 401
        assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL

    def test_wrong_bearer(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": "Bearer not-a-valid-token"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL
        assert "INTERNAL_TOKEN" not in resp.text

    def test_body_mismatch(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY + b" ",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL

    def test_query_rejected(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        token = make_token()
        resp = client.post(
            PATH + "?x=1",
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_scope_mismatch(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(
            _build_probe_app(InMemoryReplayStore(), expected_scope="other.scope")
        )
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_tool_mismatch(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(
            _build_probe_app(InMemoryReplayStore(), expected_tool="other_tool")
        )
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_session_mismatch(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        # Path embeds wrong session id vs claim sandbox_1
        wrong_path = "/internal/v1/sessions/sandbox_OTHER/files/write"
        probe = FastAPI()
        set_replay_store(probe, InMemoryReplayStore())
        dep = require_internal_auth(
            expected_scope=SCOPE,
            expected_tool_name=TOOL,
            path_sandbox_session_param="session_id",
        )

        @probe.post("/internal/v1/sessions/{session_id}/files/write")
        async def _p(ctx: InternalAuthContext = Depends(dep)) -> dict[str, str]:
            return {"ok": "yes"}

        client = TestClient(probe)
        token = make_token()  # htu still PATH with sandbox_1
        # Path mismatch on htu will fail first; craft token with matching htu but wrong session claim binding
        token = make_token(claims(htu=wrong_path, sandbox_session_id="sandbox_1"))
        resp = client.post(
            wrong_path,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_duplicate_jti(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        store = InMemoryReplayStore()
        client = TestClient(_build_probe_app(store))
        token = make_token()
        headers = {"Authorization": f"Bearer {token}"}
        assert client.post(PATH, content=BODY, headers=headers).status_code == 200
        again = client.post(PATH, content=BODY, headers=headers)
        assert again.status_code == 401
        assert again.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL

    def test_store_unavailable(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)

        class BoomStore:
            async def consume(self, **kwargs: Any) -> bool:
                raise ReplayStoreUnavailableError("down")

        client = TestClient(_build_probe_app(BoomStore()))  # type: ignore[arg-type]
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        # Service unavailable — no store decision; do not leak internals.
        assert resp.status_code == 503
        assert resp.json()["detail"] == INTERNAL_SERVICE_UNAVAILABLE_DETAIL
        assert "ReplayStore" not in resp.text
        assert "down" not in resp.text

    def test_missing_replay_store_fail_closed(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(None))
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 503
        assert resp.json()["detail"] == INTERNAL_SERVICE_UNAVAILABLE_DETAIL

    def test_unknown_kid(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        other = b"o" * 32
        token = make_token(kid="other-kid", key=other)
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_expired_token(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW + 1000)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        token = make_token()
        resp = client.post(
            PATH,
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401

    def test_path_mismatch(self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        client = TestClient(_build_probe_app(InMemoryReplayStore()))
        token = make_token()
        resp = client.post(
            "/internal/v1/probe",
            content=BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
        # Token htu is PATH, not /internal/v1/probe
        assert resp.status_code == 401


# ── Main app legacy boundary ───────────────────────────────────────────


class TestMainAppAuthBoundary:
    def test_api_key_does_not_gate_internal_prefix(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Without bypass, missing API key would 401 before 404."""
        monkeypatch.setattr(settings, "api_token", "svc-secret-for-boundary")
        monkeypatch.setattr(settings, "auth_enabled", False)
        client = TestClient(sandbox_app)
        # No API key, no internal route → would be 401; internal prefix → 404
        resp = client.post("/internal/v1/no-such-route", content=b"{}")
        assert resp.status_code == 404
        # API key still required for legacy routes
        assert client.get("/sessions").status_code == 401

    def test_old_api_key_cannot_authenticate_internal_dependency(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        monkeypatch.setattr(keyed_settings, "api_token", "svc-secret")
        store = InMemoryReplayStore()
        # Mount probe on a fresh app that also checks we don't accept X-API-Key
        probe = _build_probe_app(store)
        client = TestClient(probe)
        resp = client.post(
            PATH,
            content=BODY,
            headers={"X-API-Key": "svc-secret"},
        )
        assert resp.status_code == 401
        assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL

    def test_internal_token_does_not_open_legacy_routes(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        # Patch the same Settings instance middleware sees (keyed_settings).
        monkeypatch.setattr(keyed_settings, "api_token", "svc-secret-legacy")
        monkeypatch.setattr(keyed_settings, "auth_enabled", False)
        token = make_token()
        client = TestClient(sandbox_app)
        resp = client.get(
            "/sessions",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 401
        assert "token" in resp.json()["detail"].lower()

    def test_public_routes_still_open_with_api_token(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "api_token", "svc-secret")
        client = TestClient(sandbox_app)
        assert client.get("/health").status_code == 200

    def test_near_miss_internal_paths_still_need_api_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "api_token", "svc-secret")
        monkeypatch.setattr(settings, "auth_enabled", False)
        client = TestClient(sandbox_app)
        # /internal/v10 is NOT the internal plane
        assert client.get("/internal/v10/x").status_code == 401
        assert client.get("/internal").status_code == 401


# ── Bounded body + ASGI header strictness ──────────────────────────────


class TestBoundedBodyAndAsgiHeaders:
    def test_default_max_body_fits_72mib(self) -> None:
        s = Settings(
            database_url="sqlite:////tmp/internal-auth-body-default.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.internal_max_request_body_bytes == 72 * 1024 * 1024

    def test_max_body_rejects_bool_float_and_hard_cap(self) -> None:
        with pytest.raises(ValueError, match="bool|integer"):
            Settings(
                database_url="sqlite:////tmp/internal-auth-body-bool.db",
                allowed_client_cidrs=["127.0.0.1/32"],
                internal_max_request_body_bytes=True,  # type: ignore[arg-type]
            )
        with pytest.raises(ValueError, match="float|integer"):
            Settings(
                database_url="sqlite:////tmp/internal-auth-body-float.db",
                allowed_client_cidrs=["127.0.0.1/32"],
                internal_max_request_body_bytes=1.5,  # type: ignore[arg-type]
            )
        with pytest.raises(ValueError, match="MAX_REQUEST_BODY|positive"):
            Settings(
                database_url="sqlite:////tmp/internal-auth-body-huge.db",
                allowed_client_cidrs=["127.0.0.1/32"],
                internal_max_request_body_bytes=512 * 1024 * 1024 + 1,
            )

    @pytest.mark.asyncio
    async def test_body_reused_by_endpoint_after_auth(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token()
        headers = [
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"content-length", str(len(BODY)).encode("ascii")),
        ]
        request = _asgi_request(app=app, headers=headers, body=BODY)
        ctx = await authenticate_internal_request(
            request,
            expected_scope=SCOPE,
            expected_tool_name=TOOL,
            path_sandbox_session_id="sandbox_1",
            now=NOW,
        )
        assert ctx.run_id == "run_1"
        again = await request.body()
        assert again == BODY
        assert store.calls == 1

    @pytest.mark.asyncio
    async def test_content_length_over_limit_before_verify_and_replay(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 16)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        # Declared length over limit; body not needed for early 413.
        big = b"x" * 32
        token = make_token(
            claims(
                body_sha256=hashlib.sha256(big).hexdigest(),
                jti="jti_cl_over",
            )
        )
        headers = [
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"content-length", b"32"),
        ]
        request = _asgi_request(app=app, headers=headers, body=big)
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                request,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc.value.status_code == 413
        assert exc.value.detail == INTERNAL_BODY_TOO_LARGE_DETAIL
        assert store.calls == 0

    @pytest.mark.asyncio
    async def test_chunked_missing_content_length_over_limit(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 20)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token(claims(jti="jti_chunked"))
        # No Content-Length — stream still capped.
        headers = [(b"authorization", f"Bearer {token}".encode("ascii"))]
        chunks = [b"a" * 12, b"b" * 12]  # 24 > 20
        request = _asgi_request(
            app=app, headers=headers, body=b"", body_chunks=chunks
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                request,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc.value.status_code == 413
        assert store.calls == 0

    @pytest.mark.asyncio
    async def test_declared_small_actual_over_declared(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 10_000)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token(claims(jti="jti_lie_small"))
        # Declares 5 bytes but stream delivers more.
        headers = [
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"content-length", b"5"),
        ]
        request = _asgi_request(
            app=app, headers=headers, body=b"", body_chunks=[b"hello!!!"]
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                request,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc.value.status_code == 400
        assert exc.value.detail == INTERNAL_BAD_REQUEST_DETAIL
        assert store.calls == 0

    @pytest.mark.asyncio
    async def test_duplicate_authorization_rejects_without_replay(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token(claims(jti="jti_dup_auth"))
        auth = f"Bearer {token}".encode("ascii")
        headers = [
            (b"authorization", auth),
            (b"authorization", auth),
            (b"content-length", str(len(BODY)).encode("ascii")),
        ]
        request = _asgi_request(app=app, headers=headers, body=BODY)
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                request,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc.value.status_code == 401
        assert exc.value.detail == INTERNAL_AUTH_HTTP_DETAIL
        assert store.calls == 0

    @pytest.mark.asyncio
    async def test_duplicate_and_illegal_content_length(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token(claims(jti="jti_dup_cl"))
        auth = f"Bearer {token}".encode("ascii")

        dup = _asgi_request(
            app=app,
            headers=[
                (b"authorization", auth),
                (b"content-length", b"10"),
                (b"content-length", b"11"),
            ],
            body=BODY,
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                dup,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc.value.status_code == 400
        assert store.calls == 0

        bad = _asgi_request(
            app=app,
            headers=[
                (b"authorization", auth),
                (b"content-length", b"-1"),
            ],
            body=BODY,
        )
        with pytest.raises(HTTPException) as exc2:
            await authenticate_internal_request(
                bad,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
            )
        assert exc2.value.status_code == 400
        assert store.calls == 0

    @pytest.mark.asyncio
    async def test_body_exactly_at_limit_passes(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(time, "time", lambda: NOW)
        limit_body = b"Z" * 64
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 64)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        token = make_token(
            claims(
                body_sha256=hashlib.sha256(limit_body).hexdigest(),
                jti="jti_exact_limit",
            )
        )
        headers = [
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"content-length", b"64"),
        ]
        request = _asgi_request(app=app, headers=headers, body=limit_body)
        ctx = await authenticate_internal_request(
            request,
            expected_scope=SCOPE,
            expected_tool_name=TOOL,
            path_sandbox_session_id="sandbox_1",
            now=NOW,
        )
        assert ctx.jti == "jti_exact_limit"
        assert await request.body() == limit_body
        assert store.calls == 1

    @pytest.mark.asyncio
    async def test_read_bounded_body_alone_caches(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 100)
        app = FastAPI()
        payload = b"cached-raw-bytes"
        request = _asgi_request(
            app=app,
            headers=[(b"content-length", str(len(payload)).encode("ascii"))],
            body=payload,
        )
        first = await read_bounded_raw_body(request, max_bytes=100)
        second = await request.body()
        assert first == payload
        assert second == payload
        assert first is second  # same cached buffer

    @pytest.mark.asyncio
    async def test_endpoint_max_body_bytes_below_global(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Endpoint-specific cap is enforced; global cap remains higher."""
        from fastapi import HTTPException

        monkeypatch.setattr(time, "time", lambda: NOW)
        # Global is large; endpoint asks for 20.
        monkeypatch.setattr(keyed_settings, "internal_max_request_body_bytes", 10_000)
        store = SpyReplayStore()
        app = FastAPI()
        set_replay_store(app, store)
        over = b"x" * 32
        token = make_token(
            claims(
                body_sha256=hashlib.sha256(over).hexdigest(),
                jti="jti_ep_cap",
            )
        )
        headers = [
            (b"authorization", f"Bearer {token}".encode("ascii")),
            (b"content-length", b"32"),
        ]
        request = _asgi_request(app=app, headers=headers, body=over)
        with pytest.raises(HTTPException) as exc:
            await authenticate_internal_request(
                request,
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                path_sandbox_session_id="sandbox_1",
                now=NOW,
                max_body_bytes=20,
            )
        assert exc.value.status_code == 413
        assert store.calls == 0

    def test_require_internal_auth_rejects_non_positive_max_body(self) -> None:
        with pytest.raises(ValueError, match="max_body_bytes"):
            require_internal_auth(
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                max_body_bytes=0,
            )
        with pytest.raises(ValueError, match="max_body_bytes"):
            require_internal_auth(
                expected_scope=SCOPE,
                expected_tool_name=TOOL,
                max_body_bytes=-1,
            )
