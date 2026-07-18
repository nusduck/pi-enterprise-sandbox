"""Fail-closed replay protection for authenticated internal requests.

``RedisReplayStore`` is deliberately dependency-free: application wiring owns the
Redis client and injects it here.  In particular, this module never substitutes
an in-memory store after a Redis error; doing so would turn a Redis outage into a
replay-acceptance vulnerability.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
from typing import Any, Protocol


REPLAY_KEY_PREFIX = "sandbox:internal:replay:v1:"
MAX_REPLAY_CLAIM_LENGTH = 255


class ReplayStoreValidationError(ValueError):
    """A replay token identifier or its validity window is malformed."""


class ReplayStoreUnavailableError(RuntimeError):
    """The authoritative replay store could not make an atomic decision."""


class ReplayStore(Protocol):
    """Atomically consume a token identifier, returning True only once."""

    async def consume(
        self,
        *,
        issuer: str,
        audience: str,
        jti: str,
        expires_at: int,
        now: int,
        leeway: int,
    ) -> bool: ...


class AsyncRedisLike(Protocol):
    """Minimal redis-py compatible surface needed by :class:`RedisReplayStore`."""

    async def set(
        self,
        key: str,
        value: str,
        *,
        nx: bool,
        ex: int,
    ) -> Any: ...


def _assert_claim(value: object, *, name: str) -> str:
    # ``bool`` is not a string, and accepting subclasses would make the bytes
    # used for the authority key less explicit.  Do not strip: a verifier must
    # make the same claim comparison as the request it authenticated.
    if type(value) is not str:
        raise ReplayStoreValidationError(f"{name} must be a string")
    if not value or not value.strip():
        raise ReplayStoreValidationError(f"{name} must be nonempty")
    # The key material is NUL-delimited.  Permit neither a collision between
    # field boundaries nor a differently parsed identity to share a key.
    if "\0" in value:
        raise ReplayStoreValidationError(f"{name} must not contain a null byte")
    if len(value) > MAX_REPLAY_CLAIM_LENGTH:
        raise ReplayStoreValidationError(
            f"{name} exceeds {MAX_REPLAY_CLAIM_LENGTH} characters"
        )
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ReplayStoreValidationError(f"{name} is not valid UTF-8 text") from exc
    return value


def _assert_time(value: object, *, name: str) -> int:
    if type(value) is not int:
        raise ReplayStoreValidationError(f"{name} must be an integer")
    return value


def validate_replay_request(
    *,
    issuer: object,
    audience: object,
    jti: object,
    expires_at: object,
    now: object,
    leeway: object,
) -> tuple[str, str, str, int, int, int]:
    """Validate inputs before attempting a replay-store write.

    The strict ``type(value) is int`` rule intentionally rejects booleans.  A
    token at or after ``exp + leeway`` is never written, so it cannot reserve a
    replay key with a non-positive Redis TTL.
    """

    clean_issuer = _assert_claim(issuer, name="issuer")
    clean_audience = _assert_claim(audience, name="audience")
    clean_jti = _assert_claim(jti, name="jti")
    clean_expires_at = _assert_time(expires_at, name="expires_at")
    clean_now = _assert_time(now, name="now")
    clean_leeway = _assert_time(leeway, name="leeway")
    if not 0 <= clean_leeway <= 5:
        raise ReplayStoreValidationError("leeway must be between 0 and 5 seconds")
    if clean_expires_at + clean_leeway <= clean_now:
        raise ReplayStoreValidationError("token has expired")
    return (
        clean_issuer,
        clean_audience,
        clean_jti,
        clean_expires_at,
        clean_now,
        clean_leeway,
    )


def replay_store_key(*, issuer: str, audience: str, jti: str) -> str:
    """Return the opaque Redis key for an already-validated token identity."""

    material = f"{issuer}\0{audience}\0{jti}".encode("utf-8")
    return REPLAY_KEY_PREFIX + hashlib.sha256(material).hexdigest()


class RedisReplayStore:
    """Redis-backed, atomic replay store.

    Redis ``SET ... NX EX`` is the sole authority: a falsey result means the
    token was seen already.  Client failures are converted to one dedicated
    error so callers can deny the request rather than accidentally continuing.
    """

    def __init__(self, client: AsyncRedisLike) -> None:
        self._client = client

    async def consume(
        self,
        *,
        issuer: str,
        audience: str,
        jti: str,
        expires_at: int,
        now: int,
        leeway: int,
    ) -> bool:
        (
            issuer,
            audience,
            jti,
            expires_at,
            now,
            leeway,
        ) = validate_replay_request(
            issuer=issuer,
            audience=audience,
            jti=jti,
            expires_at=expires_at,
            now=now,
            leeway=leeway,
        )
        key = replay_store_key(issuer=issuer, audience=audience, jti=jti)
        ttl = math.ceil(expires_at - now + leeway)
        try:
            result = await self._client.set(key, "1", nx=True, ex=ttl)
        except Exception as exc:
            raise ReplayStoreUnavailableError("replay store is unavailable") from exc
        return bool(result)


class InMemoryReplayStore:
    """Small, explicitly-constructed test double; never use as production wiring.

    The bounded cleanup pass prevents a test that creates many expired tokens
    from making each next consume operation unbounded.  On capacity exhaustion
    it fails closed instead of evicting a still-valid replay key.
    """

    def __init__(
        self,
        *,
        max_entries: int = 10_000,
        cleanup_batch_size: int = 128,
    ) -> None:
        if type(max_entries) is not int or max_entries < 1:
            raise ValueError("max_entries must be a positive integer")
        if type(cleanup_batch_size) is not int or cleanup_batch_size < 1:
            raise ValueError("cleanup_batch_size must be a positive integer")
        self._max_entries = max_entries
        self._cleanup_batch_size = cleanup_batch_size
        self._entries: dict[str, int] = {}
        self._lock = asyncio.Lock()

    async def consume(
        self,
        *,
        issuer: str,
        audience: str,
        jti: str,
        expires_at: int,
        now: int,
        leeway: int,
    ) -> bool:
        (
            issuer,
            audience,
            jti,
            expires_at,
            now,
            leeway,
        ) = validate_replay_request(
            issuer=issuer,
            audience=audience,
            jti=jti,
            expires_at=expires_at,
            now=now,
            leeway=leeway,
        )
        key = replay_store_key(issuer=issuer, audience=audience, jti=jti)
        deadline = expires_at + leeway

        async with self._lock:
            self._cleanup_expired(now=now)
            existing_deadline = self._entries.get(key)
            if existing_deadline is not None:
                if existing_deadline > now:
                    return False
                # An incoming key may fall outside the bounded cleanup window;
                # it is still safe to reclaim it when it is itself expired.
                del self._entries[key]
            if len(self._entries) >= self._max_entries:
                raise ReplayStoreUnavailableError("in-memory replay store is full")
            self._entries[key] = deadline
            return True

    def _cleanup_expired(self, *, now: int) -> None:
        expired: list[str] = []
        scanned = 0
        for key, deadline in self._entries.items():
            if scanned >= self._cleanup_batch_size:
                break
            scanned += 1
            if deadline <= now:
                expired.append(key)
        for key in expired:
            del self._entries[key]
