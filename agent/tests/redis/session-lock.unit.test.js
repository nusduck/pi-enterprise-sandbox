/**
 * SessionLockManager offline unit tests (PR-05).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedis, createFakeRedisState } from './fake-redis.js';
import {
  SessionLockManager,
  sessionLockKey,
  SESSION_LOCK_TTL_MS,
  SESSION_LOCK_RENEW_LUA,
  SESSION_LOCK_RELEASE_LUA,
  SessionLockError,
  generateSessionLockOwnerToken,
  assertAgentSessionId,
} from '../../src/infrastructure/redis/index.js';

const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const WORKER = 'worker-a';

describe('sessionLockKey / assertAgentSessionId', () => {
  it('uses canonical agent:session-lock key and session ULID field', () => {
    assert.equal(sessionLockKey(SESS), `agent:session-lock:${SESS}`);
    assert.equal(assertAgentSessionId(SESS), SESS);
    assert.throws(() => assertAgentSessionId('not-a-ulid'));
  });
});

describe('generateSessionLockOwnerToken', () => {
  it('produces distinct tokens for the same worker identity', () => {
    const a = generateSessionLockOwnerToken(WORKER);
    const b = generateSessionLockOwnerToken(WORKER);
    assert.notEqual(a, b);
    assert.match(a, /^worker-a:[0-9a-f]{32}$/);
    assert.match(b, /^worker-a:[0-9a-f]{32}$/);
  });

  it('rejects empty worker identity', () => {
    assert.throws(
      () => generateSessionLockOwnerToken(''),
      SessionLockError,
    );
  });
});

describe('SessionLockManager', () => {
  /** @type {ReturnType<typeof createFakeRedisState>} */
  let state;
  /** @type {ReturnType<typeof createFakeRedis>} */
  let redis;
  /** @type {SessionLockManager} */
  let locks;
  let tokenA;
  let tokenB;

  beforeEach(() => {
    state = createFakeRedisState();
    redis = createFakeRedis(state);
    locks = new SessionLockManager(redis, { ttlMs: SESSION_LOCK_TTL_MS });
    tokenA = generateSessionLockOwnerToken(WORKER);
    tokenB = generateSessionLockOwnerToken(WORKER);
  });

  it('rejects non-positive ttl/renew config', () => {
    assert.throws(
      () => new SessionLockManager(redis, { ttlMs: 0 }),
      SessionLockError,
    );
    assert.throws(
      () => new SessionLockManager(redis, { renewIntervalMs: -1 }),
      SessionLockError,
    );
  });

  it('acquire is SET NX PX winner-takes-all with distinct tokens', async () => {
    assert.notEqual(tokenA, tokenB);
    assert.equal(await locks.acquire(SESS, tokenA), true);
    assert.equal(await locks.acquire(SESS, tokenB), false);
    assert.equal(await locks.getOwner(SESS), tokenA);
  });

  it('renew/release are token-safe', async () => {
    await locks.acquire(SESS, tokenA);
    assert.equal(await locks.renew(SESS, tokenB), false);
    assert.equal(await locks.renew(SESS, tokenA), true);
    assert.equal(await locks.release(SESS, tokenB), false);
    assert.equal(await locks.release(SESS, tokenA), true);
  });

  it('acquireOrThrow raises SessionLockError with agentSessionId', async () => {
    await locks.acquire(SESS, tokenA);
    await assert.rejects(
      () => locks.acquireOrThrow(SESS, tokenB),
      (err) =>
        err instanceof SessionLockError &&
        err.code === 'SESSION_LOCK_NOT_ACQUIRED' &&
        err.agentSessionId === SESS,
    );
  });

  it('exports token-safe Lua scripts', () => {
    assert.match(SESSION_LOCK_RENEW_LUA, /PEXPIRE/);
    assert.match(SESSION_LOCK_RELEASE_LUA, /DEL/);
  });

  it('startRenewLoop reports loss with SessionLockError', async () => {
    await locks.acquire(SESS, tokenA);
    /** @type {unknown[]} */
    const lost = [];
    const handle = locks.startRenewLoop(SESS, tokenA, {
      intervalMs: 5,
      onLost: (e) => lost.push(e),
    });
    await redis.set(sessionLockKey(SESS), tokenB, 'PX', 30_000);
    await new Promise((r) => setTimeout(r, 25));
    await handle.stop();
    assert.ok(lost.length >= 1);
  });
});
