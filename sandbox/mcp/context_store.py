"""Redis authority for external MCP ``context_id`` to Sandbox identities."""

from __future__ import annotations

import asyncio
import json
import re
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from typing import Any

from sandbox.app.domain.ulid import new_ulid
from sandbox.mcp.settings import McpSettings

_CONTEXT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$")
_KEY_PART_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class ContextStoreError(RuntimeError):
    """A safe, caller-visible MCP context failure."""


@dataclass(frozen=True, slots=True)
class ContextRecord:
    context_id: str
    sandbox_session_id: str
    workspace_id: str


class ContextStore:
    """Persistent mapping plus a short Redis lock for first-use provisioning."""

    def __init__(self, settings: McpSettings, redis_client: Any | None = None) -> None:
        self._settings = settings
        self._redis = redis_client

    async def start(self) -> None:
        if self._redis is not None:
            return
        try:
            import redis.asyncio as redis_async  # type: ignore[import-untyped]

            self._redis = redis_async.from_url(
                self._settings.redis_url, encoding="utf-8", decode_responses=True
            )
            await self._redis.ping()
        except Exception as exc:
            self._redis = None
            raise ContextStoreError("MCP context store is unavailable") from exc

    async def close(self) -> None:
        client, self._redis = self._redis, None
        if client is None:
            return
        close = getattr(client, "aclose", None) or getattr(client, "close", None)
        if close is not None:
            result = close()
            if hasattr(result, "__await__"):
                await result

    def _scope(self) -> str:
        if not _KEY_PART_RE.fullmatch(self._settings.client_id) or not _KEY_PART_RE.fullmatch(
            self._settings.tenant_id
        ):
            raise ContextStoreError("MCP context store is unavailable")
        return f"{self._settings.redis_prefix}:{self._settings.tenant_id}:{self._settings.client_id}"

    def _context_key(self, context_id: str) -> str:
        return f"{self._scope()}:context:{context_id}"

    def _lock_key(self, context_id: str) -> str:
        return f"{self._scope()}:lock:{context_id}"

    def artifact_key(self, artifact_id: str) -> str:
        return f"{self._scope()}:artifact:{artifact_id}"

    @staticmethod
    def _normalise_context_id(context_id: str | None) -> str:
        value = new_ulid() if context_id is None or not context_id.strip() else context_id.strip()
        if not _CONTEXT_RE.fullmatch(value):
            raise ContextStoreError("Invalid context_id")
        return value

    async def _get(self, context_id: str) -> ContextRecord | None:
        if self._redis is None:
            raise ContextStoreError("MCP context store is unavailable")
        data = await self._redis.hgetall(self._context_key(context_id))
        if not data:
            return None
        try:
            return ContextRecord(
                context_id=context_id,
                sandbox_session_id=str(data["sandbox_session_id"]),
                workspace_id=str(data["workspace_id"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ContextStoreError("MCP context mapping is invalid") from exc

    async def resolve(
        self,
        context_id: str | None,
        ensure_context: Callable[[ContextRecord], Awaitable[None]],
    ) -> ContextRecord:
        """Read a mapping or create+verify it once under a distributed lock."""
        safe_context_id = self._normalise_context_id(context_id)
        existing = await self._get(safe_context_id)
        if existing is not None:
            return existing

        if self._redis is None:
            raise ContextStoreError("MCP context store is unavailable")
        owner = secrets.token_urlsafe(18)
        lock_key = self._lock_key(safe_context_id)
        deadline = time.monotonic() + max(2, self._settings.lock_ttl_seconds)
        acquired = False
        while time.monotonic() < deadline:
            acquired = bool(
                await self._redis.set(
                    lock_key, owner, nx=True, ex=self._settings.lock_ttl_seconds
                )
            )
            if acquired:
                break
            await asyncio.sleep(0.05)
            existing = await self._get(safe_context_id)
            if existing is not None:
                return existing
        if not acquired:
            raise ContextStoreError("Context is busy; retry the request")

        try:
            existing = await self._get(safe_context_id)
            if existing is not None:
                return existing
            record = ContextRecord(
                context_id=safe_context_id,
                sandbox_session_id=new_ulid(),
                workspace_id=new_ulid(),
            )
            await ensure_context(record)
            await self._redis.hset(self._context_key(safe_context_id), mapping=asdict(record))
            await self._redis.expire(
                self._context_key(safe_context_id), self._settings.context_ttl_seconds
            )
            return record
        except ContextStoreError:
            raise
        except Exception as exc:
            raise ContextStoreError("Unable to provision Sandbox context") from exc
        finally:
            # Compare-and-delete prevents an expired lock holder deleting a newer lock.
            try:
                await self._redis.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
                    1,
                    lock_key,
                    owner,
                )
            except Exception:
                pass

    async def touch(self, record: ContextRecord) -> None:
        if self._redis is None:
            raise ContextStoreError("MCP context store is unavailable")
        await self._redis.expire(self._context_key(record.context_id), self._settings.context_ttl_seconds)

    async def put_artifact(self, artifact_id: str, metadata: dict[str, Any]) -> None:
        if self._redis is None:
            raise ContextStoreError("MCP context store is unavailable")
        await self._redis.set(
            self.artifact_key(artifact_id),
            json.dumps(metadata, separators=(",", ":")),
            ex=self._settings.artifact_ttl_seconds,
        )

    async def get_artifact(self, artifact_id: str) -> dict[str, Any] | None:
        if self._redis is None:
            raise ContextStoreError("MCP context store is unavailable")
        raw = await self._redis.get(self.artifact_key(artifact_id))
        if not raw:
            return None
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ContextStoreError("MCP artifact metadata is invalid") from exc
        return data if isinstance(data, dict) else None


__all__ = ["ContextRecord", "ContextStore", "ContextStoreError"]
