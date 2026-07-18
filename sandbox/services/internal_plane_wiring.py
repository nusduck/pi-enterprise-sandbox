"""Production wiring for the Sandbox internal control plane (PR-07).

Builds injectable factories for:
  - redis.asyncio client (lazy import) — **replay-only** authority
  - RedisReplayStore
  - Sandbox MysqlDatabase + ToolExecutionClaimValidator
  - InternalFileReader + InternalExecutionSupervisor + FilesReadRuntime

Does **not** import redis at module load (offline unit tests inject fakes).
Does **not** claim Agent broad runtime Redis authority (queues/leases/streams).
Error paths never embed DSNs, passwords, or driver message text.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from sandbox.app.domain.ulid import new_ulid
from sandbox.app.persistence.db import create_mysql_database
from sandbox.app.persistence.repositories.tool_execution_claim_validator import (
    ToolExecutionClaimValidator,
)
from sandbox.config import (
    Settings,
    validate_internal_plane_config,
)
from sandbox.security.internal_http_auth import set_replay_store
from sandbox.security.replay_store import RedisReplayStore
from sandbox.services.files_read_runtime import (
    FilesReadRuntime,
    set_files_read_runtime,
)
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor
from sandbox.services.internal_file_reader import InternalFileReader
from sandbox.services.internal_plane_resources import (
    CATEGORY_CONFIG,
    CATEGORY_REDIS_CREATE,
    InternalPlaneConfigView,
    InternalPlaneError,
    InternalPlaneResources,
    InternalPlaneState,
    register_internal_plane_bundle,
)

logger = logging.getLogger("sandbox.services.internal_plane_wiring")


def _load_redis_asyncio() -> Any:
    """Lazy import redis.asyncio — never at module import time."""
    try:
        import redis.asyncio as redis_async  # type: ignore[import-untyped]
    except ImportError as exc:
        raise InternalPlaneError(CATEGORY_REDIS_CREATE) from exc
    return redis_async


async def create_replay_redis_client(redis_url: str) -> Any:
    """Create a redis.asyncio client for **replay SET NX only**.

    Minimal client options: no decoding surprises; socket timeouts from URL
    defaults. Callers must ``await client.aclose()`` on shutdown.
    """
    redis_async = _load_redis_asyncio()
    try:
        # from_url is sync construct; connection happens on first command / ping.
        client = redis_async.from_url(
            redis_url,
            encoding="utf-8",
            decode_responses=True,
            single_connection_client=False,
        )
    except InternalPlaneError:
        raise
    except Exception as exc:
        # Never include URL or driver text in the raised category error.
        logger.warning(
            "internal plane redis client create failed type=%s",
            type(exc).__name__,
        )
        raise InternalPlaneError(CATEGORY_REDIS_CREATE) from exc
    return client


def create_replay_store(redis_client: Any) -> RedisReplayStore:
    return RedisReplayStore(redis_client)


def create_sandbox_mysql_database(
    database_url: str,
    **kwargs: Any,
) -> Any:
    """Sync MySQL factory (caller runs via to_thread). No DDL."""
    return create_mysql_database(
        database_url,
        connect_timeout=int(kwargs.get("connect_timeout", 5)),
        read_timeout=int(kwargs.get("read_timeout", 30)),
        write_timeout=int(kwargs.get("write_timeout", 30)),
        max_connections=int(kwargs.get("max_connections", 8)),
    )


def create_claim_validator(db: Any) -> ToolExecutionClaimValidator:
    return ToolExecutionClaimValidator(db)


async def close_redis_client(client: Any) -> None:
    if client is None:
        return
    aclose = getattr(client, "aclose", None)
    if callable(aclose):
        await aclose()
        return
    close = getattr(client, "close", None)
    if callable(close):
        result = close()
        if hasattr(result, "__await__"):
            await result


def close_mysql_database(db: Any) -> None:
    """Best-effort: MysqlDatabase has no pool destroy; connections are per-op."""
    close = getattr(db, "close", None)
    if callable(close):
        close()


class FastApiInternalPlaneTarget:
    """Atomic install target for FastAPI app.state slots + files.read runtime.

    Install order (resources.install): mysql → claim_validator → replay_store.
    On claim_validator set, builds FilesReadRuntime and installs it.
    On any None clear, files.read runtime is cleared (fail closed).
    """

    def __init__(
        self,
        app: Any,
        *,
        supervisor: InternalExecutionSupervisor,
        reader: InternalFileReader | Any | None = None,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.app = app
        self.supervisor = supervisor
        self.reader = reader if reader is not None else InternalFileReader()
        self.id_factory = id_factory or new_ulid
        self.mysql_database: Any | None = None
        self.claim_validator: Any | None = None
        self.files_read_runtime: FilesReadRuntime | None = None

    def set_mysql_database(self, db: Any | None) -> None:
        self.mysql_database = db

    def set_claim_validator(self, validator: Any | None) -> None:
        self.claim_validator = validator
        if validator is None:
            self.files_read_runtime = None
            set_files_read_runtime(self.app, None)
            return
        runtime = FilesReadRuntime(
            claim_validator=validator,
            reader=self.reader,
            id_factory=self.id_factory,
            supervisor=self.supervisor,
        )
        self.files_read_runtime = runtime
        set_files_read_runtime(self.app, runtime)

    def set_replay_store(self, store: Any | None) -> None:
        set_replay_store(self.app, store)


async def start_internal_plane(
    app: Any,
    settings: Settings,
    *,
    redis_factory: Callable[[str], Any] | None = None,
    replay_store_factory: Callable[[Any], Any] | None = None,
    mysql_factory: Callable[..., Any] | None = None,
    claim_validator_factory: Callable[[Any], Any] | None = None,
    close_redis: Callable[[Any], Any] | None = None,
    close_mysql: Callable[[Any], Any] | None = None,
    supervisor: InternalExecutionSupervisor | None = None,
    reader: Any | None = None,
    id_factory: Callable[[], str] | None = None,
) -> InternalPlaneResources:
    """Validate, prepare, install, and register the internal-plane bundle.

    * ``internal_plane_enabled=False``: register a DISABLED bundle (dev compat);
      no Redis/MySQL factories invoked.
    * ``enabled=True``: pure config gate, dual ping, claim probe, atomic install.
      Any severe failure raises :class:`InternalPlaneError` (fail closed).

    Factories default to production implementations (lazy redis import).
    """
    try:
        validate_internal_plane_config(settings)
    except ValueError as exc:
        logger.warning(
            "internal plane config invalid type=%s",
            type(exc).__name__,
        )
        raise InternalPlaneError(CATEGORY_CONFIG) from exc

    cfg = InternalPlaneConfigView.from_settings(settings)

    if not cfg.enabled:
        bundle = InternalPlaneResources(cfg)
        register_internal_plane_bundle(bundle)
        logger.info(
            "internal plane disabled (state=%s) — routes fail closed if hit",
            bundle.state.value,
        )
        return bundle

    sup = supervisor or InternalExecutionSupervisor(
        max_active=int(settings.internal_max_concurrency)
    )
    target = FastApiInternalPlaneTarget(
        app,
        supervisor=sup,
        reader=reader,
        id_factory=id_factory,
    )
    # Strong ref for shutdown reconcile after app.state slots are cleared.
    runtime_box: list[FilesReadRuntime | None] = [None]
    _orig_set_claim = target.set_claim_validator

    def _set_claim_and_track(validator: Any | None) -> None:
        _orig_set_claim(validator)
        if validator is not None:
            runtime_box[0] = target.files_read_runtime
        # On clear, keep last runtime for reconcile (do not null runtime_box).

    target.set_claim_validator = _set_claim_and_track  # type: ignore[method-assign]

    async def drain_fn() -> bool:
        # Bounded by uninstall wait_for using config drain timeout.
        return await sup.close_and_drain(
            float(settings.internal_drain_timeout_seconds)
        )

    async def reconcile_fn() -> int:
        """Mark remaining claimed work UNKNOWN while MySQL is still open."""
        import asyncio

        rt = runtime_box[0]
        if rt is None:
            return 0
        return await asyncio.to_thread(rt.reconcile_inflight_as_unknown)

    drain_timeout = float(settings.internal_drain_timeout_seconds)
    bundle = InternalPlaneResources(
        cfg,
        redis_factory=redis_factory or create_replay_redis_client,
        replay_store_factory=replay_store_factory or create_replay_store,
        mysql_factory=mysql_factory or create_sandbox_mysql_database,
        claim_validator_factory=claim_validator_factory or create_claim_validator,
        close_redis=close_redis or close_redis_client,
        close_mysql=close_mysql or close_mysql_database,
        drain_fn=drain_fn,
        reconcile_fn=reconcile_fn,
        redis_ping_timeout_seconds=float(settings.mysql_connect_timeout_seconds),
        mysql_ping_timeout_seconds=float(settings.mysql_connect_timeout_seconds),
        close_timeout_seconds=max(1.0, drain_timeout if drain_timeout > 0 else 1.0),
        reconcile_timeout_seconds=max(
            1.0, min(30.0, drain_timeout if drain_timeout > 0 else 5.0)
        ),
    )

    # Prepare + install under bundle lock (serialized).
    await bundle.prepare()
    await bundle.install(target)
    if bundle.state is not InternalPlaneState.INSTALLED:
        # Never register READY-without-install.
        await bundle.uninstall()
        raise InternalPlaneError(CATEGORY_CONFIG, state=bundle.state.value)

    register_internal_plane_bundle(bundle)
    logger.info(
        "internal plane installed state=%s max_concurrency=%s",
        bundle.state.value,
        settings.internal_max_concurrency,
    )
    return bundle


async def stop_internal_plane(bundle: InternalPlaneResources | None) -> None:
    """Bounded shutdown: stop admit (slots) → drain → close resources."""
    if bundle is None:
        register_internal_plane_bundle(None)
        return
    try:
        await bundle.uninstall()
    except Exception as exc:
        logger.warning(
            "internal plane uninstall failed type=%s",
            type(exc).__name__,
        )
    finally:
        register_internal_plane_bundle(None)


__all__ = [
    "FastApiInternalPlaneTarget",
    "close_mysql_database",
    "close_redis_client",
    "create_claim_validator",
    "create_replay_redis_client",
    "create_replay_store",
    "create_sandbox_mysql_database",
    "start_internal_plane",
    "stop_internal_plane",
]
