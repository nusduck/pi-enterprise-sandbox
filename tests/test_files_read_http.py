"""Signed HTTP tests for POST /internal/v1/files/read (offline)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
from dataclasses import replace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sandbox.app.domain.files_read_contract import READ_MAX_BYTES_FIXED
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    ExecutionRecord,
)
from sandbox.app.domain.ulid import new_ulid
from sandbox.config import Settings
from sandbox.main import app as sandbox_app
from sandbox.routers import internal_files
from sandbox.routers.internal_files import FILES_READ_MAX_BODY_BYTES
from sandbox.security.internal_http_auth import (
    INTERNAL_AUTH_HTTP_DETAIL,
    INTERNAL_BODY_TOO_LARGE_DETAIL,
    INTERNAL_SERVICE_UNAVAILABLE_DETAIL,
    INTERNAL_TOKEN_AUDIENCE,
    INTERNAL_TOKEN_ISSUER,
    INTERNAL_TOKEN_SUBJECT,
    set_replay_store,
)
from sandbox.security.replay_store import (
    InMemoryReplayStore,
    ReplayStoreUnavailableError,
)
from sandbox.services.files_read_runtime import (
    FilesReadRuntime,
    set_files_read_runtime,
)
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor

NOW = 2_000_000_000
KEY = b"k" * 32
KEY_B64 = base64.urlsafe_b64encode(KEY).decode("ascii").rstrip("=")
KID = "key-1"
PATH_HTTP = "/internal/v1/files/read"

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
TE = "01K0G2PAV8FPMVC9QHJG7JPN5K"
WS = "01K0G2PAV8FPMVC9QHJG7JPN56"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN60"
TC = "tc-http-1"
TRACE = "0123456789abcdef0123456789abcdef"
FILE_PATH = "/home/sandbox/workspace/notes/a.txt"
FENCE = 7


def _keyring_json() -> str:
    return json.dumps({KID: KEY_B64}, separators=(",", ":"))


def _req_hash(
    path: str = FILE_PATH,
    offset: int = 0,
    limit: int = 100,
) -> str:
    return compute_tool_request_hash_v1(
        tool_name="read",
        args={
            "path": path,
            "offset": offset,
            "limit": limit,
            "maxBytes": READ_MAX_BYTES_FIXED,
        },
    )["requestHash"]


def body_obj(**updates: Any) -> dict[str, Any]:
    h = _req_hash()
    out: dict[str, Any] = {
        "path": FILE_PATH,
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
    out.update(updates)
    return out


def body_bytes(obj: dict[str, Any] | None = None) -> bytes:
    return json.dumps(obj or body_obj(), separators=(",", ":")).encode("utf-8")


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def make_token(
    *,
    body: bytes,
    jti: str = "jti_files_1",
    request_hash: str | None = None,
    tool_name: str = "read",
    scope: str = "sandbox.files.read",
    extra_claims: dict[str, Any] | None = None,
) -> str:
    payload: dict[str, Any] = {
        "token_version": 1,
        "iss": INTERNAL_TOKEN_ISSUER,
        "aud": INTERNAL_TOKEN_AUDIENCE,
        "sub": INTERNAL_TOKEN_SUBJECT,
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "sandbox_session_id": SBX,
        "run_id": RUN,
        "tool_execution_id": TE,
        "tool_call_id": TC,
        "tool_name": tool_name,
        "scope": [scope],
        "request_hash": request_hash if request_hash is not None else _req_hash(),
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
        "htm": "POST",
        "htu": PATH_HTTP,
        "body_sha256": hashlib.sha256(body).hexdigest(),
        "iat": NOW,
        "nbf": NOW,
        "exp": NOW + 60,
        "jti": jti,
    }
    if extra_claims:
        payload.update(extra_claims)
    header = {"alg": "HS256", "kid": KID, "typ": "sandbox-internal+jwt"}
    header_segment = b64(json.dumps(header, separators=(",", ":")).encode())
    payload_segment = b64(json.dumps(payload, separators=(",", ":")).encode())
    signing_input = f"{header_segment}.{payload_segment}".encode()
    signature = b64(hmac.new(KEY, signing_input, hashlib.sha256).digest())
    return f"{header_segment}.{payload_segment}.{signature}"


class FakeClaimValidator:
    def __init__(self) -> None:
        self.claim_calls = 0
        self.finalize_calls = 0
        self.read_related = 0
        self._lock = threading.Lock()
        self._created_once = False
        self._exec: ExecutionRecord | None = None

    def claim(self, input: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self.claim_calls += 1
            if not self._created_once:
                self._created_once = True
                self._exec = ExecutionRecord(
                    execution_id=str(input["execution_id"]),
                    org_id=ORG,
                    user_id=USER,
                    sandbox_session_id=SBX,
                    run_id=RUN,
                    agent_session_id=AGENT,
                    kind="read",
                    status=SANDBOX_EXECUTION_STATUS_RUNNING,
                    created_at="2026-01-01 00:00:00",
                    tool_execution_id=TE,
                    tool_call_id=TC,
                    request_hash=str(input["request_hash"]),
                    request_hash_version=1,
                    execution_fence_token=FENCE,
                    trace_id=TRACE,
                )
                return {
                    "created": True,
                    "execution": self._exec,
                    "workspace_id": WS,
                }
            assert self._exec is not None
            return {
                "created": False,
                "execution": self._exec,
                "workspace_id": WS,
            }

    def finalize(self, input: dict[str, Any]) -> dict[str, Any]:
        self.finalize_calls += 1
        assert self._exec is not None
        self._exec = replace(
            self._exec,
            status=str(input["status"]),
            result_json=input.get("result_json"),
        )
        return {"changed": True, "execution": self._exec}


class FakeReader:
    def __init__(self) -> None:
        self.calls = 0

    def read(self, **kwargs: Any) -> dict[str, Any]:
        self.calls += 1
        return {
            "path": FILE_PATH,
            "binary": False,
            "content": "ok\n",
            "truncated": False,
            "offset": 0,
            "limit": 100,
            "size": 3,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }


class SpyReplayStore:
    """Counts consume(); optional forced unavailability."""

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
            raise ReplayStoreUnavailableError("redis down")
        return await self.inner.consume(**kwargs)


@pytest.fixture
def keyed_settings(monkeypatch: pytest.MonkeyPatch) -> Settings:
    s = Settings(
        database_url="sqlite:////tmp/files-read-http.db",
        allowed_client_cidrs=["127.0.0.1/32"],
        internal_hmac_keyring=_keyring_json(),
        internal_hmac_active_kid=KID,
        internal_token_leeway_seconds=0,
        api_token="",
        auth_enabled=False,
    )
    monkeypatch.setattr("sandbox.config.settings", s)
    monkeypatch.setattr("sandbox.security.internal_http_auth.settings", s)
    monkeypatch.setattr("sandbox.main.settings", s)
    return s


def _build_app(
    *,
    store: InMemoryReplayStore | None,
    runtime: FilesReadRuntime | None,
) -> FastAPI:
    app = FastAPI()
    set_replay_store(app, store)
    set_files_read_runtime(app, runtime)
    app.include_router(internal_files.router)
    return app


def _client(app: FastAPI) -> TestClient:
    return TestClient(app)


class TestSignedFilesRead:
    def test_valid_200(self, keyed_settings: Settings) -> None:
        body = body_bytes()
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        app = _build_app(store=InMemoryReplayStore(), runtime=runtime)
        token = make_token(body=body, jti="jti_ok_1")
        with _client(app) as client:
            # Freeze time for token window
            import sandbox.security.internal_http_auth as http_auth

            original = http_auth.time.time
            http_auth.time.time = lambda: NOW  # type: ignore[method-assign]
            try:
                resp = client.post(
                    PATH_HTTP,
                    content=body,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )
            finally:
                http_auth.time.time = original  # type: ignore[method-assign]
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["content"] == "ok\n"
        assert reader.calls == 1
        assert claim.finalize_calls == 1

    def test_body_raw_mismatch_401_before_runtime(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = body_bytes()
        other = body_bytes(body_obj(limit=99))  # different raw bytes
        # Token binds to `body` but we send `other`.
        token = make_token(body=body, jti="jti_mismatch_body")
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        app = _build_app(store=InMemoryReplayStore(), runtime=runtime)
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=other,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp.status_code == 401
        assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL
        assert reader.calls == 0
        assert claim.claim_calls == 0

    def test_semantic_hash_mismatch_rejects_before_claim_jti_consumed(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Valid HMAC body binding, but requestHash is wrong for path args.
        wrong_hash = "ab" * 32
        obj = body_obj(requestHash=wrong_hash)
        body = body_bytes(obj)
        token = make_token(
            body=body, jti="jti_sem_hash", request_hash=wrong_hash
        )
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        store = InMemoryReplayStore()
        app = _build_app(store=store, runtime=runtime)
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp.status_code == 400
        assert claim.claim_calls == 0
        assert reader.calls == 0
        # JTI already consumed by auth dependency
        with _client(app) as client:
            resp2 = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp2.status_code == 401

    def test_duplicate_json_key_rejects_before_claim(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        h = _req_hash()
        text = (
            '{"path":"%s","path":"%s","offset":0,"limit":100,"maxBytes":%d,'
            '"identity":{"orgId":"%s","userId":"%s","conversationId":"%s",'
            '"agentSessionId":"%s","runId":"%s","sandboxSessionId":"%s",'
            '"traceId":"%s","executionFenceToken":%d},"toolExecutionId":"%s",'
            '"toolCallId":"%s","requestHash":"%s","requestHashVersion":1}'
            % (
                FILE_PATH,
                FILE_PATH,
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
        body = text.encode("utf-8")
        token = make_token(body=body, jti="jti_dup", request_hash=h)
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        app = _build_app(store=InMemoryReplayStore(), runtime=runtime)
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp.status_code == 400
        assert claim.claim_calls == 0
        assert reader.calls == 0

    def test_runtime_missing_503(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = body_bytes()
        token = make_token(body=body, jti="jti_no_rt")
        app = _build_app(store=InMemoryReplayStore(), runtime=None)
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp.status_code == 503

    def test_legacy_api_key_cannot_access(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Real sandbox app: set API token; internal path must not accept it.
        s = Settings(
            database_url="sqlite:////tmp/files-read-legacy.db",
            allowed_client_cidrs=["127.0.0.1/32", "::1/128"],
            internal_hmac_keyring=_keyring_json(),
            internal_hmac_active_kid=KID,
            internal_token_leeway_seconds=0,
            api_token="legacy-secret-token",
            api_token_header="X-API-Key",
            auth_enabled=False,
        )
        monkeypatch.setattr("sandbox.config.settings", s)
        monkeypatch.setattr("sandbox.security.internal_http_auth.settings", s)
        monkeypatch.setattr("sandbox.main.settings", s)
        set_replay_store(sandbox_app, InMemoryReplayStore())
        set_files_read_runtime(sandbox_app, None)
        try:
            with TestClient(sandbox_app) as client:
                resp = client.post(
                    PATH_HTTP,
                    content=body_bytes(),
                    headers={
                        "X-API-Key": "legacy-secret-token",
                        "Content-Type": "application/json",
                    },
                )
            # No Bearer → internal auth 401 (not authenticated by API key).
            assert resp.status_code == 401
            assert resp.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL
        finally:
            set_replay_store(sandbox_app, None)
            set_files_read_runtime(sandbox_app, None)

    def test_concurrent_two_jti_reader_once(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = body_bytes()
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        app = _build_app(store=InMemoryReplayStore(), runtime=runtime)
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        t1 = make_token(body=body, jti="jti_c1")
        t2 = make_token(body=body, jti="jti_c2")
        results: list[int] = []

        def post(token: str) -> None:
            with _client(app) as client:
                r = client.post(
                    PATH_HTTP,
                    content=body,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json",
                    },
                )
                results.append(r.status_code)

        th1 = threading.Thread(target=post, args=(t1,))
        th2 = threading.Thread(target=post, args=(t2,))
        th1.start()
        th2.start()
        th1.join()
        th2.join()
        assert reader.calls == 1
        assert 200 in results
        assert all(s in (200, 409) for s in results)

    def test_content_length_over_16kib_413_before_replay_and_claim(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Declared Content-Length > 16 KiB → 413; replay consume=0, claim=0."""
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        over = FILES_READ_MAX_BODY_BYTES + 1
        body = b"x" * over
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        store = SpyReplayStore()
        app = _build_app(store=store, runtime=runtime)  # type: ignore[arg-type]
        # Token signed over oversized body; CL check happens before verify/replay.
        token = make_token(body=body, jti="jti_cl_16k")
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Content-Length": str(over),
                },
            )
        assert resp.status_code == 413
        assert resp.json()["detail"] == INTERNAL_BODY_TOO_LARGE_DETAIL
        assert store.calls == 0
        assert claim.claim_calls == 0
        assert reader.calls == 0

    @pytest.mark.asyncio
    async def test_chunked_body_over_16kib_413_before_replay_and_claim(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Stream without relying only on Content-Length: real bytes > 16 KiB → 413."""
        from fastapi import HTTPException
        from starlette.requests import Request as StarletteRequest

        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        store = SpyReplayStore()
        app = _build_app(store=store, runtime=runtime)  # type: ignore[arg-type]
        # Chunked stream over the endpoint cap (no Content-Length header).
        over = FILES_READ_MAX_BODY_BYTES + 64
        chunks = [b"a" * 4096, b"b" * 4096, b"c" * 4096, b"d" * 4096, b"e" * 64]
        assert sum(len(c) for c in chunks) == over
        token = make_token(body=b"unused", jti="jti_chunk_16k")

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
            "method": "POST",
            "scheme": "http",
            "path": PATH_HTTP,
            "raw_path": PATH_HTTP.encode("ascii"),
            "query_string": b"",
            "headers": [
                (b"authorization", f"Bearer {token}".encode("ascii")),
                # No content-length — stream must still be hard-capped.
            ],
            "client": ("127.0.0.1", 50000),
            "server": ("test", 80),
            "app": app,
        }
        request = StarletteRequest(scope, receive)

        # Same dependency the route mounts (16 KiB endpoint cap).
        dep = internal_files._auth_dep  # noqa: SLF001
        with pytest.raises(HTTPException) as ei:
            await dep(request)
        assert ei.value.status_code == 413
        assert ei.value.detail == INTERNAL_BODY_TOO_LARGE_DETAIL
        assert store.calls == 0
        assert claim.claim_calls == 0
        assert reader.calls == 0

    def test_replay_store_unavailable_503_no_claim(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = body_bytes()
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        store = SpyReplayStore(fail=True)
        app = _build_app(store=store, runtime=runtime)  # type: ignore[arg-type]
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        token = make_token(body=body, jti="jti_redis_down")
        with _client(app) as client:
            resp = client.post(
                PATH_HTTP,
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )
        assert resp.status_code == 503
        assert resp.json()["detail"] == INTERNAL_SERVICE_UNAVAILABLE_DETAIL
        assert "redis" not in resp.text.lower()
        assert store.calls == 1  # consume attempted then unavailable
        assert claim.claim_calls == 0
        assert reader.calls == 0

    def test_duplicate_jti_401_no_claim(
        self, keyed_settings: Settings, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        body = body_bytes()
        claim = FakeClaimValidator()
        reader = FakeReader()
        runtime = FilesReadRuntime(
            claim_validator=claim,
            reader=reader,
            id_factory=new_ulid,
            supervisor=InternalExecutionSupervisor(),
        )
        store = SpyReplayStore()
        app = _build_app(store=store, runtime=runtime)  # type: ignore[arg-type]
        import sandbox.security.internal_http_auth as http_auth

        monkeypatch.setattr(http_auth.time, "time", lambda: NOW)
        token = make_token(body=body, jti="jti_dup_files")
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        with _client(app) as client:
            first = client.post(PATH_HTTP, content=body, headers=headers)
            second = client.post(PATH_HTTP, content=body, headers=headers)
        assert first.status_code == 200
        assert second.status_code == 401
        assert second.json()["detail"] == INTERNAL_AUTH_HTTP_DETAIL
        # First request claimed once; duplicate never reaches runtime claim.
        assert claim.claim_calls == 1
        assert store.calls == 2
