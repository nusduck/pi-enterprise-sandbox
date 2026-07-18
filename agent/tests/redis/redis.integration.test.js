/**
 * Live Redis integration tests (PR-03 slice A).
 *
 * Gated: set TEST_REDIS_URL=redis://… or rediss://…
 * Requires: ioredis (+ bullmq for queue cases) installed (see agent/package.json).
 *
 * Skips cleanly when URL or deps are absent — offline CI remains green.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_URL = process.env.TEST_REDIS_URL || '';
const runIntegration = Boolean(TEST_URL.trim());
const require = createRequire(import.meta.url);

function depsAvailable() {
  try {
    require.resolve('ioredis');
    return true;
  } catch {
    return false;
  }
}

function bullmqAvailable() {
  try {
    require.resolve('bullmq');
    return true;
  } catch {
    return false;
  }
}

const hasDeps = depsAvailable();
const describeRedis = runIntegration && hasDeps ? describe : describe.skip;

// Valid Crockford ULIDs (26 chars)
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const EVT = '01K0G2PAV8FPMVC9QHJG7JPN58';
const TRACE = 'c'.repeat(32);
const WORKER = 'integration-worker-1';

describe('redis integration gate', () => {
  it('documents skip conditions when URL or deps missing', () => {
    if (!runIntegration) {
      assert.ok(true, 'skipped: TEST_REDIS_URL unset');
      return;
    }
    if (!hasDeps) {
      assert.ok(true, 'skipped: ioredis not installed (npm install pending lock update)');
      return;
    }
    assert.ok(true, 'integration enabled');
  });
});

describeRedis('redis live coordination', () => {
  /** @type {import('../../src/infrastructure/redis/index.js')} */
  let redisMod;
  /** @type {import('ioredis').default} */
  let client;

  before(async () => {
    redisMod = await import('../../src/infrastructure/redis/index.js');
    redisMod.assertRedisConnectionUrl(TEST_URL);
    client = redisMod.createRedisClient(TEST_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await client.connect();
    await client.del(
      redisMod.runLeaseKey(RUN),
      redisMod.runCancelKey(RUN),
      redisMod.runStreamKey(RUN),
    );
  });

  after(async () => {
    if (client) {
      try {
        await client.del(
          redisMod.runLeaseKey(RUN),
          redisMod.runCancelKey(RUN),
          redisMod.runStreamKey(RUN),
        );
      } catch {
        // ignore
      }
      await redisMod.destroyRedisClient(client);
      await redisMod.destroyRedisClient(client);
    }
  });

  it('lease acquire / wrong-owner renew-release / owner release', async () => {
    const leases = new redisMod.LeaseManager(client);
    assert.equal(await leases.acquire(RUN, WORKER), true);
    assert.equal(await leases.acquire(RUN, 'other'), false);
    assert.equal(await leases.renew(RUN, 'other'), false);
    assert.equal(await leases.renew(RUN, WORKER), true);
    assert.equal(await leases.release(RUN, 'other'), false);
    assert.equal(await leases.release(RUN, WORKER), true);
    assert.equal(await leases.getOwner(RUN), null);
  });

  it('stream append + range + cancel signal', async () => {
    const stream = new redisMod.RunEventStream(client);
    const cancel = new redisMod.CancelSignal(client, { ttlMs: 60_000 });

    const sid = await stream.append(RUN, {
      eventId: EVT,
      sequence: 1,
      type: 'run.started',
      payload: { source: 'integration' },
      createdAt: new Date().toISOString(),
    });
    assert.ok(sid);
    const rows = await stream.range(RUN);
    assert.ok(rows.length >= 1);
    assert.equal(rows[rows.length - 1].type, 'run.started');

    assert.equal(await cancel.isRequested(RUN), false);
    await cancel.request(RUN, { reason: 'test' });
    assert.equal(await cancel.isRequested(RUN), true);
    await cancel.clear(RUN);
    assert.equal(await cancel.isRequested(RUN), false);
  });

  it('bullmq enqueue reference job when bullmq installed', async (t) => {
    if (!bullmqAvailable()) {
      t.skip('bullmq not installed — skip queue live test');
      return;
    }

    const handles = redisMod.createRunQueue(TEST_URL);
    try {
      const job = await redisMod.enqueueRunJob(handles.queue, {
        runId: RUN,
        orgId: ORG,
        traceId: TRACE,
      });
      assert.equal(job.id, RUN);
      assert.deepEqual(job.data, { runId: RUN, orgId: ORG, traceId: TRACE });
      await job.remove();
    } finally {
      await redisMod.destroyRunQueue(handles);
    }
  });
});
