/**
 * Bounded Redis connection error logging (long outage must not flood).
 * Pure guard + EventEmitter attach — no ioredis install required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  attachRedisConnectionErrorGuard,
  classifyRedisConnectionError,
  createConnectionErrorGuard,
  hasRedisConnectionErrorGuard,
  REDIS_ERROR_GUARD_CLEANUP,
  sanitizeRedisLogText,
} from '../../src/infrastructure/redis/redis-connection-error-guard.js';
import {
  createGuardedRedisClass,
  destroyRedisClient,
} from '../../src/infrastructure/redis/client.js';

describe('sanitizeRedisLogText / classifyRedisConnectionError', () => {
  it('redacts redis DSN and password material', () => {
    const s = sanitizeRedisLogText(
      'connect ECONNREFUSED redis://sandbox:s3cret@mysql:6379/0 password=s3cret',
    );
    assert.doesNotMatch(s, /s3cret/);
    assert.match(s, /redis:\/\/\*\*\*/);
    assert.match(s, /password=\*\*\*/);
  });

  it('classifies error code and redacts message/stack', () => {
    const err = new Error('Failed redis://u:p@host:6379/0');
    err.code = 'ECONNREFUSED';
    err.stack = 'Error: Failed redis://u:p@host:6379/0\n    at x';
    const c = classifyRedisConnectionError(err);
    assert.equal(c.category, 'ECONNREFUSED');
    assert.doesNotMatch(c.message, /:p@|u:p/);
    assert.ok(c.stack);
    assert.doesNotMatch(c.stack, /u:p@/);
  });
});

describe('createConnectionErrorGuard rate limit (fake clock)', () => {
  it('logs first error, suppresses flood, logs again after interval with suppressed count', () => {
    let t = 1_000_000;
    /** @type {Array<{ level: string, message: string, meta?: object }>} */
    const logs = [];
    const guard = createConnectionErrorGuard({
      role: 'test-redis',
      minIntervalMs: 30_000,
      now: () => t,
      log: (level, message, meta) => {
        logs.push({ level, message, meta });
      },
    });

    const err = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });

    guard.onError(err);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'error');
    assert.match(logs[0].message, /test-redis/);
    assert.match(logs[0].message, /ECONNREFUSED/);
    assert.ok(logs[0].meta?.stack, 'first (degraded entry) includes stack');
    assert.equal(logs[0].meta?.suppressed, undefined);

    // 100 rapid errors within the window — no extra logs
    for (let i = 0; i < 100; i += 1) {
      t += 100;
      guard.onError(err);
    }
    assert.equal(logs.length, 1, 'must not flood during long outage window');
    assert.equal(guard.getSnapshot().suppressedCount, 100);

    // Interval elapses → one summary log with suppressed count
    t += 30_000;
    guard.onError(err);
    assert.equal(logs.length, 2);
    assert.equal(logs[1].meta?.suppressed, 100);
    assert.equal(logs[1].meta?.stack, undefined, 'repeat log omits stack');

    // More noise suppressed again
    for (let i = 0; i < 5; i += 1) {
      t += 10;
      guard.onError(err);
    }
    assert.equal(logs.length, 2);
  });

  it('recovery logs once then allows a fresh first error log', () => {
    let t = 0;
    /** @type {string[]} */
    const messages = [];
    const guard = createConnectionErrorGuard({
      role: 'bullmq-worker',
      minIntervalMs: 10_000,
      now: () => t,
      log: (_level, message) => {
        messages.push(message);
      },
    });

    const err = Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
    guard.onError(err);
    assert.equal(messages.length, 1);

    t += 50;
    guard.onError(err);
    assert.equal(messages.length, 1);

    guard.onReady();
    assert.equal(messages.length, 2);
    assert.match(messages[1], /restored/);
    assert.match(messages[1], /suppressed_during_outage=1/);

    // Redundant ready while healthy — silent
    guard.onReady();
    assert.equal(messages.length, 2);

    // New outage after recovery — first error logs again
    t += 1;
    guard.onError(err);
    assert.equal(messages.length, 3);
    assert.match(messages[2], /connection error/);
  });

  it('category changes cannot bypass the per-connection interval', () => {
    let t = 0;
    const logs = [];
    const guard = createConnectionErrorGuard({
      role: 'r',
      minIntervalMs: 60_000,
      now: () => t,
      log: (level, message, meta) => logs.push({ level, message, meta }),
    });

    guard.onError(Object.assign(new Error('a'), { code: 'ECONNREFUSED' }));
    t += 100;
    guard.onError(Object.assign(new Error('b'), { code: 'ETIMEDOUT' }));
    assert.equal(logs.length, 1);
    assert.equal(guard.getSnapshot().suppressedCount, 1);
    assert.equal(guard.getSnapshot().lastCategory, 'ETIMEDOUT');

    t += 60_000;
    guard.onError(Object.assign(new Error('b'), { code: 'ETIMEDOUT' }));
    assert.equal(logs.length, 2);
    assert.equal(logs[1].meta?.category, 'ETIMEDOUT');
    assert.equal(logs[1].meta?.suppressed, 1);
  });

  it('dispose silences further logs', () => {
    const logs = [];
    const guard = createConnectionErrorGuard({
      log: (level, message) => logs.push(message),
    });
    guard.onError(new Error('x'));
    assert.equal(logs.length, 1);
    guard.dispose();
    guard.onError(new Error('y'));
    guard.onReady();
    assert.equal(logs.length, 1);
  });
});

describe('attachRedisConnectionErrorGuard', () => {
  it('handles error events and is idempotent (no double listeners)', () => {
    const ee = new EventEmitter();
    /** @type {string[]} */
    const logs = [];
    let t = 0;
    const d1 = attachRedisConnectionErrorGuard(ee, {
      role: 'agent-redis',
      minIntervalMs: 30_000,
      now: () => t,
      log: (_l, m) => logs.push(m),
    });
    assert.ok(typeof d1 === 'function');
    assert.equal(hasRedisConnectionErrorGuard(ee), true);
    assert.equal(ee.listenerCount('error'), 1);
    assert.equal(ee.listenerCount('ready'), 1);

    const d2 = attachRedisConnectionErrorGuard(ee, {
      role: 'agent-redis',
      log: () => {
        throw new Error('must not attach twice');
      },
    });
    assert.equal(d2, null, 'second attach is no-op');
    assert.equal(ee.listenerCount('error'), 1);

    ee.emit('error', Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    assert.equal(logs.length, 1);

    // Flood
    for (let i = 0; i < 50; i += 1) {
      t += 10;
      ee.emit('error', Object.assign(new Error('down'), { code: 'ECONNREFUSED' }));
    }
    assert.equal(logs.length, 1);

    ee.emit('ready');
    assert.equal(logs.length, 2);
    assert.match(logs[1], /restored/);

    d1();
    // ready removed; error listener retained as silent sink (no unhandled events)
    assert.equal(ee.listenerCount('ready'), 0);
    assert.equal(ee.listenerCount('error'), 1);
    assert.equal(hasRedisConnectionErrorGuard(ee), false);

    // After dispose, errors are swallowed (no throw, no log)
    ee.emit('error', new Error('ignored'));
    assert.equal(logs.length, 2);
  });

  it('destroyRedisClient runs cleanup; error remains handled', async () => {
    const ee = new EventEmitter();
    // Minimal quit for destroy path
    /** @type {any} */
    const client = ee;
    client.quit = async () => {};

    let cleaned = false;
    attachRedisConnectionErrorGuard(client, {
      role: 'x',
      log: () => {},
    });
    assert.equal(typeof client[REDIS_ERROR_GUARD_CLEANUP], 'function');
    const orig = client[REDIS_ERROR_GUARD_CLEANUP];
    client[REDIS_ERROR_GUARD_CLEANUP] = () => {
      cleaned = true;
      orig();
    };

    await destroyRedisClient(client);
    assert.equal(cleaned, true);
    assert.equal(client.listenerCount('ready'), 0);
    // Silent error sink remains — emit must not throw as unhandled
    client.emit('error', new Error('post-destroy'));
    // Second destroy is no-op
    await destroyRedisClient(client);
  });
});

describe('GuardedRedis duplicate coverage', () => {
  it('overrides ioredis-style duplicate so BullMQ clones retain the guard', () => {
    class FakeRedis extends EventEmitter {
      constructor(arg1, arg2) {
        super();
        this.options =
          arg1 && typeof arg1 === 'object'
            ? { ...arg1 }
            : { url: arg1, ...(arg2 || {}) };
      }

      // Mirrors ioredis 5.x: the base implementation discards subclasses.
      duplicate(override) {
        return new FakeRedis({ ...this.options, ...(override || {}) });
      }
    }

    const logs = [];
    const GuardedRedis = createGuardedRedisClass(FakeRedis, {
      role: 'bullmq-worker',
      log: (_level, message) => logs.push(message),
    });
    const primary = new GuardedRedis('redis://example.invalid', {
      db: 0,
    });
    const clone = primary.duplicate({ db: 1 });

    assert.ok(clone instanceof GuardedRedis);
    assert.equal(clone.options.db, 1);
    assert.equal(hasRedisConnectionErrorGuard(primary), true);
    assert.equal(hasRedisConnectionErrorGuard(clone), true);

    clone.emit(
      'error',
      Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0], /bullmq-worker/);
  });
});
