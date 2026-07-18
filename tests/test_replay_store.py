"""Hermetic tests for the internal-auth replay-store contract."""

from __future__ import annotations

import asyncio

import pytest

from sandbox.security.replay_store import (
    REPLAY_KEY_PREFIX,
    InMemoryReplayStore,
    RedisReplayStore,
    ReplayStoreUnavailableError,
    ReplayStoreValidationError,
    replay_store_key,
)


class FakeRedis:
    def __init__(self, response: object = "OK", error: Exception | None = None) -> None:
        self.response = response
        self.error = error
        self.calls: list[tuple[str, str, bool, int]] = []

    async def set(self, key: str, value: str, *, nx: bool, ex: int) -> object:
        self.calls.append((key, value, nx, ex))
        if self.error is not None:
            raise self.error
        return self.response


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"issuer": "", "audience": "sandbox", "jti": "j"}, "issuer"),
        ({"issuer": "   ", "audience": "sandbox", "jti": "j"}, "issuer"),
        ({"issuer": "agent\x00other", "audience": "sandbox", "jti": "j"}, "issuer"),
        ({"issuer": "\ud800", "audience": "sandbox", "jti": "j"}, "issuer"),
        ({"issuer": "agent", "audience": "", "jti": "j"}, "audience"),
        ({"issuer": "agent", "audience": "sandbox", "jti": ""}, "jti"),
        ({"issuer": "a" * 256, "audience": "sandbox", "jti": "j"}, "issuer"),
        ({"issuer": "agent", "audience": "sandbox", "jti": "j", "expires_at": True}, "expires_at"),
        ({"issuer": "agent", "audience": "sandbox", "jti": "j", "now": False}, "now"),
        ({"issuer": "agent", "audience": "sandbox", "jti": "j", "leeway": True}, "leeway"),
        ({"issuer": "agent", "audience": "sandbox", "jti": "j", "leeway": 6}, "leeway"),
        ({"issuer": "agent", "audience": "sandbox", "jti": "j", "expires_at": 100}, "expired"),
    ],
)
async def test_redis_store_rejects_invalid_inputs_before_client_call(
    kwargs: dict[str, object], message: str
) -> None:
    client = FakeRedis()
    store = RedisReplayStore(client)
    params: dict[str, object] = {
        "issuer": "agent",
        "audience": "sandbox",
        "jti": "token-1",
        "expires_at": 110,
        "now": 100,
        "leeway": 0,
    }
    params.update(kwargs)
    with pytest.raises(ReplayStoreValidationError, match=message):
        await store.consume(**params)  # type: ignore[arg-type]
    assert client.calls == []


async def test_redis_store_hashes_exact_nul_delimited_identity_and_uses_set_nx_ex() -> None:
    client = FakeRedis()
    store = RedisReplayStore(client)

    assert await store.consume(
        issuer="agent-service",
        audience="sandbox-service",
        jti="jti-123",
        expires_at=107,
        now=100,
        leeway=2,
    ) is True

    key = replay_store_key(
        issuer="agent-service", audience="sandbox-service", jti="jti-123"
    )
    assert key == (
        "sandbox:internal:replay:v1:"
        "84e3d4281854936875d01e5aa71998e1cc188d8b93b5f4ad75930ee2002165de"
    )
    assert key.startswith(REPLAY_KEY_PREFIX)
    assert client.calls == [(key, "1", True, 9)]


@pytest.mark.parametrize("response", [None, False])
async def test_redis_duplicate_is_false(response: object) -> None:
    client = FakeRedis(response=response)
    assert await RedisReplayStore(client).consume(
        issuer="agent", audience="sandbox", jti="once", expires_at=120, now=100, leeway=0
    ) is False


@pytest.mark.parametrize(
    "error",
    [TimeoutError("timeout"), ConnectionError("down"), RuntimeError("NOAUTH"), ValueError("ambiguous")],
)
async def test_all_redis_client_errors_fail_closed(error: Exception) -> None:
    client = FakeRedis(error=error)
    with pytest.raises(ReplayStoreUnavailableError) as raised:
        await RedisReplayStore(client).consume(
            issuer="agent", audience="sandbox", jti="once", expires_at=120, now=100, leeway=0
        )
    assert raised.value.__cause__ is error


async def test_in_memory_store_allows_only_one_concurrent_consumer() -> None:
    store = InMemoryReplayStore()

    results = await asyncio.gather(
        *(
            store.consume(
                issuer="agent",
                audience="sandbox",
                jti="same-token",
                expires_at=200,
                now=100,
                leeway=0,
            )
            for _ in range(20)
        )
    )

    assert results.count(True) == 1
    assert results.count(False) == 19


async def test_in_memory_key_is_reusable_after_old_entry_expires() -> None:
    store = InMemoryReplayStore()
    assert await store.consume(
        issuer="agent", audience="sandbox", jti="same", expires_at=101, now=100, leeway=0
    )
    assert not await store.consume(
        issuer="agent", audience="sandbox", jti="same", expires_at=101, now=100, leeway=0
    )
    # The old assertion has expired at 101.  A newly issued token with this jti
    # is safe to claim once its prior replay reservation is no longer valid.
    assert await store.consume(
        issuer="agent", audience="sandbox", jti="same", expires_at=200, now=101, leeway=0
    )
