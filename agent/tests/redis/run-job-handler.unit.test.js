/**
 * Run 作业处理外壳：消费者暂停期间拿到的作业不执行、放回 delayed（不计失败）；未暂停时照常执行。
 *
 * 回归背景：`worker.pause(true)` 不打断在途的阻塞取任务。2026-09-15 开发栈实测，MySQL 不可用、
 * 消费者已暂停时入队的作业仍被立即执行并以 `needs reconciliation` 失败。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRunJobHandler } from '../../src/infrastructure/redis/run-queue.js';

class DelayedError extends Error {
  constructor(message = 'bullmq:movedToDelayed') {
    super(message);
    this.name = 'DelayedError';
  }
}

const REF = {
  runId: '01JQ5RBE789455474000000000',
  orgId: '01JQ5RBEXTESTTESTTESTTESTA',
  traceId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
};

function fakeJob(data = REF) {
  const moves = [];
  return {
    data,
    moves,
    async moveToDelayed(timestamp, token) {
      moves.push({ timestamp, token });
    },
  };
}

describe('createRunJobHandler', () => {
  it('defers a job fetched while the consumer is paused instead of running it', async () => {
    let processed = 0;
    const handler = createRunJobHandler(async () => { processed += 1; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldDefer: () => true,
      deferDelayMs: 5000,
      now: () => 1_000_000,
    });
    const job = fakeJob();
    await assert.rejects(() => handler(job, 'worker-1:7'), (err) => err instanceof DelayedError);
    assert.equal(processed, 0, 'processor must not run while paused');
    assert.deepEqual(job.moves, [{ timestamp: 1_005_000, token: 'worker-1:7' }]);
  });

  it('runs the processor with the validated ref when not paused', async () => {
    const seen = [];
    const handler = createRunJobHandler(async (ref, job) => { seen.push([ref, job]); return 'done'; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldDefer: () => false,
    });
    const job = fakeJob({ ...REF });
    assert.equal(await handler(job, 'worker-1:8'), 'done');
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].runId, REF.runId);
    assert.equal(job.moves.length, 0);
  });

  it('runs normally when no defer predicate is configured', async () => {
    let processed = 0;
    const handler = createRunJobHandler(async () => { processed += 1; }, { queueName: 'agent-runs', DelayedError });
    await handler(fakeJob(), 't');
    assert.equal(processed, 1);
  });

  it('rejects an invalid job reference before deciding to defer', async () => {
    const handler = createRunJobHandler(async () => {}, {
      queueName: 'agent-runs',
      DelayedError,
      shouldDefer: () => true,
    });
    const job = fakeJob({ runId: 'not-a-ulid', orgId: REF.orgId, traceId: REF.traceId });
    await assert.rejects(() => handler(job, 't'), /runId must be a 26-character Crockford ULID/);
    assert.equal(job.moves.length, 0);
  });

  it('propagates a failure to move the job back instead of running it', async () => {
    let processed = 0;
    const handler = createRunJobHandler(async () => { processed += 1; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldDefer: () => true,
    });
    const job = fakeJob();
    job.moveToDelayed = async () => { throw new Error('Connection is closed.'); };
    await assert.rejects(() => handler(job, 't'), /Connection is closed/);
    assert.equal(processed, 0);
  });

  // 同一会话前一个 Run 还没结束时，follow-up 排在后面执行，而不是以 `session lock busy` 失败（plan §12）。
  it('delays a job that must wait for an earlier run of its session, without running it', async () => {
    let processed = 0;
    const asked = [];
    const handler = createRunJobHandler(async () => { processed += 1; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldDefer: () => false,
      shouldWait: async (ref) => { asked.push(ref.runId); return true; },
      waitDelayMs: 2000,
      now: () => 1_000_000,
    });
    const job = fakeJob();
    await assert.rejects(() => handler(job, 'worker-1:9'), (err) => err instanceof DelayedError);
    assert.equal(processed, 0);
    assert.deepEqual(asked, [REF.runId]);
    assert.deepEqual(job.moves, [{ timestamp: 1_002_000, token: 'worker-1:9' }]);
  });

  it('runs the job once its session is free', async () => {
    let processed = 0;
    const handler = createRunJobHandler(async () => { processed += 1; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldWait: async () => false,
    });
    const job = fakeJob();
    await handler(job, 't');
    assert.equal(processed, 1);
    assert.equal(job.moves.length, 0);
  });

  it('keeps the job queued when the wait check itself fails', async () => {
    let processed = 0;
    const handler = createRunJobHandler(async () => { processed += 1; }, {
      queueName: 'agent-runs',
      DelayedError,
      shouldWait: async () => { throw new Error('mysql down'); },
      waitDelayMs: 2000,
      now: () => 5_000,
    });
    const job = fakeJob();
    await assert.rejects(() => handler(job, 't'), (err) => err instanceof DelayedError);
    assert.equal(processed, 0);
    assert.deepEqual(job.moves, [{ timestamp: 7_000, token: 't' }]);
  });
});
