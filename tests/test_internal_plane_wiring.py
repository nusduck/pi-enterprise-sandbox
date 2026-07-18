"""Offline unit tests for internal-plane production wiring (PR-07).

No network, no real Redis/MySQL, no redis package required (factories injected).
Covers: to_thread + real timeout for sync MySQL ping, partial cleanup,
concurrent stop, inflight drain, secret redaction, production fail-closed,
readiness consistency when plane enabled.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from contextlib import contextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from sandbox.config import Settings, validate_production_settings, ProductionConfigError
from sandbox.services.internal_plane_resources import (
    CATEGORY_MYSQL_PING,
    CATEGORY_MYSQL_PING_TIMEOUT,
    CATEGORY_REDIS_PING,
    InternalPlaneError,
    InternalPlaneState,
    evaluate_internal_plane_readiness,
    get_internal_plane_bundle,
    register_internal_plane_bundle,
)
from sandbox.services.internal_plane_wiring import (
    FastApiInternalPlaneTarget,
    start_internal_plane,
    stop_internal_plane,
)
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor


def _hmac() -> tuple[str, str]:
    key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")
    return json.dumps({"kid-1": key}), "kid-1"


def _settings(**overrides: Any) -> Settings:
    kr, kid = _hmac()
    base: dict[str, Any] = {
        "deployment_env": "development",
        "database_url": "mysql+pymysql://sandbox@127.0.0.1:3306/sandbox",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
        "internal_plane_enabled": True,
        "internal_redis_url": "redis://:SuperSecretReplay@sandbox-replay-redis:6379/0",
        "internal_hmac_keyring": kr,
        "internal_hmac_active_kid": kid,
        "internal_max_concurrency": 8,
        "internal_drain_timeout_seconds": 0.5,
        "mysql_connect_timeout_seconds": 2,
    }
    base.update(overrides)
    return Settings(**base)


class _AsyncRedis:
    def __init__(self, url: str, *, ok: bool = True) -> None:
        self.url = url
        self.ok = ok
        self.closed = False
        self.ping_n = 0

    async def ping(self) -> bool:
        self.ping_n += 1
        if not self.ok:
            raise ConnectionError(
                f"Error connecting to {self.url} password=SuperSecretRedis"
            )
        return True

    async def set(self, *a: Any, **k: Any) -> bool:
        return True

    async def aclose(self) -> None:
        self.closed = True


class _SlowSyncMysql:
    def __init__(self, url: str, **kwargs: Any) -> None:
        self.url = url
        self.kwargs = kwargs
        self.closed = False
        self.ping_delay = 0.0
        self.ping_ok = True

    def ping(self) -> bool:
        if self.ping_delay:
            time.sleep(self.ping_delay)
        return self.ping_ok

    @contextmanager
    def connection(self):
        yield _ProbeConn()

    def close(self) -> None:
        self.closed = True


class _ProbeConn:
    def execute(self, sql: str, params: Any = None) -> None:
        self._row = {"name": (params or ("x",))[-1]}

    def fetchone(self) -> dict[str, Any]:
        return getattr(self, "_row", {"name": "ok"})

    def fetchall(self) -> list[dict[str, Any]]:
        return [self.fetchone()]

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


class _ClaimValidator:
    def __init__(self, db: Any) -> None:
        self.db = db
        self.probed = False

    def ensure_claim_schema_capability(self, conn: Any) -> None:
        self.probed = True
        if conn is not None:
            conn.execute(
                "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s "
                "AND COLUMN_NAME = %s LIMIT 1",
                ("sandbox_executions", "tool_execution_id"),
            )


class _FakeApp:
    def __init__(self) -> None:
        self.state = SimpleNamespace()


def _factories(
    *,
    redis_ok: bool = True,
    mysql_ping_ok: bool = True,
    mysql_delay: float = 0.0,
    closed: list[str] | None = None,
) -> dict[str, Any]:
    closed = closed if closed is not None else []
    redis_clients: list[_AsyncRedis] = []

    async def redis_factory(url: str) -> _AsyncRedis:
        c = _AsyncRedis(url, ok=redis_ok)
        redis_clients.append(c)
        return c

    def mysql_factory(url: str, **kw: Any) -> _SlowSyncMysql:
        m = _SlowSyncMysql(url, **kw)
        m.ping_ok = mysql_ping_ok
        m.ping_delay = mysql_delay
        return m

    async def close_redis(c: Any) -> None:
        closed.append("redis")
        await c.aclose()

    def close_mysql(d: Any) -> None:
        closed.append("mysql")
        d.close()

    return {
        "redis_factory": redis_factory,
        "replay_store_factory": lambda c: SimpleNamespace(client=c),
        "mysql_factory": mysql_factory,
        "claim_validator_factory": lambda db: _ClaimValidator(db),
        "close_redis": close_redis,
        "close_mysql": close_mysql,
        "_redis_clients": redis_clients,
        "_closed": closed,
    }


@pytest.fixture(autouse=True)
def _clear_registry():
    register_internal_plane_bundle(None)
    yield
    register_internal_plane_bundle(None)


class TestSyncMysqlTimeoutOffLoop:
    @pytest.mark.asyncio
    async def test_slow_sync_ping_times_out_without_blocking_loop(self) -> None:
        """wait_for + to_thread must bound sync ping; event loop stays responsive."""
        fac = _factories(mysql_delay=2.0)
        app = _FakeApp()
        settings = _settings(mysql_connect_timeout_seconds=1)

        progress = 0

        async def ticker() -> None:
            nonlocal progress
            for _ in range(20):
                await asyncio.sleep(0.05)
                progress += 1

        t = asyncio.create_task(ticker())
        with pytest.raises(InternalPlaneError) as ei:
            await start_internal_plane(
                app,
                settings,
                redis_factory=fac["redis_factory"],
                replay_store_factory=fac["replay_store_factory"],
                mysql_factory=fac["mysql_factory"],
                claim_validator_factory=fac["claim_validator_factory"],
                close_redis=fac["close_redis"],
                close_mysql=fac["close_mysql"],
            )
        await t
        assert ei.value.category in (
            CATEGORY_MYSQL_PING_TIMEOUT,
            CATEGORY_MYSQL_PING,
        )
        # Loop kept scheduling the ticker while ping ran in a thread.
        assert progress >= 5
        assert "SuperSecret" not in str(ei.value)
        # Redis created then closed on prepare rollback.
        assert fac["_redis_clients"][0].closed is True


class TestWiringLifecycle:
    @pytest.mark.asyncio
    async def test_disabled_registers_without_factories(self) -> None:
        calls: list[str] = []

        async def redis_factory(url: str) -> Any:
            calls.append("redis")
            return _AsyncRedis(url)

        app = _FakeApp()
        s = _settings(internal_plane_enabled=False)
        bundle = await start_internal_plane(
            app, s, redis_factory=redis_factory
        )
        assert bundle.state is InternalPlaneState.DISABLED
        assert calls == []
        assert evaluate_internal_plane_readiness(bundle, enabled=False) is True
        assert get_internal_plane_bundle() is bundle

    @pytest.mark.asyncio
    async def test_enabled_installs_runtime_and_replay_slots(self) -> None:
        fac = _factories()
        app = _FakeApp()
        s = _settings()
        bundle = await start_internal_plane(
            app,
            s,
            redis_factory=fac["redis_factory"],
            replay_store_factory=fac["replay_store_factory"],
            mysql_factory=fac["mysql_factory"],
            claim_validator_factory=fac["claim_validator_factory"],
            close_redis=fac["close_redis"],
            close_mysql=fac["close_mysql"],
        )
        assert bundle.state is InternalPlaneState.INSTALLED
        assert get_internal_plane_bundle() is bundle
        assert getattr(app.state, "internal_replay_store", None) is not None
        assert getattr(app.state, "files_read_runtime", None) is not None
        runtime = app.state.files_read_runtime
        assert runtime.claim_validator.probed is True
        assert fac["_redis_clients"][0].ping_n >= 1

        await stop_internal_plane(bundle)
        assert get_internal_plane_bundle() is None
        assert app.state.internal_replay_store is None
        assert app.state.files_read_runtime is None
        assert fac["_redis_clients"][0].closed is True
        assert "redis" in fac["_closed"] and "mysql" in fac["_closed"]

    @pytest.mark.asyncio
    async def test_partial_failure_cleanup_closes_redis(self) -> None:
        fac = _factories(mysql_ping_ok=False)
        app = _FakeApp()
        with pytest.raises(InternalPlaneError) as ei:
            await start_internal_plane(
                app,
                _settings(),
                redis_factory=fac["redis_factory"],
                replay_store_factory=fac["replay_store_factory"],
                mysql_factory=fac["mysql_factory"],
                claim_validator_factory=fac["claim_validator_factory"],
                close_redis=fac["close_redis"],
                close_mysql=fac["close_mysql"],
            )
        assert ei.value.category == CATEGORY_MYSQL_PING
        assert fac["_redis_clients"][0].closed is True
        assert getattr(app.state, "files_read_runtime", None) is None
        assert getattr(app.state, "internal_replay_store", None) is None

    @pytest.mark.asyncio
    async def test_secret_bearing_errors_redacted(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        fac = _factories(redis_ok=False)
        with caplog.at_level(logging.WARNING):
            with pytest.raises(InternalPlaneError) as ei:
                await start_internal_plane(
                    _FakeApp(),
                    _settings(),
                    redis_factory=fac["redis_factory"],
                    replay_store_factory=fac["replay_store_factory"],
                    mysql_factory=fac["mysql_factory"],
                    claim_validator_factory=fac["claim_validator_factory"],
                    close_redis=fac["close_redis"],
                    close_mysql=fac["close_mysql"],
                )
        assert ei.value.category == CATEGORY_REDIS_PING
        assert "SuperSecretRedis" not in str(ei.value)
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "SuperSecretRedis" not in joined
        assert "redis://:" not in joined

    @pytest.mark.asyncio
    async def test_inflight_drain_on_shutdown(self) -> None:
        fac = _factories()
        app = _FakeApp()
        supervisor = InternalExecutionSupervisor(max_active=4)
        held = asyncio.Event()
        release = asyncio.Event()

        async def long_job() -> str:
            held.set()
            await release.wait()
            return "done"

        bundle = await start_internal_plane(
            app,
            _settings(internal_drain_timeout_seconds=2.0),
            redis_factory=fac["redis_factory"],
            replay_store_factory=fac["replay_store_factory"],
            mysql_factory=fac["mysql_factory"],
            claim_validator_factory=fac["claim_validator_factory"],
            close_redis=fac["close_redis"],
            close_mysql=fac["close_mysql"],
            supervisor=supervisor,
        )
        # Use the installed supervisor (same instance)
        task = supervisor.spawn(long_job())
        await held.wait()
        # Stop admit path + drain
        stop_task = asyncio.create_task(stop_internal_plane(bundle))
        await asyncio.sleep(0.05)
        # Slots fail closed while drain waits
        assert app.state.files_read_runtime is None
        assert app.state.internal_replay_store is None
        release.set()
        await stop_task
        assert await task == "done"
        assert supervisor.state in ("CLOSED", "CLOSING")
        assert fac["_redis_clients"][0].closed is True

    @pytest.mark.asyncio
    async def test_concurrent_stop_is_idempotent(self) -> None:
        fac = _factories()
        app = _FakeApp()
        bundle = await start_internal_plane(
            app,
            _settings(),
            redis_factory=fac["redis_factory"],
            replay_store_factory=fac["replay_store_factory"],
            mysql_factory=fac["mysql_factory"],
            claim_validator_factory=fac["claim_validator_factory"],
            close_redis=fac["close_redis"],
            close_mysql=fac["close_mysql"],
        )
        await asyncio.gather(
            stop_internal_plane(bundle),
            stop_internal_plane(bundle),
        )
        assert bundle.state is InternalPlaneState.CLOSED
        assert get_internal_plane_bundle() is None


class TestProductionConfigFailClosed:
    def test_production_requires_internal_plane_enabled(self) -> None:
        kr, kid = _hmac()
        s = Settings(
            deployment_env="production",
            api_token="t" * 64,
            auth_enabled=True,
            jwt_secret="j" * 64,
            jwt_issuer="pi-enterprise-sandbox",
            jwt_audience="pi-enterprise-sandbox",
            auth_allow_public_register=False,
            network_mode="disabled",
            isolation_backend="bubblewrap",
            isolation_required=True,
            cors_origins=["https://app.example.com"],
            debug=False,
            database_url="mysql+pymysql://sandbox@mysql:3306/sandbox",
            allowed_client_cidrs=["127.0.0.1/32"],
            internal_plane_enabled=False,
            internal_redis_url="redis://:x@sandbox-replay-redis:6379/0",
            internal_hmac_keyring=kr,
            internal_hmac_active_kid=kid,
        )
        with pytest.raises(ProductionConfigError, match="INTERNAL_PLANE_ENABLED"):
            validate_production_settings(s)

    def test_production_requires_internal_redis_when_enabled(self) -> None:
        kr, kid = _hmac()
        s = Settings(
            deployment_env="production",
            api_token="t" * 64,
            auth_enabled=True,
            jwt_secret="j" * 64,
            jwt_issuer="pi-enterprise-sandbox",
            jwt_audience="pi-enterprise-sandbox",
            auth_allow_public_register=False,
            network_mode="disabled",
            isolation_backend="bubblewrap",
            isolation_required=True,
            cors_origins=["https://app.example.com"],
            debug=False,
            database_url="mysql+pymysql://sandbox@mysql:3306/sandbox",
            allowed_client_cidrs=["127.0.0.1/32"],
            internal_plane_enabled=True,
            internal_redis_url="",
            internal_hmac_keyring=kr,
            internal_hmac_active_kid=kid,
        )
        with pytest.raises(ProductionConfigError, match="INTERNAL_REDIS|internal plane"):
            validate_production_settings(s)


class TestReadinessConsistency:
    def test_enabled_without_installed_bundle_not_ready(self) -> None:
        assert (
            evaluate_internal_plane_readiness(None, enabled=True) is False
        )

    @pytest.mark.asyncio
    async def test_enabled_installed_matches_bundle_ready(self) -> None:
        fac = _factories()
        app = _FakeApp()
        bundle = await start_internal_plane(
            app,
            _settings(),
            redis_factory=fac["redis_factory"],
            replay_store_factory=fac["replay_store_factory"],
            mysql_factory=fac["mysql_factory"],
            claim_validator_factory=fac["claim_validator_factory"],
            close_redis=fac["close_redis"],
            close_mysql=fac["close_mysql"],
        )
        assert bundle.is_bundle_ready() is True
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is True
        await stop_internal_plane(bundle)
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is False


class TestFastApiTargetAtomicRuntime:
    def test_clear_claim_clears_runtime(self) -> None:
        app = _FakeApp()
        sup = InternalExecutionSupervisor(max_active=2)
        target = FastApiInternalPlaneTarget(app, supervisor=sup)
        target.set_mysql_database(object())
        target.set_claim_validator(_ClaimValidator(object()))
        assert app.state.files_read_runtime is not None
        target.set_claim_validator(None)
        assert app.state.files_read_runtime is None


class TestShutdownReconcile:
    @pytest.mark.asyncio
    async def test_drain_timeout_reconciles_unknown_before_close(self) -> None:
        """Incomplete drain must mark inflight UNKNOWN while MySQL still open."""
        from sandbox.services.files_read_runtime import FilesReadRuntime
        from sandbox.services.internal_plane_resources import InternalPlaneResources
        from sandbox.services.internal_plane_resources import InternalPlaneConfigView

        closed: list[str] = []
        reconciled: list[str] = []

        class ClaimV:
            def mark_unknown_for_crash_recovery(self, payload: dict[str, Any]) -> dict:
                reconciled.append(str(payload["execution_id"]))
                return {"changed": True}

            def claim(self, *a: Any, **k: Any) -> Any:
                raise AssertionError("not used")

            def finalize(self, *a: Any, **k: Any) -> Any:
                raise AssertionError("not used")

        class SlowDrain:
            async def close_and_drain(self, timeout: float) -> bool:
                await asyncio.sleep(5.0)
                return True

        # Build a runtime with one inflight claim
        claim_v = ClaimV()
        runtime = FilesReadRuntime(
            claim_validator=claim_v,
            reader=object(),
            id_factory=lambda: "01K0G2PAV8FPMVC9QHJG7JPN60",
            supervisor=InternalExecutionSupervisor(max_active=2),
        )
        from sandbox.app.domain.types import ExecutionRecord

        # Minimal register via public helpers
        class Cmd:
            org_id = "o"
            user_id = "u"
            execution_fence_token = 1

        class Exec:
            execution_id = "01K0G2PAV8FPMVC9QHJG7JPN60"

        runtime._register_inflight(Cmd(), Exec())  # type: ignore[arg-type]
        assert runtime.inflight_claim_count() == 1

        async def drain_fn() -> bool:
            return await SlowDrain().close_and_drain(5.0)

        async def reconcile_fn() -> int:
            return await asyncio.to_thread(runtime.reconcile_inflight_as_unknown)

        cfg = InternalPlaneConfigView(
            enabled=True,
            internal_redis_url="redis://:pw@sandbox-replay-redis:6379/0",
            database_url="mysql+pymysql://u@h/db",
            internal_drain_timeout_seconds=0.05,
        )
        redis_c = _AsyncRedis("redis://x")
        mysql = _SlowSyncMysql("mysql://x")

        async def redis_factory(url: str) -> _AsyncRedis:
            return redis_c

        def mysql_factory(url: str, **kw: Any) -> _SlowSyncMysql:
            return mysql

        async def close_redis(c: Any) -> None:
            closed.append("redis")
            await c.aclose()

        def close_mysql(d: Any) -> None:
            closed.append("mysql")
            # MySQL still open at reconcile time: closed only after.
            assert len(reconciled) >= 1
            d.close()

        bundle = InternalPlaneResources(
            cfg,
            redis_factory=redis_factory,
            replay_store_factory=lambda c: SimpleNamespace(client=c),
            mysql_factory=mysql_factory,
            claim_validator_factory=lambda db: ClaimV(),
            close_redis=close_redis,
            close_mysql=close_mysql,
            drain_fn=drain_fn,
            reconcile_fn=reconcile_fn,
            redis_ping_timeout_seconds=1.0,
            mysql_ping_timeout_seconds=1.0,
            close_timeout_seconds=2.0,
            reconcile_timeout_seconds=2.0,
        )
        await bundle.prepare()
        # Inject prepared claim path already done; just uninstall with drain timeout
        await bundle.uninstall()
        assert reconciled == ["01K0G2PAV8FPMVC9QHJG7JPN60"]
        assert "mysql" in closed and "redis" in closed
        assert runtime.inflight_claim_count() == 0
