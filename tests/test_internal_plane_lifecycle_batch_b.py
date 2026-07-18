"""PR-07B production lifecycle Batch B — hermetic unit tests.

Covers: DEPLOYMENT_ENV fail-closed, mysql:// + mysql+pymysql DSN gate,
PyMySQL timeouts/bounds/passive ping (no DDL), claim schema probe,
typed internal_plane config + pure validate_internal_plane_config,
injectable internal_plane_resources state machine + readiness.

No redis import side effects, no network, no real MySQL, no lifespan wiring.
"""

from __future__ import annotations

import ast
import asyncio
import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from sandbox.app.persistence.db import (
    MysqlDatabase,
    assert_mysql_connection_url,
    parse_mysql_url,
)
from sandbox.app.persistence.errors import MysqlConfigError, SchemaGapError
from sandbox.app.persistence.repositories.tool_execution_claim_validator import (
    ToolExecutionClaimValidator,
)
from sandbox.config import (
    Settings,
    effective_config,
    validate_internal_plane_config,
)
from sandbox.services.internal_plane_resources import (
    CATEGORY_INSTALL,
    CATEGORY_MYSQL_PING,
    CATEGORY_REDIS_PING,
    CATEGORY_REDIS_PING_TIMEOUT,
    DictInstallTarget,
    InternalPlaneConfigView,
    InternalPlaneError,
    InternalPlaneResources,
    InternalPlaneState,
    evaluate_internal_plane_readiness,
    get_internal_plane_bundle,
    maybe_await,
    register_internal_plane_bundle,
)

ROOT = Path(__file__).resolve().parents[1]
RESOURCES_PATH = ROOT / "sandbox" / "services" / "internal_plane_resources.py"


def _strong_secret(seed: str = "a") -> str:
    return (seed * 64)[:64]


def _base_settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "deployment_env": "development",
        "database_url": "mysql+pymysql://sandbox@127.0.0.1:3306/sandbox",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
    }
    base.update(overrides)
    return Settings(**base)


# ── B0: DEPLOYMENT_ENV ──────────────────────────────────────────────────────


class TestDeploymentEnvFailClosed:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("development", "development"),
            ("dev", "development"),
            ("local", "development"),
            ("test", "test"),
            ("production", "production"),
            ("prod", "production"),
            (" DEVELOPMENT ", "development"),
            ("Prod", "production"),
        ],
    )
    def test_accepts_canonical_and_legal_aliases(self, raw: str, expected: str) -> None:
        s = _base_settings(deployment_env=raw)
        assert s.deployment_env == expected

    @pytest.mark.parametrize(
        "raw",
        [
            "",
            "   ",
            "producton",  # typo must not degrade to development
            "staging",
            "prodution",
            "productionn",
            "0",
            "false",
            "Development!",
        ],
    )
    def test_unknown_and_empty_fail_closed(self, raw: str) -> None:
        with pytest.raises(ValueError, match="DEPLOYMENT_ENV"):
            _base_settings(deployment_env=raw)

    def test_explicit_null_fails(self) -> None:
        with pytest.raises(ValueError, match="DEPLOYMENT_ENV"):
            _base_settings(deployment_env=None)

    def test_env_typo_does_not_become_development(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DEPLOYMENT_ENV", "producton")
        with pytest.raises(ValueError, match="producton|DEPLOYMENT_ENV"):
            Settings(
                database_url="mysql+pymysql://sandbox@127.0.0.1:3306/sandbox",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_explicit_empty_env_fails_closed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DEPLOYMENT_ENV", "")
        with pytest.raises(ValueError, match="empty|DEPLOYMENT_ENV"):
            Settings(
                database_url="mysql+pymysql://sandbox@127.0.0.1:3306/sandbox",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_test_is_not_production(self) -> None:
        s = _base_settings(deployment_env="test")
        assert s.deployment_env == "test"
        assert s.is_production is False
        assert s.is_development is False


# ── B1: DSN gate ────────────────────────────────────────────────────────────


class TestMysqlDsnBothSchemes:
    def test_accepts_mysql_and_pymysql(self) -> None:
        for url in (
            "mysql://u:p@h:3306/db",
            "mysql+pymysql://u:p@h:3306/db",
        ):
            assert assert_mysql_connection_url(url) == url

    def test_rejects_mysql2_sqlite_postgres(self) -> None:
        for url in (
            "mysql2://u:p@h:3306/db",
            "mysql+aiomysql://u:p@h:3306/db",
            "sqlite:////tmp/x.db",
            "postgresql://u:p@h/db",
            "postgres://u:p@h/db",
            "",
        ):
            with pytest.raises(MysqlConfigError):
                assert_mysql_connection_url(url)

    def test_parse_both_schemes_same_kwargs(self) -> None:
        a = parse_mysql_url("mysql://u:secret@host:3307/sandbox")
        b = parse_mysql_url("mysql+pymysql://u:secret@host:3307/sandbox")
        assert a == b
        assert a["host"] == "host"
        assert a["port"] == 3307
        assert a["database"] == "sandbox"
        assert a["password"] == "secret"
        assert a["connect_timeout"] >= 1
        assert a["read_timeout"] >= 1
        assert a["write_timeout"] >= 1

    def test_error_never_echoes_password(self) -> None:
        secret = "mysql2://admin:SuperSecretPassw0rd@db:3306/prod"
        with pytest.raises(MysqlConfigError) as ei:
            assert_mysql_connection_url(secret)
        assert "SuperSecretPassw0rd" not in str(ei.value)
        assert secret not in str(ei.value)


# ── B2: timeouts / bounds / ping / no DDL + claim probe ─────────────────────


class TestMysqlDatabaseBounds:
    def test_connect_kwargs_include_timeouts(self) -> None:
        db = MysqlDatabase(
            "mysql+pymysql://u:p@localhost:3306/sandbox",
            connect_timeout=3,
            read_timeout=11,
            write_timeout=13,
            max_connections=2,
        )
        kwargs = db._safe_connect_kwargs()
        assert kwargs["connect_timeout"] == 3
        assert kwargs["read_timeout"] == 11
        assert kwargs["write_timeout"] == 13
        assert db.max_connections == 2

    def test_invalid_max_connections_fails(self) -> None:
        with pytest.raises(MysqlConfigError, match="max_connections"):
            MysqlDatabase("mysql://u:p@localhost:3306/sandbox", max_connections=0)

    def test_passive_ping_uses_select_no_reconnect_default(self) -> None:
        pings: list[bool] = []

        class FakeRaw:
            def __init__(self) -> None:
                self.closed = False

            def cursor(self, *_a: Any, **_k: Any) -> Any:
                return self

            def execute(self, sql: str, params: Any = None) -> None:
                assert "SELECT" in sql.upper()
                self._row = {"1": 1}

            def fetchone(self) -> dict[str, Any]:
                return getattr(self, "_row", {"1": 1})

            def fetchall(self) -> list[dict[str, Any]]:
                return [self.fetchone()]

            def commit(self) -> None:
                pass

            def rollback(self) -> None:
                pass

            def close(self) -> None:
                self.closed = True

            def ping(self, *, reconnect: bool = True) -> None:
                pings.append(reconnect)
                if reconnect:
                    raise AssertionError("passive ping must not reconnect=True")

        def connect_fn(**_kwargs: Any) -> FakeRaw:
            return FakeRaw()

        db = MysqlDatabase(
            "mysql://u:p@localhost:3306/sandbox",
            connect_fn=connect_fn,
            max_connections=2,
        )
        assert db.ping() is True
        # If driver ping path used, reconnect must be False.
        assert all(r is False for r in pings)

    def test_module_has_no_ddl_helpers(self) -> None:
        import sandbox.app.persistence.db as dbmod

        for name in ("migrate", "create_table", "execute_ddl", "schema_create"):
            assert not hasattr(dbmod, name)
        src = (ROOT / "sandbox" / "app" / "persistence" / "db.py").read_text()
        assert "CREATE TABLE" not in src.upper()
        assert "ALTER TABLE" not in src.upper()


class _CapConn:
    def __init__(self, *, capable: bool = True, missing: set[str] | None = None) -> None:
        self.capable = capable
        self.missing = missing or set()
        self._row: dict[str, Any] | None = None
        self.statements: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        params_t = tuple(params or ())
        self.statements.append((sql, params_t))
        upper = " ".join(sql.split()).upper()
        assert "INSERT" not in upper and "UPDATE" not in upper and "DELETE" not in upper
        assert "CREATE" not in upper and "ALTER" not in upper
        if not self.capable:
            self._row = None
            return
        if "INFORMATION_SCHEMA.COLUMNS" in upper:
            key = f"column:{params_t[0]}.{params_t[1]}"
            self._row = None if key in self.missing else {"name": params_t[1]}
        elif "INFORMATION_SCHEMA.STATISTICS" in upper:
            key = f"index:{params_t[0]}.{params_t[1]}"
            self._row = None if key in self.missing else {"name": params_t[1]}
        else:
            self._row = None

    def fetchone(self) -> dict[str, Any] | None:
        return self._row

    def fetchall(self) -> list[dict[str, Any]]:
        return [self._row] if self._row else []

    def commit(self) -> None:
        pass

    def rollback(self) -> None:
        pass

    def close(self) -> None:
        pass


class _CapDb:
    def __init__(self, conn: _CapConn) -> None:
        self.conn = conn

    @contextmanager
    def transaction(self):
        yield self.conn

    @contextmanager
    def connection(self):
        yield self.conn


class TestClaimSchemaCapabilityProbe:
    def test_probe_succeeds_when_schema_present(self) -> None:
        conn = _CapConn(capable=True)
        db = _CapDb(conn)
        v = ToolExecutionClaimValidator(db)
        v.probe_claim_schema_capability(conn)
        assert v._schema_capable is True
        assert any("INFORMATION_SCHEMA.COLUMNS" in s[0].upper() for s in conn.statements)
        assert any("INFORMATION_SCHEMA.STATISTICS" in s[0].upper() for s in conn.statements)

    def test_probe_fail_closed_when_index_missing(self) -> None:
        conn = _CapConn(
            capable=True,
            missing={"index:sandbox_executions.uk_sandbox_execution_run_tool_call"},
        )
        v = ToolExecutionClaimValidator(_CapDb(conn))
        with pytest.raises(SchemaGapError, match="fail closed|missing"):
            v.probe_claim_schema_capability(conn)
        assert v._schema_capable is False

    def test_claim_runs_probe_and_fail_closed(self) -> None:
        conn = _CapConn(capable=False)
        v = ToolExecutionClaimValidator(_CapDb(conn))
        with pytest.raises(SchemaGapError):
            v.claim(
                {
                    "org_id": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
                    "user_id": "01K0G2PAV8FPMVC9QHJG7JPN50",
                    "execution_id": "01K0G2PAV8FPMVC9QHJG7JPN60",
                    "sandbox_session_id": "01K0G2PAV8FPMVC9QHJG7JPN55",
                    "run_id": "01K0G2PAV8FPMVC9QHJG7JPN53",
                    "agent_session_id": "01K0G2PAV8FPMVC9QHJG7JPN52",
                    "conversation_id": "01K0G2PAV8FPMVC9QHJG7JPN51",
                    "tool_execution_id": "01K0G2PAV8FPMVC9QHJG7JPN5K",
                    "tool_call_id": "tc-1",
                    "tool_name": "read",
                    "kind": "read",
                    "request_hash": "a" * 64,
                    "request_hash_version": 1,
                    "execution_fence_token": 1,
                }
            )


# ── B3: typed config + pure validate ────────────────────────────────────────


class TestInternalPlaneConfig:
    def test_default_disabled(self) -> None:
        s = _base_settings()
        assert s.internal_plane_enabled is False
        assert s.internal_redis_url == ""
        assert s.mysql_connect_timeout_seconds == 5
        assert s.mysql_read_timeout_seconds == 30
        assert s.mysql_write_timeout_seconds == 30
        assert s.mysql_max_connections == 8
        assert s.internal_max_concurrency == 64
        assert s.internal_drain_timeout_seconds == 30.0
        validate_internal_plane_config(s)  # no raise when disabled

    def test_enabled_requires_redis_and_hmac(self) -> None:
        s = _base_settings(internal_plane_enabled=True)
        with pytest.raises(ValueError, match="INTERNAL_REDIS|HMAC|internal plane"):
            validate_internal_plane_config(s)

    def test_enabled_ok_with_full_config(self) -> None:
        # 32-byte key material as unpadded base64url
        import base64

        key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")
        s = _base_settings(
            internal_plane_enabled=True,
            internal_redis_url="redis://:s3cretReplayOnly@sandbox-replay-redis:6379/0",
            internal_hmac_keyring=f'{{"kid-1":"{key}"}}',
            internal_hmac_active_kid="kid-1",
            database_url="mysql+pymysql://sandbox@mysql:3306/sandbox",
        )
        validate_internal_plane_config(s)

    def test_redis_url_redacted_in_effective_config(self) -> None:
        s = _base_settings(
            internal_redis_url="redis://:SuperSecretReplay@sandbox-replay-redis:6379/0",
        )
        snap = effective_config(s)
        assert "SuperSecretRedis" not in str(snap)
        assert snap["internal_redis_url"] != s.internal_redis_url
        assert "redis" in str(snap["internal_redis_url"]).lower()

    def test_invalid_timeouts_rejected(self) -> None:
        with pytest.raises(ValueError):
            _base_settings(mysql_connect_timeout_seconds=0)
        with pytest.raises(ValueError):
            _base_settings(mysql_max_connections=0)
        with pytest.raises(ValueError):
            _base_settings(internal_max_concurrency=0)
        with pytest.raises(ValueError):
            _base_settings(internal_drain_timeout_seconds=-1)

    def test_validate_is_pure_no_redis_import(self) -> None:
        # Module must not import redis at import time.
        src = RESOURCES_PATH.read_text()
        tree = ast.parse(src)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] != "redis"
            if isinstance(node, ast.ImportFrom) and node.module:
                assert node.module.split(".")[0] != "redis"


# ── B4/B5: resources bundle (async lifecycle) ───────────────────────────────


class _AsyncRedis:
    """redis.asyncio-shaped client: awaitable ping/set/aclose."""

    def __init__(self, url: str, *, ping_ok: bool = True, ping_delay: float = 0.0) -> None:
        self.url = url
        self.ping_ok = ping_ok
        self.ping_delay = ping_delay
        self.closed = False
        self.ping_calls = 0
        self.set_calls = 0

    async def ping(self) -> bool:
        self.ping_calls += 1
        if self.ping_delay:
            await asyncio.sleep(self.ping_delay)
        if not self.ping_ok:
            raise ConnectionError(
                f"Error 111 connecting to redis at {self.url}: Connection refused"
            )
        return True

    async def set(self, key: str, value: str, *, nx: bool = False, ex: int = 0) -> bool:
        self.set_calls += 1
        return True

    async def aclose(self) -> None:
        self.closed = True

    def close(self) -> None:  # sync path must not be preferred for async clients
        raise AssertionError("sync close must not be used for async redis")


class _FakeReplay:
    def __init__(self, client: Any) -> None:
        self.client = client

    async def consume(self, **_kwargs: Any) -> bool:
        return bool(await self.client.set("k", "1", nx=True, ex=1))


class _FakeMysql:
    def __init__(self, url: str, **kwargs: Any) -> None:
        self.url = url
        self.kwargs = kwargs
        self.closed = False
        self.ping_ok = True
        self.ping_delay = 0.0
        self.ping_raises: Exception | None = None

    def ping(self) -> bool:
        if self.ping_delay:
            # sync sleep for timeout tests via async wait_for on maybe_await
            import time

            time.sleep(self.ping_delay)
        if self.ping_raises is not None:
            raise self.ping_raises
        return self.ping_ok

    @contextmanager
    def connection(self):
        yield _CapConn(capable=True)

    def close(self) -> None:
        self.closed = True


class _AsyncMysql:
    """Awaitable mysql ping/close variant."""

    def __init__(self, url: str, **kwargs: Any) -> None:
        self.url = url
        self.kwargs = kwargs
        self.closed = False
        self.ping_ok = True

    async def ping(self) -> bool:
        return self.ping_ok

    @contextmanager
    def connection(self):
        yield _CapConn(capable=True)

    async def aclose(self) -> None:
        self.closed = True


class _FakeClaimValidator:
    def __init__(self, db: Any) -> None:
        self.db = db
        self.probed = False

    def ensure_claim_schema_capability(self, conn: Any) -> None:
        self.probed = True
        if conn is not None:
            conn.execute(
                "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS "
                "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s AND COLUMN_NAME = %s LIMIT 1",
                ("sandbox_executions", "tool_execution_id"),
            )


def _enabled_config(**overrides: Any) -> InternalPlaneConfigView:
    base = dict(
        enabled=True,
        internal_redis_url="redis://:SuperSecretReplay@sandbox-replay-redis:6379/0",
        database_url="mysql+pymysql://u:SuperSecretMysql@mysql:3306/sandbox",
        mysql_connect_timeout_seconds=5,
        mysql_read_timeout_seconds=30,
        mysql_write_timeout_seconds=30,
        mysql_max_connections=4,
        internal_max_concurrency=16,
        internal_drain_timeout_seconds=5.0,
    )
    base.update(overrides)
    return InternalPlaneConfigView(**base)


def _assert_safe_error(err: InternalPlaneError) -> None:
    text = str(err)
    # Fixed template may include category tokens (REDIS_*, MYSQL_*) but never DSNs.
    assert "SuperSecret" not in text
    assert "redis://" not in text
    assert "mysql://" not in text
    assert "mysql+pymysql://" not in text
    assert "password" not in text.lower()
    assert "@redis" not in text
    assert "@mysql" not in text
    assert "db.internal" not in text
    assert "/var/run" not in text
    assert err.category
    assert text.startswith("internal plane error:")


def _make_bundle(
    *,
    redis_factory: Any | None = None,
    mysql_factory: Any | None = None,
    closed: list[str] | None = None,
    drain_fn: Any | None = None,
    redis_ping_timeout_seconds: float | None = 2.0,
    mysql_ping_timeout_seconds: float | None = 2.0,
    close_timeout_seconds: float | None = 2.0,
    **cfg_overrides: Any,
) -> InternalPlaneResources:
    closed = closed if closed is not None else []

    async def close_redis(c: Any) -> None:
        closed.append("redis")
        await maybe_await(getattr(c, "aclose", getattr(c, "close"))())

    def close_mysql(d: Any) -> None:
        closed.append("mysql")
        d.close()

    return InternalPlaneResources(
        _enabled_config(**cfg_overrides),
        redis_factory=redis_factory
        or (lambda url: _AsyncRedis(url)),
        replay_store_factory=lambda c: _FakeReplay(c),
        mysql_factory=mysql_factory
        or (lambda url, **kw: _FakeMysql(url, **kw)),
        claim_validator_factory=lambda db: _FakeClaimValidator(db),
        close_redis=close_redis,
        close_mysql=close_mysql,
        drain_fn=drain_fn,
        redis_ping_timeout_seconds=redis_ping_timeout_seconds,
        mysql_ping_timeout_seconds=mysql_ping_timeout_seconds,
        close_timeout_seconds=close_timeout_seconds,
    )


class TestMaybeAwait:
    @pytest.mark.asyncio
    async def test_awaits_coroutines_and_passes_values(self) -> None:
        async def coro() -> int:
            return 7

        assert await maybe_await(3) == 3
        assert await maybe_await(coro()) == 7


class TestInternalPlaneResources:
    @pytest.mark.asyncio
    async def test_disabled_prepare_is_noop(self) -> None:
        cfg = InternalPlaneConfigView(
            enabled=False,
            internal_redis_url="",
            database_url="mysql://u@h/db",
        )
        calls: list[str] = []

        def redis_factory(url: str) -> Any:
            calls.append("redis")
            return _AsyncRedis(url)

        bundle = InternalPlaneResources(
            cfg,
            redis_factory=redis_factory,
            replay_store_factory=lambda c: _FakeReplay(c),
            mysql_factory=lambda url, **kw: _FakeMysql(url, **kw),
            claim_validator_factory=lambda db: _FakeClaimValidator(db),
        )
        assert bundle.state is InternalPlaneState.DISABLED
        assert await bundle.prepare() is InternalPlaneState.DISABLED
        assert calls == []
        assert evaluate_internal_plane_readiness(bundle, enabled=False) is True

    @pytest.mark.asyncio
    async def test_async_redis_success_prepare_install_uninstall(self) -> None:
        closed: list[str] = []
        clients: list[_AsyncRedis] = []

        def redis_factory(url: str) -> _AsyncRedis:
            c = _AsyncRedis(url)
            clients.append(c)
            return c

        bundle = _make_bundle(redis_factory=redis_factory, closed=closed)
        assert bundle.state is InternalPlaneState.UNINITIALIZED
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is False

        assert await bundle.prepare() is InternalPlaneState.READY
        assert bundle.prepared is not None
        assert clients[0].ping_calls >= 1
        assert bundle.prepared.claim_validator.probed is True
        # READY requires redis ping already done
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is False

        # redis.asyncio consume path works on prepared client
        assert await bundle.prepared.replay_store.consume(
            issuer="a", audience="b", jti="c", expires_at=10, now=1, leeway=0
        ) is True
        assert clients[0].set_calls == 1

        target = DictInstallTarget()
        assert await bundle.install(target) is InternalPlaneState.INSTALLED
        assert target.replay_store is not None
        assert target.claim_validator is not None
        assert target.mysql_database is not None
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is True

        assert await bundle.uninstall() is InternalPlaneState.CLOSED
        assert target.replay_store is None
        assert target.claim_validator is None
        assert target.mysql_database is None
        assert clients[0].closed is True
        assert "redis" in closed and "mysql" in closed
        assert evaluate_internal_plane_readiness(bundle, enabled=True) is False

    @pytest.mark.asyncio
    async def test_async_redis_down_fail_closed_closes_nothing_half_open(self) -> None:
        closed: list[str] = []
        created: list[_AsyncRedis] = []

        def redis_factory(url: str) -> _AsyncRedis:
            c = _AsyncRedis(url, ping_ok=False)
            created.append(c)
            return c

        bundle = _make_bundle(redis_factory=redis_factory, closed=closed)
        with pytest.raises(InternalPlaneError) as ei:
            await bundle.prepare()
        _assert_safe_error(ei.value)
        assert ei.value.category == CATEGORY_REDIS_PING
        assert bundle.state is InternalPlaneState.FAILED
        assert bundle.prepared is None
        assert bundle.failure_reason == CATEGORY_REDIS_PING
        # Client was created then closed on rollback.
        assert created[0].closed is True
        assert "redis" in closed

    @pytest.mark.asyncio
    async def test_async_redis_ping_timeout(self) -> None:
        closed: list[str] = []

        def redis_factory(url: str) -> _AsyncRedis:
            return _AsyncRedis(url, ping_delay=1.0)

        bundle = _make_bundle(
            redis_factory=redis_factory,
            closed=closed,
            redis_ping_timeout_seconds=0.05,
        )
        with pytest.raises(InternalPlaneError) as ei:
            await bundle.prepare()
        _assert_safe_error(ei.value)
        assert ei.value.category == CATEGORY_REDIS_PING_TIMEOUT
        assert bundle.state is InternalPlaneState.FAILED
        assert "redis" in closed

    @pytest.mark.asyncio
    async def test_async_redis_aclose_on_uninstall(self) -> None:
        client = _AsyncRedis("redis://:x@h/0")

        async def redis_factory(url: str) -> _AsyncRedis:
            return client

        # Prefer built-in aclose without custom close_redis.
        bundle = InternalPlaneResources(
            _enabled_config(),
            redis_factory=redis_factory,
            replay_store_factory=lambda c: _FakeReplay(c),
            mysql_factory=lambda url, **kw: _FakeMysql(url, **kw),
            claim_validator_factory=lambda db: _FakeClaimValidator(db),
            close_timeout_seconds=2.0,
        )
        await bundle.prepare()
        target = DictInstallTarget()
        await bundle.install(target)
        await bundle.uninstall()
        assert client.closed is True
        assert target.replay_store is None

    @pytest.mark.asyncio
    async def test_mysql_down_fail_closed_closes_redis(self) -> None:
        closed: list[str] = []
        redis_clients: list[_AsyncRedis] = []

        def redis_factory(url: str) -> _AsyncRedis:
            c = _AsyncRedis(url)
            redis_clients.append(c)
            return c

        def mysql_factory(url: str, **kw: Any) -> _FakeMysql:
            m = _FakeMysql(url, **kw)
            m.ping_ok = False
            return m

        bundle = _make_bundle(
            redis_factory=redis_factory, mysql_factory=mysql_factory, closed=closed
        )
        with pytest.raises(InternalPlaneError) as ei:
            await bundle.prepare()
        _assert_safe_error(ei.value)
        assert ei.value.category == CATEGORY_MYSQL_PING
        assert bundle.prepared is None
        assert redis_clients[0].closed is True
        assert "redis" in closed

    @pytest.mark.asyncio
    async def test_secret_bearing_exception_never_leaks(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        secret_url = "redis://:SuperSecretRedis@db.internal:6379/0"

        def redis_factory(url: str) -> _AsyncRedis:
            raise RuntimeError(
                f"Error connecting to {secret_url} with password SuperSecretRedis "
                f"user=default path=/var/run/redis.sock"
            )

        bundle = _make_bundle(redis_factory=redis_factory)
        with caplog.at_level(logging.WARNING):
            with pytest.raises(InternalPlaneError) as ei:
                await bundle.prepare()
        _assert_safe_error(ei.value)
        assert "SuperSecretRedis" not in str(ei.value)
        assert "SuperSecretRedis" not in (bundle.failure_reason or "")
        assert secret_url not in str(ei.value)
        # Logs: type name only, not driver message.
        joined = " ".join(r.getMessage() for r in caplog.records)
        assert "SuperSecretRedis" not in joined
        assert secret_url not in joined
        assert "/var/run/redis.sock" not in joined

    @pytest.mark.asyncio
    async def test_install_requires_ready(self) -> None:
        bundle = _make_bundle()
        with pytest.raises(InternalPlaneError) as ei:
            await bundle.install(DictInstallTarget())
        _assert_safe_error(ei.value)
        assert ei.value.category  # STATE

    @pytest.mark.asyncio
    async def test_install_partial_failure_clears_slots_and_closes_resources(
        self,
    ) -> None:
        closed: list[str] = []
        redis_clients: list[_AsyncRedis] = []

        def redis_factory(url: str) -> _AsyncRedis:
            c = _AsyncRedis(url)
            redis_clients.append(c)
            return c

        class BoomTarget(DictInstallTarget):
            def set_replay_store(self, store: Any | None) -> None:
                if store is not None:
                    raise RuntimeError(
                        "slot boom redis://:SuperSecretRedis@h/0"
                    )
                super().set_replay_store(store)

        bundle = _make_bundle(redis_factory=redis_factory, closed=closed)
        await bundle.prepare()
        target = BoomTarget()
        with pytest.raises(InternalPlaneError) as ei:
            await bundle.install(target)
        _assert_safe_error(ei.value)
        assert ei.value.category == CATEGORY_INSTALL
        assert "SuperSecret" not in str(ei.value)
        assert bundle.state is InternalPlaneState.FAILED
        assert target.replay_store is None
        assert target.claim_validator is None
        assert target.mysql_database is None
        assert bundle.prepared is None
        assert redis_clients[0].closed is True
        assert "redis" in closed and "mysql" in closed

    @pytest.mark.asyncio
    async def test_uninstall_drain_timeout_still_closes_and_clears_slots(self) -> None:
        closed: list[str] = []
        client = _AsyncRedis("redis://x")

        def redis_factory(url: str) -> _AsyncRedis:
            return client

        async def slow_drain() -> bool:
            await asyncio.sleep(5.0)
            return True

        async def close_redis(c: Any) -> None:
            closed.append("redis")
            await c.aclose()

        def close_mysql(d: Any) -> None:
            closed.append("mysql")
            d.close()

        bundle = InternalPlaneResources(
            _enabled_config(internal_drain_timeout_seconds=0.05),
            redis_factory=redis_factory,
            replay_store_factory=lambda c: _FakeReplay(c),
            mysql_factory=lambda url, **kw: _FakeMysql(url, **kw),
            claim_validator_factory=lambda db: _FakeClaimValidator(db),
            close_redis=close_redis,
            close_mysql=close_mysql,
            drain_fn=slow_drain,
            close_timeout_seconds=2.0,
        )
        await bundle.prepare()
        target = DictInstallTarget()
        await bundle.install(target)
        assert await bundle.uninstall() is InternalPlaneState.CLOSED
        assert target.replay_store is None
        assert target.claim_validator is None
        assert target.mysql_database is None
        assert client.closed is True
        assert "redis" in closed

    @pytest.mark.asyncio
    async def test_concurrent_prepare_is_serialized_to_ready(self) -> None:
        """Two concurrent prepares share one lock; both end READY without leak."""
        started = asyncio.Event()
        release = asyncio.Event()
        pings = 0

        class SlowPingRedis(_AsyncRedis):
            async def ping(self) -> bool:
                nonlocal pings
                pings += 1
                if pings == 1:
                    started.set()
                    await release.wait()
                return True

        clients: list[SlowPingRedis] = []

        def redis_factory(url: str) -> SlowPingRedis:
            c = SlowPingRedis(url)
            clients.append(c)
            return c

        bundle = _make_bundle(redis_factory=redis_factory)
        t1 = asyncio.create_task(bundle.prepare())
        t2 = asyncio.create_task(bundle.prepare())
        await started.wait()
        release.set()
        r1, r2 = await asyncio.gather(t1, t2)
        assert r1 is InternalPlaneState.READY
        assert r2 is InternalPlaneState.READY
        assert bundle.state is InternalPlaneState.READY
        assert bundle.prepared is not None
        # First prepare builds resources; second is idempotent READY.
        assert pings == 1
        await bundle.uninstall()
        assert all(c.closed for c in clients)

    @pytest.mark.asyncio
    async def test_concurrent_install_and_uninstall_state(self) -> None:
        bundle = _make_bundle()
        await bundle.prepare()
        target = DictInstallTarget()
        await bundle.install(target)
        assert bundle.state is InternalPlaneState.INSTALLED

        async def reinstall() -> None:
            await bundle.install(DictInstallTarget())

        results: list[Any] = []

        async def run_uninstall() -> None:
            results.append(await bundle.uninstall())

        async def run_reinstall() -> None:
            try:
                results.append(await reinstall())
            except InternalPlaneError as err:
                _assert_safe_error(err)
                results.append(err)

        await asyncio.gather(run_uninstall(), run_reinstall())
        assert bundle.state in (
            InternalPlaneState.CLOSED,
            InternalPlaneState.INSTALLED,
            InternalPlaneState.FAILED,
        )
        # If still INSTALLED, uninstall again to fail closed slots.
        if bundle.state is InternalPlaneState.INSTALLED:
            await bundle.uninstall()
        if bundle.state is not InternalPlaneState.CLOSED:
            # FAILED after race: still force uninstall path for cleanup.
            if bundle.state is InternalPlaneState.FAILED:
                await bundle.uninstall()
        assert bundle.state is InternalPlaneState.CLOSED
        # Original target slots fail closed whenever uninstall ran after install.
        # (If reinstall won against a different target, original may already be cleared.)

    def test_readiness_enabled_without_bundle_is_false(self) -> None:
        assert evaluate_internal_plane_readiness(None, enabled=True) is False
        assert evaluate_internal_plane_readiness(None, enabled=False) is True

    def test_registry_roundtrip(self) -> None:
        register_internal_plane_bundle(None)
        assert get_internal_plane_bundle() is None
        cfg = InternalPlaneConfigView(
            enabled=False, internal_redis_url="", database_url=""
        )
        bundle = InternalPlaneResources(cfg)
        register_internal_plane_bundle(bundle)
        try:
            assert get_internal_plane_bundle() is bundle
        finally:
            register_internal_plane_bundle(None)

    def test_resources_module_does_not_import_redis(self) -> None:
        tree = ast.parse(RESOURCES_PATH.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert alias.name.split(".")[0] != "redis"
            if isinstance(node, ast.ImportFrom) and node.module:
                assert node.module.split(".")[0] != "redis"

    def test_deferred_items_drop_production_blockers(self) -> None:
        text = (ROOT / "docs" / "review-deferred-items.md").read_text()
        assert "lifespan / compose wiring" not in text
        assert "Real redis client factory" not in text
        # Still non-severe only:
        assert "HealthResponse plane field" in text
        assert "Claim capability probe scope" in text
