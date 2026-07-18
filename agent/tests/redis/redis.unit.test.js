/**
 * Offline Redis coordination unit tests (PR-03 slice A).
 * Uses injected fake redis — no ioredis/bullmq install required.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeRedis, createFakeRedisState } from './fake-redis.js';
import {
  assertRedisConnectionUrl,
  describeRejectedRedisUrl,
  destroyRedisClient,
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  RUN_STREAM_MAXLEN,
  CANCEL_SIGNAL_TTL_MS,
  AGENT_RUNS_QUEUE_NAME,
  OUTBOX_WAKEUP_KEY,
  RUN_JOB_REF_FIELDS,
  RUN_STREAM_PAYLOAD_MAX_BYTES,
  OWNER_TOKEN_MAX_LEN,
  EVENT_TYPE_MAX_LEN,
  runLeaseKey,
  runCancelKey,
  runStreamKey,
  RedisConfigError,
  RedisValidationError,
  LeaseError,
  LeaseManager,
  RENEW_LUA,
  RELEASE_LUA,
  RunEventStream,
  validateRunStreamEvent,
  CancelSignal,
  assertRunJobRef,
} from '../../src/infrastructure/redis/index.js';

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const RUN2 = '01K0G2PAV8FPMVC9QHJG7JPN54';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const EVT1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const EVT2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const EVT3 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const TRACE = 'a'.repeat(32);
const WORKER_A = 'worker-a-token';
const WORKER_B = 'worker-b-token';
const CREATED = '2026-07-18T00:00:00.000Z';

function streamEvent(overrides = {}) {
  return {
    eventId: EVT1,
    sequence: 1,
    type: 'run.started',
    payload: { ok: true },
    createdAt: CREATED,
    ...overrides,
  };
}

describe('redis client config (no driver required)', () => {
  it('accepts only redis:// and rediss:// with non-empty hostname', () => {
    assert.equal(
      assertRedisConnectionUrl('redis://u:p@127.0.0.1:6379/0'),
      'redis://u:p@127.0.0.1:6379/0',
    );
    assert.match(
      assertRedisConnectionUrl('rediss://u:p@example.com:6380/1'),
      /^rediss:\/\//,
    );
    // Explicit redis://localhost is allowed (not a silent fallback).
    assert.equal(
      assertRedisConnectionUrl('redis://localhost:6379/0'),
      'redis://localhost:6379/0',
    );
  });

  it('rejects empty, malformed, empty-host, whitespace, control, unsupported schemes', () => {
    const cases = [
      '',
      '   ',
      null,
      undefined,
      'memory://',
      'mem://local',
      'unix:///var/run/redis.sock',
      'localhost:6379',
      '127.0.0.1:6379',
      'http://example.com/redis',
      'admin:SuperSecretPassw0rd@redis.example.com:6379',
      'redis://',
      'redis://:password@',
      'redis://:password@/',
      'redis:///var/run/redis.sock',
      'redis:// user@host:6379',
      'redis://host:6379/0 with space',
      'redis://host:6379/0\n',
      'rediss+cluster://example.com:6379',
    ];
    for (const url of cases) {
      assert.throws(
        () => assertRedisConnectionUrl(/** @type {any} */ (url)),
        RedisConfigError,
        `expected reject: ${String(url)}`,
      );
    }
  });

  it('error messages never echo full DSN or credentials', () => {
    const secret = 'redis://admin:SuperSecretPassw0rd@db.example.com:6379/0';
    const bare = 'admin:SuperSecretPassw0rd@db.example.com:6379';
    const badScheme = secret.replace('redis://', 'rediss+cluster://');
    for (const url of [badScheme, bare, 'memory://x', 'redis://:SuperSecretPassw0rd@']) {
      try {
        assertRedisConnectionUrl(url);
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof RedisConfigError);
        const msg = String(err.message);
        assert.doesNotMatch(msg, /SuperSecretPassw0rd/);
        assert.doesNotMatch(msg, /admin:/);
        assert.equal(msg.includes(url), false, 'must not echo full rejected DSN');
      }
    }
  });

  it('describeRejectedRedisUrl classifies schemes without credentials', () => {
    assert.equal(describeRejectedRedisUrl('memory://x'), 'scheme=memory');
    assert.equal(describeRejectedRedisUrl('user:pass@host'), 'scheme=user');
    assert.equal(describeRejectedRedisUrl('not-a-url-at-all'), 'bare-string');
    assert.equal(describeRejectedRedisUrl('token@redis-host'), 'bare-credential-string');
  });

  it('destroyRedisClient is at-most-once even when quit throws and status never updates', async () => {
    await destroyRedisClient(null);
    await destroyRedisClient(undefined);

    let quitCount = 0;
    let disconnectCount = 0;
    const sticky = {
      status: 'ready',
      async quit() {
        quitCount += 1;
        throw new Error('quit failed');
      },
      disconnect() {
        disconnectCount += 1;
        // status intentionally stays "ready"
      },
    };

    await destroyRedisClient(sticky);
    assert.equal(quitCount, 1);
    assert.equal(disconnectCount, 1);

    await destroyRedisClient(sticky);
    await destroyRedisClient(sticky);
    assert.equal(quitCount, 1, 'quit must not run again');
    assert.equal(disconnectCount, 1, 'disconnect must not run again');
  });

  it('destroyRedisClient counts single successful quit and later no-ops', async () => {
    let quitCount = 0;
    let disconnectCount = 0;
    const client = {
      status: 'ready',
      async quit() {
        quitCount += 1;
        this.status = 'end';
      },
      disconnect() {
        disconnectCount += 1;
      },
    };
    await destroyRedisClient(client);
    await destroyRedisClient(client);
    assert.equal(quitCount, 1);
    assert.equal(disconnectCount, 0);
  });

  it('destroyRedisClient is idempotent on fake redis', async () => {
    const state = createFakeRedisState();
    const client = createFakeRedis(state);
    await destroyRedisClient(client);
    assert.equal(state.destroyed, true);
    assert.equal(state.status, 'end');
    await destroyRedisClient(client);
  });
});

describe('canonical keys and constants', () => {
  it('matches plan §9 key shapes and coordination numbers', () => {
    assert.equal(runLeaseKey(RUN), `run:lease:${RUN}`);
    assert.equal(runCancelKey(RUN), `run:cancel:${RUN}`);
    assert.equal(runStreamKey(RUN), `run:stream:${RUN}`);
    assert.equal(OUTBOX_WAKEUP_KEY, 'outbox:wakeup');
    assert.equal(AGENT_RUNS_QUEUE_NAME, 'agent-runs');
    assert.equal(LEASE_TTL_MS, 30_000);
    assert.equal(LEASE_RENEW_INTERVAL_MS, 10_000);
    assert.equal(RUN_STREAM_MAXLEN, 10_000);
    assert.ok(CANCEL_SIGNAL_TTL_MS > 0);
    assert.equal(RUN_STREAM_PAYLOAD_MAX_BYTES, 65_536);
    assert.equal(OWNER_TOKEN_MAX_LEN, 255);
    assert.equal(EVENT_TYPE_MAX_LEN, 128);
    assert.deepEqual([...RUN_JOB_REF_FIELDS], ['runId', 'orgId', 'traceId']);
  });

  it('key builders reject namespace-like and non-ULID ids', () => {
    const bad = [
      'run:evil',
      'missing-run',
      '../escape',
      '01SHORT',
      'I'.repeat(26), // I not in Crockford
      'a'.repeat(25),
      '',
    ];
    for (const id of bad) {
      assert.throws(() => runLeaseKey(id), RedisValidationError);
      assert.throws(() => runCancelKey(id), RedisValidationError);
      assert.throws(() => runStreamKey(id), RedisValidationError);
    }
  });
});

describe('LeaseManager', () => {
  /** @type {ReturnType<typeof createFakeRedisState>} */
  let state;
  /** @type {ReturnType<typeof createFakeRedis>} */
  let redis;
  /** @type {LeaseManager} */
  let leases;

  beforeEach(() => {
    state = createFakeRedisState();
    redis = createFakeRedis(state);
    leases = new LeaseManager(redis);
  });

  it('acquires with SET NX PX and stores owner token', async () => {
    const ok = await leases.acquire(RUN, WORKER_A);
    assert.equal(ok, true);
    assert.equal(await leases.getOwner(RUN), WORKER_A);
    const setCall = state.calls.find((c) => c.cmd === 'set');
    assert.ok(setCall);
    assert.ok(setCall.args.includes('NX'));
    assert.ok(setCall.args.includes('PX'));
    assert.ok(setCall.args.includes(LEASE_TTL_MS));
  });

  it('second acquirer fails while lease held', async () => {
    assert.equal(await leases.acquire(RUN, WORKER_A), true);
    assert.equal(await leases.acquire(RUN, WORKER_B), false);
    assert.equal(await leases.getOwner(RUN), WORKER_A);
  });

  it('renew succeeds only for owner; wrong owner cannot renew', async () => {
    await leases.acquire(RUN, WORKER_A);
    assert.equal(await leases.renew(RUN, WORKER_A), true);
    assert.equal(await leases.renew(RUN, WORKER_B), false);
    assert.equal(await leases.getOwner(RUN), WORKER_A);
    assert.ok(RENEW_LUA.includes('GET'));
    assert.ok(RENEW_LUA.includes('PEXPIRE'));
  });

  it('release succeeds only for owner; wrong owner cannot release', async () => {
    await leases.acquire(RUN, WORKER_A);
    assert.equal(await leases.release(RUN, WORKER_B), false);
    assert.equal(await leases.getOwner(RUN), WORKER_A);
    assert.equal(await leases.release(RUN, WORKER_A), true);
    assert.equal(await leases.getOwner(RUN), null);
    assert.ok(RELEASE_LUA.includes('DEL'));
  });

  it('acquireOrThrow raises LeaseError without touching Run status concepts', async () => {
    await leases.acquire(RUN, WORKER_A);
    await assert.rejects(() => leases.acquireOrThrow(RUN, WORKER_B), LeaseError);
  });

  it('rejects empty / invalid runId and ownerToken', async () => {
    await assert.rejects(() => leases.acquire('', WORKER_A), RedisValidationError);
    await assert.rejects(() => leases.acquire('run:evil', WORKER_A), RedisValidationError);
    await assert.rejects(() => leases.acquire(RUN, ''), RedisValidationError);
    await assert.rejects(
      () => leases.acquire(RUN, 'x'.repeat(OWNER_TOKEN_MAX_LEN + 1)),
      RedisValidationError,
    );
  });

  it('missing lease is null — not a Run status', async () => {
    assert.equal(await leases.getOwner(RUN), null);
  });
});

describe('RunEventStream', () => {
  /** @type {ReturnType<typeof createFakeRedis>} */
  let redis;
  /** @type {RunEventStream} */
  let stream;

  beforeEach(() => {
    redis = createFakeRedis();
    stream = new RunEventStream(redis);
  });

  it('validates event fields with plan contracts', () => {
    assert.throws(() => validateRunStreamEvent(null), RedisValidationError);
    assert.throws(
      () => validateRunStreamEvent(streamEvent({ createdAt: undefined })),
      RedisValidationError,
    );
    assert.throws(
      () => validateRunStreamEvent(streamEvent({ sequence: 'nope' })),
      RedisValidationError,
    );
    assert.throws(
      () => validateRunStreamEvent(streamEvent({ eventId: 'e1' })),
      RedisValidationError,
    );
    assert.throws(
      () => validateRunStreamEvent(streamEvent({ createdAt: '2026-07-18T00:00:00+00:00' })),
      RedisValidationError,
    );
    assert.throws(
      () => validateRunStreamEvent(streamEvent({ type: 'x'.repeat(EVENT_TYPE_MAX_LEN + 1) })),
      RedisValidationError,
    );
    assert.throws(
      () =>
        validateRunStreamEvent(
          streamEvent({ payload: 'x'.repeat(RUN_STREAM_PAYLOAD_MAX_BYTES + 1) }),
        ),
      RedisValidationError,
    );

    const ok = validateRunStreamEvent(
      streamEvent({
        eventId: EVT1,
        sequence: 18,
        type: 'tool.execution.started',
        payload: { tool: 'bash' },
      }),
    );
    assert.equal(ok.sequence, '18');
    assert.equal(ok.payload, '{"tool":"bash"}');
    assert.equal(ok.eventId, EVT1);
  });

  it('appends with MAXLEN ~ and reads via range', async () => {
    const sid = await stream.append(RUN, streamEvent({ eventId: EVT1, sequence: 1 }));
    assert.ok(sid);

    const rows = await stream.range(RUN);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].eventId, EVT1);
    assert.equal(rows[0].sequence, '1');
    assert.equal(rows[0].type, 'run.started');
    assert.match(rows[0].payload, /ok/);

    const tiny = new RunEventStream(redis, { maxLen: 2 });
    await tiny.append(RUN, streamEvent({ eventId: EVT2, sequence: 2, type: 't2' }));
    await tiny.append(RUN, streamEvent({ eventId: EVT3, sequence: 3, type: 't3' }));
    const len = await tiny.length(RUN);
    assert.ok(len <= 2);
  });

  it('empty / missing stream is empty array — never a status interpretation', async () => {
    const rows = await stream.range(RUN2);
    assert.deepEqual(rows, []);
    assert.equal(await stream.length(RUN2), 0);
  });

  it('rejects namespace-like runId on append/range', async () => {
    await assert.rejects(
      () => stream.append('run:evil', streamEvent()),
      RedisValidationError,
    );
    await assert.rejects(() => stream.range('missing-run'), RedisValidationError);
  });

  it('readAfter returns only newer entries', async () => {
    const id1 = await stream.append(RUN, streamEvent({ eventId: EVT1, sequence: 1, type: 'a' }));
    await stream.append(RUN, streamEvent({ eventId: EVT2, sequence: 2, type: 'b' }));
    const after = await stream.readAfter(RUN, { afterId: id1 });
    assert.equal(after.length, 1);
    assert.equal(after[0].eventId, EVT2);
  });
});

describe('CancelSignal', () => {
  /** @type {ReturnType<typeof createFakeRedis>} */
  let redis;
  /** @type {CancelSignal} */
  let cancel;

  beforeEach(() => {
    redis = createFakeRedis();
    cancel = new CancelSignal(redis);
  });

  it('request / isRequested / clear with TTL', async () => {
    assert.equal(await cancel.isRequested(RUN), false);
    await cancel.request(RUN, { reason: 'user', requestedBy: 'u1' });
    assert.equal(await cancel.isRequested(RUN), true);
    const raw = await redis.get(runCancelKey(RUN));
    assert.ok(raw);
    assert.match(raw, /user/);
    assert.equal(await cancel.clear(RUN), true);
    assert.equal(await cancel.isRequested(RUN), false);
    assert.equal(await cancel.clear(RUN), false);
  });

  it('rejects non-ULID runId', async () => {
    await assert.rejects(() => cancel.request('run:evil'), RedisValidationError);
    await assert.rejects(() => cancel.isRequested('../x'), RedisValidationError);
  });

  it('is signal-only — no MySQL hooks on the class', () => {
    const proto = Object.getOwnPropertyNames(CancelSignal.prototype);
    assert.ok(proto.includes('request'));
    assert.ok(proto.includes('isRequested'));
    assert.ok(proto.includes('clear'));
    assert.equal(proto.includes('updateRun'), false);
    assert.equal(proto.includes('transition'), false);
  });
});

describe('assertRunJobRef (BullMQ payload)', () => {
  it('accepts pure reference payload and normalizes ids', () => {
    assert.deepEqual(assertRunJobRef({ runId: RUN, orgId: ORG, traceId: TRACE }), {
      runId: RUN,
      orgId: ORG,
      traceId: TRACE,
    });
    // uppercase hex trace → lowercase
    const mixed = assertRunJobRef({
      runId: RUN.toLowerCase(),
      orgId: ORG.toLowerCase(),
      traceId: 'A'.repeat(32),
    });
    assert.equal(mixed.runId, RUN);
    assert.equal(mixed.orgId, ORG);
    assert.equal(mixed.traceId, 'a'.repeat(32));
  });

  it('rejects extra / full payload fields', () => {
    assert.throws(
      () =>
        assertRunJobRef({
          runId: RUN,
          orgId: ORG,
          traceId: TRACE,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      RedisValidationError,
    );
    assert.throws(
      () => assertRunJobRef({ runId: RUN, orgId: ORG, traceId: TRACE, dataset: 'blob' }),
      RedisValidationError,
    );
  });

  it('rejects missing fields and invalid plan IDs', () => {
    assert.throws(() => assertRunJobRef({ runId: RUN, orgId: ORG }), RedisValidationError);
    assert.throws(() => assertRunJobRef({}), RedisValidationError);
    assert.throws(() => assertRunJobRef(null), RedisValidationError);
    assert.throws(
      () => assertRunJobRef({ runId: 'run:evil', orgId: ORG, traceId: TRACE }),
      RedisValidationError,
    );
    assert.throws(
      () => assertRunJobRef({ runId: RUN, orgId: ORG, traceId: '0'.repeat(32) }),
      RedisValidationError,
    );
    assert.throws(
      () => assertRunJobRef({ runId: RUN, orgId: ORG, traceId: 'not-hex' }),
      RedisValidationError,
    );
  });

  it('jobId is deterministic runId (documented by enqueue contract)', () => {
    const ref = assertRunJobRef({ runId: RUN, orgId: ORG, traceId: TRACE });
    assert.equal(ref.runId, RUN);
    const jobId = ref.runId;
    assert.equal(jobId, RUN);
  });
});
