"""Injectable internal-plane resource bundle (PR-07B production lifecycle Batch B).

Strict **async** lifecycle with reliable maybe-await so redis.asyncio clients
(``await client.set`` / ``ping`` / ``aclose``) work correctly. MySQL may stay
sync; both Redis and MySQL passive pings must succeed before READY.

Does **not**:
  - pull in the redis package at module import (client factory is injected)
  - open network sockets itself (factories own I/O)
  - wire ``sandbox.main`` lifespan
  - force ``internal_plane_enabled=True`` in production
  - put driver messages, URLs, passwords, or host paths into errors or logs

Readiness helper:
  - disabled → treat as ready (status quo for /ready)
  - enabled → require an INSTALLED bundle
"""

from __future__ import annotations

import asyncio
import inspect
import logging
import threading
from dataclasses import dataclass
from enum import Enum
from typing import Any, Awaitable, Callable, Final, Protocol, TypeVar

logger = logging.getLogger("sandbox.services.internal_plane_resources")

T = TypeVar("T")

# Fixed safe failure categories only — never embed str(exc) / DSNs / paths.
CATEGORY_CONFIG: Final = "CONFIG"
CATEGORY_FACTORY_MISSING: Final = "FACTORY_MISSING"
CATEGORY_STATE: Final = "STATE"
CATEGORY_REDIS_CREATE: Final = "REDIS_CREATE"
CATEGORY_REDIS_PING: Final = "REDIS_PING"
CATEGORY_REDIS_PING_TIMEOUT: Final = "REDIS_PING_TIMEOUT"
CATEGORY_MYSQL_CREATE: Final = "MYSQL_CREATE"
CATEGORY_MYSQL_PING: Final = "MYSQL_PING"
CATEGORY_MYSQL_PING_TIMEOUT: Final = "MYSQL_PING_TIMEOUT"
CATEGORY_CLAIM_PROBE: Final = "CLAIM_PROBE"
CATEGORY_CLAIM_RECOVERY: Final = "CLAIM_RECOVERY"
CATEGORY_INSTALL: Final = "INSTALL"
CATEGORY_CLOSE: Final = "CLOSE"
CATEGORY_DRAIN_TIMEOUT: Final = "DRAIN_TIMEOUT"
CATEGORY_RECONCILE: Final = "RECONCILE"
CATEGORY_PREPARE: Final = "PREPARE"

_SAFE_CATEGORIES: Final = frozenset(
    {
        CATEGORY_CONFIG,
        CATEGORY_FACTORY_MISSING,
        CATEGORY_STATE,
        CATEGORY_REDIS_CREATE,
        CATEGORY_REDIS_PING,
        CATEGORY_REDIS_PING_TIMEOUT,
        CATEGORY_MYSQL_CREATE,
        CATEGORY_MYSQL_PING,
        CATEGORY_MYSQL_PING_TIMEOUT,
        CATEGORY_CLAIM_PROBE,
        CATEGORY_CLAIM_RECOVERY,
        CATEGORY_INSTALL,
        CATEGORY_CLOSE,
        CATEGORY_DRAIN_TIMEOUT,
        CATEGORY_RECONCILE,
        CATEGORY_PREPARE,
    }
)


class InternalPlaneState(str, Enum):
    """Lifecycle states for the internal-plane resource bundle."""

    DISABLED = "DISABLED"
    UNINITIALIZED = "UNINITIALIZED"
    PREPARING = "PREPARING"
    READY = "READY"  # prepared + dual ping + probe; not yet installed
    INSTALLED = "INSTALLED"
    FAILED = "FAILED"
    CLOSING = "CLOSING"
    CLOSED = "CLOSED"


class InternalPlaneError(RuntimeError):
    """Lifecycle / factory failure with a fixed safe category only.

    Message never includes driver text, URLs, credentials, or host paths.
    """

    def __init__(
        self,
        category: str,
        *,
        state: str | None = None,
    ) -> None:
        if category not in _SAFE_CATEGORIES:
            category = CATEGORY_PREPARE
        self.category = category
        self.state = state
        # Fixed template — category + optional state token only.
        if state is not None:
            msg = f"internal plane error: {category} (state={state})"
        else:
            msg = f"internal plane error: {category}"
        super().__init__(msg)


async def maybe_await(value: Any) -> Any:
    """Await *value* when it is awaitable; otherwise return it unchanged."""
    if inspect.isawaitable(value):
        return await value
    return value


async def invoke_maybe_async(
    fn: Callable[..., Any],
    /,
    *args: Any,
    timeout: float | None = None,
    run_sync_in_thread: bool = False,
    **kwargs: Any,
) -> Any:
    """Call *fn*; await coroutines; optionally run sync work off the event loop.

    When ``run_sync_in_thread=True`` and *fn* is not a coroutine function, the
    call runs via :func:`asyncio.to_thread` so blocking I/O cannot stall the
    loop. ``timeout`` (seconds) applies to both async and threaded paths and
    truly bounds completion (thread work is abandoned on timeout from the
    caller's perspective — the thread may still finish in the background).
    """
    if fn is None:
        raise TypeError("fn is required")
    if inspect.iscoroutinefunction(fn):
        coro = fn(*args, **kwargs)
        if timeout is None:
            return await coro
        return await asyncio.wait_for(coro, timeout=timeout)
    if run_sync_in_thread:
        # functools.partial-friendly: kwargs go into to_thread via lambda.
        def _call() -> Any:
            return fn(*args, **kwargs)

        threaded = asyncio.to_thread(_call)
        if timeout is None:
            return await threaded
        return await asyncio.wait_for(threaded, timeout=timeout)
    result = fn(*args, **kwargs)
    if inspect.isawaitable(result):
        if timeout is None:
            return await result
        return await asyncio.wait_for(result, timeout=timeout)
    return result


async def call_maybe_async(
    value: Any,
    *,
    timeout: float | None = None,
    run_sync_in_thread: bool = False,
) -> Any:
    """Await *value* if awaitable; if it is a zero-arg callable, invoke it first.

    Sync callables with ``run_sync_in_thread=True`` run via ``to_thread``.
    """
    if callable(value) and not inspect.isawaitable(value):
        return await invoke_maybe_async(
            value,
            timeout=timeout,
            run_sync_in_thread=run_sync_in_thread,
        )
    if inspect.isawaitable(value):
        if timeout is None:
            return await value
        return await asyncio.wait_for(value, timeout=timeout)
    return value


class ReplayStoreFactory(Protocol):
    def __call__(self, redis_client: Any) -> Any: ...


class RedisClientFactory(Protocol):
    def __call__(self, redis_url: str) -> Any: ...


class MysqlDatabaseFactory(Protocol):
    def __call__(self, database_url: str, **kwargs: Any) -> Any: ...


class ClaimValidatorFactory(Protocol):
    def __call__(self, db: Any) -> Any: ...


class InstallTarget(Protocol):
    """Slots that receive installed resources (app-like, injectable)."""

    def set_replay_store(self, store: Any | None) -> Any: ...

    def set_claim_validator(self, validator: Any | None) -> Any: ...

    def set_mysql_database(self, db: Any | None) -> Any: ...


@dataclass(frozen=True)
class InternalPlaneConfigView:
    """Minimal typed config surface (pure; no Settings import required)."""

    enabled: bool
    internal_redis_url: str
    database_url: str
    mysql_connect_timeout_seconds: int = 5
    mysql_read_timeout_seconds: int = 30
    mysql_write_timeout_seconds: int = 30
    mysql_max_connections: int = 8
    internal_max_concurrency: int = 64
    internal_drain_timeout_seconds: float = 30.0

    @classmethod
    def from_settings(cls, settings: Any) -> InternalPlaneConfigView:
        return cls(
            enabled=bool(getattr(settings, "internal_plane_enabled", False)),
            internal_redis_url=str(getattr(settings, "internal_redis_url", "") or ""),
            database_url=str(getattr(settings, "database_url", "") or ""),
            mysql_connect_timeout_seconds=int(
                getattr(settings, "mysql_connect_timeout_seconds", 5)
            ),
            mysql_read_timeout_seconds=int(
                getattr(settings, "mysql_read_timeout_seconds", 30)
            ),
            mysql_write_timeout_seconds=int(
                getattr(settings, "mysql_write_timeout_seconds", 30)
            ),
            mysql_max_connections=int(getattr(settings, "mysql_max_connections", 8)),
            internal_max_concurrency=int(
                getattr(settings, "internal_max_concurrency", 64)
            ),
            internal_drain_timeout_seconds=float(
                getattr(settings, "internal_drain_timeout_seconds", 30.0)
            ),
        )


@dataclass
class PreparedInternalPlane:
    """Resources produced by prepare (not yet installed)."""

    redis_client: Any
    replay_store: Any
    mysql_db: Any
    claim_validator: Any


class DictInstallTarget:
    """Simple dict-backed install target for tests / offline wiring."""

    def __init__(self) -> None:
        self.replay_store: Any | None = None
        self.claim_validator: Any | None = None
        self.mysql_database: Any | None = None

    def set_replay_store(self, store: Any | None) -> None:
        self.replay_store = store

    def set_claim_validator(self, validator: Any | None) -> None:
        self.claim_validator = validator

    def set_mysql_database(self, db: Any | None) -> None:
        self.mysql_database = db


def _log_failure(op: str, category: str, exc: BaseException | None = None) -> None:
    """Log only safe tokens — never str(exc) (may embed DSN/credentials)."""
    if exc is None:
        logger.warning("internal plane %s failed category=%s", op, category)
    else:
        logger.warning(
            "internal plane %s failed category=%s type=%s",
            op,
            category,
            type(exc).__name__,
        )


class InternalPlaneResources:
    """Async atomic prepare → install → uninstall state machine.

    Factories are mandatory when enabled; they must not be imported as redis
    at module level of *this* file. Callers inject fakes in unit tests.
    """

    def __init__(
        self,
        config: InternalPlaneConfigView | Any,
        *,
        redis_factory: RedisClientFactory | None = None,
        replay_store_factory: ReplayStoreFactory | None = None,
        mysql_factory: MysqlDatabaseFactory | None = None,
        claim_validator_factory: ClaimValidatorFactory | None = None,
        close_redis: Callable[[Any], Any] | None = None,
        close_mysql: Callable[[Any], Any] | None = None,
        validate_config: Callable[[Any], Any] | None = None,
        drain_fn: Callable[[], Any] | None = None,
        reconcile_fn: Callable[[], Any] | None = None,
        redis_ping_timeout_seconds: float | None = None,
        mysql_ping_timeout_seconds: float | None = None,
        close_timeout_seconds: float | None = None,
        reconcile_timeout_seconds: float | None = None,
    ) -> None:
        if not isinstance(config, InternalPlaneConfigView):
            config = InternalPlaneConfigView.from_settings(config)
        self._config = config
        self._redis_factory = redis_factory
        self._replay_store_factory = replay_store_factory
        self._mysql_factory = mysql_factory
        self._claim_validator_factory = claim_validator_factory
        self._close_redis = close_redis
        self._close_mysql = close_mysql
        self._validate_config = validate_config
        self._drain_fn = drain_fn
        # After drain timeout: mark inflight claims UNKNOWN while MySQL still open.
        self._reconcile_fn = reconcile_fn
        # Bounded waits for ping / close (never hang forever).
        self._redis_ping_timeout = float(
            redis_ping_timeout_seconds
            if redis_ping_timeout_seconds is not None
            else max(1.0, float(config.mysql_connect_timeout_seconds))
        )
        self._mysql_ping_timeout = float(
            mysql_ping_timeout_seconds
            if mysql_ping_timeout_seconds is not None
            else max(1.0, float(config.mysql_connect_timeout_seconds))
        )
        self._close_timeout = float(
            close_timeout_seconds
            if close_timeout_seconds is not None
            else max(1.0, float(config.internal_drain_timeout_seconds) or 1.0)
        )
        self._drain_timeout = float(config.internal_drain_timeout_seconds)
        self._reconcile_timeout = float(
            reconcile_timeout_seconds
            if reconcile_timeout_seconds is not None
            else max(1.0, min(30.0, float(config.internal_drain_timeout_seconds) or 1.0))
        )
        # Async lock created lazily so construct is safe without a running loop.
        self._async_lock: asyncio.Lock | None = None
        self._lock_guard = threading.Lock()
        self._prepared: PreparedInternalPlane | None = None
        self._install_target: InstallTarget | None = None
        self._failure: str | None = None
        if not config.enabled:
            self._state = InternalPlaneState.DISABLED
        else:
            self._state = InternalPlaneState.UNINITIALIZED

    def _get_lock(self) -> asyncio.Lock:
        with self._lock_guard:
            if self._async_lock is None:
                self._async_lock = asyncio.Lock()
            return self._async_lock

    @property
    def state(self) -> InternalPlaneState:
        return self._state

    @property
    def enabled(self) -> bool:
        return self._config.enabled

    @property
    def failure_reason(self) -> str | None:
        """Safe category token only (never driver text or DSN)."""
        return self._failure

    @property
    def prepared(self) -> PreparedInternalPlane | None:
        return self._prepared

    async def prepare(self) -> InternalPlaneState:
        """Atomically prepare resources (async).

        Disabled → remains DISABLED (no factories called).
        Enabled → validates config, builds redis/mysql/claim validator, runs
        **both** Redis and MySQL passive pings and claim schema probe, then
        READY or FAILED. Partial failures close every created handle first.
        """
        async with self._get_lock():
            if self._state is InternalPlaneState.DISABLED:
                return self._state
            if self._state in (
                InternalPlaneState.READY,
                InternalPlaneState.INSTALLED,
            ):
                return self._state
            if self._state is InternalPlaneState.PREPARING:
                raise InternalPlaneError(
                    CATEGORY_STATE, state=self._state.value
                )
            if self._state in (
                InternalPlaneState.CLOSING,
                InternalPlaneState.CLOSED,
            ):
                raise InternalPlaneError(
                    CATEGORY_STATE, state=self._state.value
                )

            self._state = InternalPlaneState.PREPARING
            self._failure = None
            redis_client: Any = None
            mysql_db: Any = None
            try:
                if self._validate_config is not None:
                    try:
                        await maybe_await(self._validate_config(self._config))
                    except InternalPlaneError:
                        raise
                    except Exception as exc:
                        _log_failure("validate_config", CATEGORY_CONFIG, exc)
                        raise InternalPlaneError(CATEGORY_CONFIG) from exc

                if self._redis_factory is None:
                    raise InternalPlaneError(CATEGORY_FACTORY_MISSING)
                if self._replay_store_factory is None:
                    raise InternalPlaneError(CATEGORY_FACTORY_MISSING)
                if self._mysql_factory is None:
                    raise InternalPlaneError(CATEGORY_FACTORY_MISSING)
                if self._claim_validator_factory is None:
                    raise InternalPlaneError(CATEGORY_FACTORY_MISSING)

                redis_url = (self._config.internal_redis_url or "").strip()
                if not redis_url:
                    raise InternalPlaneError(CATEGORY_CONFIG)
                database_url = (self._config.database_url or "").strip()
                if not database_url:
                    raise InternalPlaneError(CATEGORY_CONFIG)

                # Redis create + passive ping (required before READY).
                # redis.asyncio factories are async; sync fakes stay on-loop.
                try:
                    redis_client = await invoke_maybe_async(
                        self._redis_factory,
                        redis_url,
                        timeout=self._redis_ping_timeout,
                        run_sync_in_thread=False,
                    )
                except asyncio.TimeoutError as exc:
                    _log_failure("redis_create", CATEGORY_REDIS_CREATE, exc)
                    raise InternalPlaneError(CATEGORY_REDIS_CREATE) from exc
                except InternalPlaneError:
                    raise
                except Exception as exc:
                    _log_failure("redis_create", CATEGORY_REDIS_CREATE, exc)
                    raise InternalPlaneError(CATEGORY_REDIS_CREATE) from exc

                await self._ping_redis(redis_client)

                try:
                    replay_store = await invoke_maybe_async(
                        self._replay_store_factory,
                        redis_client,
                        run_sync_in_thread=False,
                    )
                except InternalPlaneError:
                    raise
                except Exception as exc:
                    _log_failure("replay_store", CATEGORY_REDIS_CREATE, exc)
                    raise InternalPlaneError(CATEGORY_REDIS_CREATE) from exc

                # MySQL create + passive ping (required before READY). No DDL.
                # Sync PyMySQL factory/connect must not block the event loop.
                try:
                    mysql_db = await invoke_maybe_async(
                        self._mysql_factory,
                        database_url,
                        timeout=float(self._config.mysql_connect_timeout_seconds),
                        run_sync_in_thread=True,
                        connect_timeout=self._config.mysql_connect_timeout_seconds,
                        read_timeout=self._config.mysql_read_timeout_seconds,
                        write_timeout=self._config.mysql_write_timeout_seconds,
                        max_connections=self._config.mysql_max_connections,
                    )
                except asyncio.TimeoutError as exc:
                    _log_failure("mysql_create", CATEGORY_MYSQL_CREATE, exc)
                    raise InternalPlaneError(CATEGORY_MYSQL_CREATE) from exc
                except InternalPlaneError:
                    raise
                except Exception as exc:
                    _log_failure("mysql_create", CATEGORY_MYSQL_CREATE, exc)
                    raise InternalPlaneError(CATEGORY_MYSQL_CREATE) from exc

                await self._ping_mysql(mysql_db)

                try:
                    claim_validator = await invoke_maybe_async(
                        self._claim_validator_factory,
                        mysql_db,
                        run_sync_in_thread=True,
                        timeout=self._mysql_ping_timeout,
                    )
                except asyncio.TimeoutError as exc:
                    _log_failure("claim_validator", CATEGORY_CLAIM_PROBE, exc)
                    raise InternalPlaneError(CATEGORY_CLAIM_PROBE) from exc
                except InternalPlaneError:
                    raise
                except Exception as exc:
                    _log_failure("claim_validator", CATEGORY_CLAIM_PROBE, exc)
                    raise InternalPlaneError(CATEGORY_CLAIM_PROBE) from exc

                await self._run_claim_probe(claim_validator, mysql_db)
                # A hard-killed Sandbox loses all in-memory inflight sets.
                # Reconcile durable RUNNING claims before the bundle can become
                # READY or any route can be admitted.  The production validator
                # supplies this method; injected offline fakes may omit it.
                await self._run_claim_recovery(claim_validator)

                self._prepared = PreparedInternalPlane(
                    redis_client=redis_client,
                    replay_store=replay_store,
                    mysql_db=mysql_db,
                    claim_validator=claim_validator,
                )
                self._state = InternalPlaneState.READY
                return self._state
            except InternalPlaneError as exc:
                self._failure = exc.category
                self._prepared = None
                await self._safe_close(redis_client, mysql_db)
                self._state = InternalPlaneState.FAILED
                raise InternalPlaneError(
                    exc.category, state=InternalPlaneState.FAILED.value
                ) from exc
            except Exception as exc:
                # Last-resort: never surface str(exc).
                self._failure = CATEGORY_PREPARE
                self._prepared = None
                await self._safe_close(redis_client, mysql_db)
                self._state = InternalPlaneState.FAILED
                _log_failure("prepare", CATEGORY_PREPARE, exc)
                raise InternalPlaneError(
                    CATEGORY_PREPARE, state=InternalPlaneState.FAILED.value
                ) from exc

    async def install(self, target: InstallTarget) -> InternalPlaneState:
        """Atomically install prepared resources into *target* slots.

        Only valid from READY. On any setter failure: clear all slots (route
        fail closed), close all prepared resources, state FAILED.
        """
        async with self._get_lock():
            if self._state is InternalPlaneState.DISABLED:
                return self._state
            if self._state is InternalPlaneState.INSTALLED:
                if self._install_target is target:
                    return self._state
                raise InternalPlaneError(
                    CATEGORY_STATE, state=self._state.value
                )
            if self._state is not InternalPlaneState.READY or self._prepared is None:
                raise InternalPlaneError(
                    CATEGORY_STATE, state=self._state.value
                )

            prepared = self._prepared
            try:
                await maybe_await(target.set_mysql_database(prepared.mysql_db))
                await maybe_await(
                    target.set_claim_validator(prepared.claim_validator)
                )
                await maybe_await(target.set_replay_store(prepared.replay_store))
            except Exception as exc:
                _log_failure("install", CATEGORY_INSTALL, exc)
                await self._clear_target_slots(target)
                # Close prepared resources — nothing left half-open.
                self._prepared = None
                self._install_target = None
                await self._safe_close(prepared.redis_client, prepared.mysql_db)
                self._failure = CATEGORY_INSTALL
                self._state = InternalPlaneState.FAILED
                raise InternalPlaneError(
                    CATEGORY_INSTALL, state=InternalPlaneState.FAILED.value
                ) from exc

            self._install_target = target
            self._state = InternalPlaneState.INSTALLED
            return self._state

    async def uninstall(self) -> InternalPlaneState:
        """Stop admit → bounded drain → reconcile if needed → close → CLOSED.

        Idempotent from DISABLED / CLOSED.

        On drain timeout we **must not** drop MySQL while claimed work may still
        be RUNNING without a terminal ledger row. ``reconcile_fn`` runs while
        resources are still open (mark UNKNOWN / safe recovery), then close.
        """
        async with self._get_lock():
            if self._state is InternalPlaneState.DISABLED:
                return self._state
            if self._state is InternalPlaneState.CLOSED:
                return self._state

            self._state = InternalPlaneState.CLOSING

            # 1) Route slots fail closed immediately (new requests 503).
            # In-flight tasks keep strong refs to runtime/claim_validator.
            target = self._install_target
            if target is not None:
                await self._clear_target_admission_slots(target)
                self._install_target = None

            # 2) Bounded drain (never cancel in-flight finalize work).
            drained = True
            if self._drain_fn is not None:
                # Drain timeout of 0 is invalid for enabled plane (config gate);
                # still clamp to avoid hang if mis-wired.
                drain_timeout = max(0.001, float(self._drain_timeout))
                try:
                    result = await asyncio.wait_for(
                        maybe_await(self._drain_fn()),
                        timeout=drain_timeout,
                    )
                    drained = result is not False
                    if not drained:
                        _log_failure("drain", CATEGORY_DRAIN_TIMEOUT, None)
                except asyncio.TimeoutError:
                    drained = False
                    _log_failure("drain", CATEGORY_DRAIN_TIMEOUT, None)
                except Exception as exc:
                    drained = False
                    _log_failure("drain", CATEGORY_CLOSE, exc)

            # 3) Incomplete drain → bounded UNKNOWN reconciliation while MySQL open.
            if not drained and self._reconcile_fn is not None:
                try:
                    await asyncio.wait_for(
                        maybe_await(self._reconcile_fn()),
                        timeout=self._reconcile_timeout,
                    )
                except asyncio.TimeoutError:
                    _log_failure("reconcile", CATEGORY_RECONCILE, None)
                except Exception as exc:
                    _log_failure("reconcile", CATEGORY_RECONCILE, exc)

            # 4) Only now detach manager persistence. In-flight process work may
            # need the formal repository throughout drain and UNKNOWN reconcile.
            if target is not None:
                await self._clear_target_persistence(target)

            # 5) Close prepared handles with bound (after reconcile).
            prepared = self._prepared
            self._prepared = None
            if prepared is not None:
                await self._safe_close(prepared.redis_client, prepared.mysql_db)

            self._state = InternalPlaneState.CLOSED
            return self._state

    async def _clear_target_slots(self, target: InstallTarget) -> None:
        for setter_name, method in (
            ("replay_store", target.set_replay_store),
            ("claim_validator", target.set_claim_validator),
            ("mysql_database", target.set_mysql_database),
        ):
            try:
                await maybe_await(method(None))
            except Exception as exc:
                _log_failure(f"clear_{setter_name}", CATEGORY_CLOSE, exc)

    async def _clear_target_admission_slots(self, target: InstallTarget) -> None:
        for setter_name, method in (
            ("replay_store", target.set_replay_store),
            ("claim_validator", target.set_claim_validator),
        ):
            try:
                await maybe_await(method(None))
            except Exception as exc:
                _log_failure(f"clear_{setter_name}", CATEGORY_CLOSE, exc)

    async def _clear_target_persistence(self, target: InstallTarget) -> None:
        try:
            await maybe_await(target.set_mysql_database(None))
        except Exception as exc:
            _log_failure("clear_mysql_database", CATEGORY_CLOSE, exc)

    async def _ping_redis(self, client: Any) -> None:
        ping = getattr(client, "ping", None)
        if not callable(ping):
            raise InternalPlaneError(CATEGORY_REDIS_PING)
        try:
            result = await asyncio.wait_for(
                maybe_await(ping()),
                timeout=self._redis_ping_timeout,
            )
        except asyncio.TimeoutError as exc:
            _log_failure("redis_ping", CATEGORY_REDIS_PING_TIMEOUT, exc)
            raise InternalPlaneError(CATEGORY_REDIS_PING_TIMEOUT) from exc
        except InternalPlaneError:
            raise
        except Exception as exc:
            _log_failure("redis_ping", CATEGORY_REDIS_PING, exc)
            raise InternalPlaneError(CATEGORY_REDIS_PING) from exc
        # redis-py returns True; some fakes return b"PONG" / "PONG".
        if result is False or result is None:
            raise InternalPlaneError(CATEGORY_REDIS_PING)

    async def _ping_mysql(self, mysql_db: Any) -> None:
        ping = getattr(mysql_db, "ping", None)
        if not callable(ping):
            raise InternalPlaneError(CATEGORY_MYSQL_PING)
        try:
            # Sync PyMySQL ping/SELECT must leave the event loop.
            if inspect.iscoroutinefunction(ping):
                result = await asyncio.wait_for(
                    ping(), timeout=self._mysql_ping_timeout
                )
            else:
                result = await asyncio.wait_for(
                    asyncio.to_thread(ping),
                    timeout=self._mysql_ping_timeout,
                )
                if inspect.isawaitable(result):
                    result = await asyncio.wait_for(
                        result, timeout=self._mysql_ping_timeout
                    )
        except asyncio.TimeoutError as exc:
            _log_failure("mysql_ping", CATEGORY_MYSQL_PING_TIMEOUT, exc)
            raise InternalPlaneError(CATEGORY_MYSQL_PING_TIMEOUT) from exc
        except InternalPlaneError:
            raise
        except Exception as exc:
            _log_failure("mysql_ping", CATEGORY_MYSQL_PING, exc)
            raise InternalPlaneError(CATEGORY_MYSQL_PING) from exc
        if result is False:
            raise InternalPlaneError(CATEGORY_MYSQL_PING)

    async def _run_claim_probe(self, claim_validator: Any, mysql_db: Any) -> None:
        probe = getattr(claim_validator, "ensure_claim_schema_capability", None)
        probe_fn = getattr(claim_validator, "probe_claim_schema_capability", None)
        if not callable(probe) and not callable(probe_fn):
            return

        def _probe_sync() -> None:
            """Blocking INFORMATION_SCHEMA probe (runs in a worker thread)."""
            fn = probe if callable(probe) else probe_fn
            assert fn is not None
            if hasattr(mysql_db, "connection"):
                cm = mysql_db.connection()
                with cm as conn:
                    fn(conn)
            else:
                fn(None)

        try:
            # Prefer async path only when probe itself is a coroutine function.
            active = probe if callable(probe) else probe_fn
            if inspect.iscoroutinefunction(active):
                if hasattr(mysql_db, "connection"):
                    cm = mysql_db.connection()
                    if hasattr(cm, "__aenter__"):
                        async with cm as conn:
                            await asyncio.wait_for(
                                active(conn), timeout=self._mysql_ping_timeout
                            )
                    else:
                        with cm as conn:
                            await asyncio.wait_for(
                                active(conn), timeout=self._mysql_ping_timeout
                            )
                else:
                    await asyncio.wait_for(
                        active(None), timeout=self._mysql_ping_timeout
                    )
            else:
                await asyncio.wait_for(
                    asyncio.to_thread(_probe_sync),
                    timeout=self._mysql_ping_timeout,
                )
        except asyncio.TimeoutError as exc:
            _log_failure("claim_probe", CATEGORY_CLAIM_PROBE, exc)
            raise InternalPlaneError(CATEGORY_CLAIM_PROBE) from exc

    async def _run_claim_recovery(self, claim_validator: Any) -> None:
        """Run trusted durable claim recovery off the event loop.

        Recovery is deliberately a separate lifecycle step from the schema
        probe so a database/ledger failure is surfaced as a startup failure,
        never as a partially ready Sandbox.  The method is optional only for
        protocol fakes used by offline lifecycle tests; the production
        ``ToolExecutionClaimValidator`` always implements it.
        """
        recover = getattr(claim_validator, "recover_running_executions", None)
        if not callable(recover):
            return
        try:
            result = await invoke_maybe_async(
                recover,
                timeout=self._mysql_ping_timeout,
                run_sync_in_thread=True,
            )
            if type(result) is not int or result < 0:
                raise ValueError("claim recovery returned an invalid count")
            if result:
                logger.info("reconciled %d durable RUNNING Sandbox claim(s)", result)
        except asyncio.TimeoutError as exc:
            _log_failure("claim_recovery", CATEGORY_CLAIM_RECOVERY, exc)
            raise InternalPlaneError(CATEGORY_CLAIM_RECOVERY) from exc
        except InternalPlaneError:
            raise
        except Exception as exc:
            _log_failure("claim_recovery", CATEGORY_CLAIM_RECOVERY, exc)
            raise InternalPlaneError(CATEGORY_CLAIM_RECOVERY) from exc

    async def _safe_close(self, redis_client: Any, mysql_db: Any) -> None:
        if redis_client is not None:
            await self._close_one(
                redis_client,
                custom=self._close_redis,
                preferred=("aclose", "close"),
                label="redis",
            )
        if mysql_db is not None:
            await self._close_one(
                mysql_db,
                custom=self._close_mysql,
                preferred=("close", "aclose"),
                label="mysql",
            )

    async def _close_one(
        self,
        obj: Any,
        *,
        custom: Callable[[Any], Any] | None,
        preferred: tuple[str, ...],
        label: str,
    ) -> None:
        try:
            if custom is not None:
                await invoke_maybe_async(
                    custom,
                    obj,
                    timeout=self._close_timeout,
                    # MySQL close is typically sync; redis aclose is async.
                    run_sync_in_thread=(label == "mysql"),
                )
                return
            for name in preferred:
                fn = getattr(obj, name, None)
                if not callable(fn):
                    continue
                if inspect.iscoroutinefunction(fn):
                    await asyncio.wait_for(fn(), timeout=self._close_timeout)
                    return
                # Sync close (PyMySQL) off the loop.
                await asyncio.wait_for(
                    asyncio.to_thread(fn),
                    timeout=self._close_timeout,
                )
                return
        except asyncio.TimeoutError:
            _log_failure(f"close_{label}", CATEGORY_CLOSE, None)
        except Exception as exc:
            _log_failure(f"close_{label}", CATEGORY_CLOSE, exc)

    def is_bundle_ready(self) -> bool:
        """True when traffic may use the internal plane via this bundle."""
        if self._state is InternalPlaneState.DISABLED:
            return True
        return self._state is InternalPlaneState.INSTALLED


# Process-wide registry (optional). Lifespan wiring is deferred; tests inject.
_registry_lock = threading.Lock()
_registered_bundle: InternalPlaneResources | None = None


def register_internal_plane_bundle(bundle: InternalPlaneResources | None) -> None:
    """Register the process bundle for readiness evaluation (no lifespan)."""
    global _registered_bundle
    with _registry_lock:
        _registered_bundle = bundle


def get_internal_plane_bundle() -> InternalPlaneResources | None:
    with _registry_lock:
        return _registered_bundle


def evaluate_internal_plane_readiness(
    bundle: InternalPlaneResources | None,
    *,
    enabled: bool,
) -> bool:
    """Readiness rule for the internal plane.

    * ``enabled=False`` → always True (maintain status quo; plane unused).
    * ``enabled=True`` → require a non-None INSTALLED bundle.
    """
    if not enabled:
        return True
    if bundle is None:
        return False
    if not bundle.enabled:
        # Config says enabled but bundle was built disabled — fail closed.
        return False
    return bundle.state is InternalPlaneState.INSTALLED


def evaluate_registered_internal_plane_readiness(*, enabled: bool) -> bool:
    """Convenience: evaluate the process-registered bundle."""
    return evaluate_internal_plane_readiness(
        get_internal_plane_bundle(), enabled=enabled
    )
