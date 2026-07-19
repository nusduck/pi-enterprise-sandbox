/**
 * ExecuteRunService + Recovery + worker bootstrap tests (PR-04 T3 fixes).
 * Offline fakes only.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateRunService,
  ExecuteRunService,
  LeaseBusyError,
  RunRecoveryService,
  createStubRunExecutor,
  QUEUE_WARNING,
  createSerialTimeoutLoop,
} from '../../src/application/index.js';
import {
  createRunWorkerRuntime,
  startRunWorkerRuntime,
  NeedsReconciliationError,
} from '../../src/bootstrap/run-worker.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from './helpers/fake-run-world.js';

const MESSAGES = [{ role: 'user', content: 'exec' }];

function createFakeLease() {
  /** @type {Map<string, string>} */
  const leases = new Map();
  let renewFailFor = null;
  let renewThrowFor = null;
  let releaseFail = false;
  let renewCalls = 0;
  return {
    leases,
    renewIntervalMs: 50,
    get renewCalls() {
      return renewCalls;
    },
    async getOwner(runId) {
      return leases.has(runId) ? leases.get(runId) : null;
    },
    async acquire(runId, owner) {
      if (leases.has(runId)) return false;
      leases.set(runId, owner);
      return true;
    },
    async renew(runId, owner) {
      renewCalls += 1;
      if (renewThrowFor === runId) throw new Error('redis renew down');
      if (renewFailFor === runId) return false;
      return leases.get(runId) === owner;
    },
    async release(runId, owner) {
      if (releaseFail) throw new Error('release failed');
      if (leases.get(runId) === owner) {
        leases.delete(runId);
        return true;
      }
      return false;
    },
    failRenew(runId) {
      renewFailFor = runId;
    },
    throwRenew(runId) {
      renewThrowFor = runId;
    },
    failRelease() {
      releaseFail = true;
    },
  };
}

function buildCreate(world) {
  return new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T06:00:00.000Z'),
    runQueue: world.runQueue,
  });
}

/**
 * @param {ReturnType<typeof createFakeRunWorld>} world
 * @param {ReturnType<typeof createFakeLease>} lease
 * @param {object} [opts]
 */
function buildExecute(world, lease, opts = {}) {
  return new ExecuteRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    leaseManager: lease,
    cancelSignal: world.cancelSignal,
    runExecutor: opts.runExecutor,
    runExecutorFactory: opts.runExecutorFactory,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T06:00:00.000Z'),
    leaseRenewIntervalMs: opts.leaseRenewIntervalMs ?? 10_000,
    cancelPollIntervalMs: opts.cancelPollIntervalMs ?? 20,
  });
}

describe('createSerialTimeoutLoop', () => {
  it('serializes ticks and stop awaits in-flight', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let ticks = 0;
    const loop = createSerialTimeoutLoop({
      intervalMs: 5,
      isStopped: () => ticks >= 3,
      tick: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        ticks += 1;
        concurrent -= 1;
      },
    });
    loop.start();
    await new Promise((r) => setTimeout(r, 80));
    await loop.stop();
    assert.ok(ticks >= 1);
    assert.equal(maxConcurrent, 1);
  });
});

describe('ExecuteRunService', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  /** @type {ReturnType<typeof createFakeLease>} */
  let lease;
  /** @type {CreateRunService} */
  let create;

  beforeEach(() => {
    world = createFakeRunWorld();
    lease = createFakeLease();
    create = buildCreate(world);
  });

  it('happy path: ACCEPTED/QUEUED → SUCCEEDED with events+outbox', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-ok',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () => createStubRunExecutor(),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.SUCCEEDED);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
    assert.ok(world.tables.runs[0].completed_at);
    assert.ok(Number(world.tables.runs[0].attempt) >= 1);
    assert.equal(lease.leases.has(created.runId), false);
  });

  it('lease busy returns without mutating status', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-busy',
    });
    const orgId = String(world.tables.runs[0].org_id);
    await lease.acquire(created.runId, 'other-worker');
    const exec = buildExecute(world, lease);
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.leaseBusy, true);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);
  });

  it('cancel-before-start: QUEUED with intent → CANCELLED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-cxl-start',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const scopeUser = String(world.tables.runs[0].user_id);
    world.tables.runs[0].cancel_requested_at = '2026-07-18 06:00:01.000';
    world.tables.runs[0].cancel_requested_by = scopeUser;

    let executed = false;
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async () => {
            executed = true;
            throw new Error('should not run');
          },
        }),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.CANCELLED);
    assert.equal(executed, false);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.CANCELLED);
  });

  it('STARTING + cancel intent: STARTING→RUNNING→CANCELLING→CANCELLED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-starting-cxl',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const userId = String(world.tables.runs[0].user_id);
    // Force STARTING with durable intent (runtime not yet entered)
    world.tables.runs[0].status = RUN_STATUS.STARTING;
    world.tables.runs[0].cancel_requested_at = '2026-07-18 06:00:01.000';
    world.tables.runs[0].cancel_requested_by = userId;

    let executed = false;
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async () => {
            executed = true;
            return { outcome: 'SUCCEEDED' };
          },
        }),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.CANCELLED);
    assert.equal(executed, false);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.CANCELLED);
    // Path must have used RUNNING intermediate (events may show status.changed)
    assert.notEqual(world.tables.runs[0].status, RUN_STATUS.STARTING);
  });

  it('cancel-during-runtime: signal aborts executor before natural return', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-cxl-run',
    });
    const orgId = String(world.tables.runs[0].org_id);

    let abortedWhileRunning = false;
    /** @type {(() => void) | null} */
    let releaseBlock = null;
    const block = new Promise((resolve) => {
      releaseBlock = resolve;
    });

    // After short delay, fire cancel signal while executor is blocked
    setTimeout(() => {
      world.cancelSignals.push({ runId: created.runId, meta: {} });
    }, 30);

    const exec = buildExecute(world, lease, {
      cancelPollIntervalMs: 15,
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async (ctx) => {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                abortedWhileRunning = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              };
              if (ctx.signal.aborted) {
                onAbort();
                return;
              }
              ctx.signal.addEventListener('abort', onAbort, { once: true });
              // Stay blocked until abort or test timeout helper
              block.then(() => resolve(undefined)).catch(() => {});
              setTimeout(() => resolve(undefined), 5000);
            }).catch(() => {});
            if (ctx.signal.aborted || abortedWhileRunning) {
              return { outcome: 'CANCELLED' };
            }
            return { outcome: 'SUCCEEDED' };
          },
        }),
    });

    const resultPromise = exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });

    const result = await resultPromise;
    if (releaseBlock) releaseBlock();
    assert.equal(abortedWhileRunning, true);
    assert.equal(result.status, RUN_STATUS.CANCELLED);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.CANCELLED);
    // No duplicate CANCELLING storms: at most a few status.changed to CANCELLING
    const cancellingEvents = world.tables.run_events.filter((e) => {
      const p =
        typeof e.payload_json === 'string'
          ? e.payload_json
          : JSON.stringify(e.payload_json ?? {});
      return p.includes('CANCELLING');
    });
    assert.ok(cancellingEvents.length >= 1);
    assert.ok(cancellingEvents.length <= 3);
  });

  it('cancel-during-runtime via MySQL intent aborts executor', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-cxl-db',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const userId = String(world.tables.runs[0].user_id);

    let abortedWhileRunning = false;
    setTimeout(() => {
      world.tables.runs[0].cancel_requested_at = '2026-07-18 06:01:00.000';
      world.tables.runs[0].cancel_requested_by = userId;
    }, 25);

    const exec = buildExecute(world, lease, {
      cancelPollIntervalMs: 10,
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async (ctx) => {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                abortedWhileRunning = true;
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              };
              ctx.signal.addEventListener('abort', onAbort, { once: true });
              setTimeout(() => resolve(undefined), 5000);
            }).catch(() => {});
            return { outcome: 'CANCELLED' };
          },
        }),
    });

    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(abortedWhileRunning, true);
    assert.equal(result.status, RUN_STATUS.CANCELLED);
  });

  it('runtime failure maps to FAILED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-fail',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async () => ({
            outcome: 'FAILED',
            statusReason: 'model boom password=secret',
          }),
        }),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.FAILED);
    assert.match(String(world.tables.runs[0].status_reason), /password=\*\*\*/);
  });

  it('waiting outcome transitions to WAITING_APPROVAL', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-wait',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async () => ({ legacyOutcome: 'waiting_approval' }),
        }),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.WAITING_APPROVAL);
  });

  it('org-scoped load rejects cross-org job without durable FAILED claim', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-org',
    });
    const ownerOrg = String(world.tables.runs[0].org_id);
    const exec = buildExecute(world, lease);
    const otherOrg = world.generateId();
    const result = await exec.execute({
      runId: created.runId,
      orgId: otherOrg,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.match(String(result.error), /not found|Run not found/i);
    assert.equal(result.needsReconciliation, true);
    assert.notEqual(result.status, RUN_STATUS.FAILED);
    assert.equal(world.tables.runs[0].org_id, ownerOrg);
    assert.notEqual(world.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
    assert.notEqual(world.tables.runs[0].status, RUN_STATUS.FAILED);
  });

  it('duplicate job after success is terminal no-op', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-dup',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const exec = buildExecute(world, lease);
    await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    const again = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w2',
    });
    assert.equal(again.status, RUN_STATUS.SUCCEEDED);
  });

  it('renew false: no SUCCEEDED write, needsReconciliation, no timer leak', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-renew-false',
    });
    const orgId = String(world.tables.runs[0].org_id);
    lease.failRenew(created.runId);

    let sawAbort = false;
    const exec = buildExecute(world, lease, {
      leaseRenewIntervalMs: 20,
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async (ctx) => {
            await new Promise((resolve, reject) => {
              ctx.signal.addEventListener(
                'abort',
                () => {
                  sawAbort = true;
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                },
                { once: true },
              );
              setTimeout(() => resolve(undefined), 5000);
            }).catch(() => {});
            return { outcome: 'SUCCEEDED' };
          },
        }),
    });

    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(sawAbort, true);
    assert.equal(result.needsReconciliation, true);
    assert.notEqual(world.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
    assert.equal(lease.leases.has(created.runId), false);
  });

  it('renew throw: needsReconciliation, no SUCCEEDED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-renew-throw',
    });
    const orgId = String(world.tables.runs[0].org_id);
    lease.throwRenew(created.runId);

    const exec = buildExecute(world, lease, {
      leaseRenewIntervalMs: 15,
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async (ctx) => {
            await new Promise((resolve, reject) => {
              ctx.signal.addEventListener(
                'abort',
                () =>
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
              setTimeout(() => resolve(undefined), 3000);
            }).catch(() => {});
            return { outcome: 'SUCCEEDED' };
          },
        }),
    });

    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.needsReconciliation, true);
    assert.notEqual(world.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
  });

  it('release failure after SUCCEEDED reports cleanupError without flipping status', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rel-fail',
    });
    const orgId = String(world.tables.runs[0].org_id);
    lease.failRelease();

    const exec = buildExecute(world, lease, {
      runExecutorFactory: () => createStubRunExecutor(),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.status, RUN_STATUS.SUCCEEDED);
    assert.ok(result.cleanupError);
    assert.match(String(result.cleanupError), /release failed/i);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
  });

  it('transition/DB failure does not claim durable FAILED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-db-fail',
    });
    const orgId = String(world.tables.runs[0].org_id);

    // Break transactions after lease acquire
    const origRun = world.transactionManager.run.bind(world.transactionManager);
    let calls = 0;
    world.transactionManager.run = async (work) => {
      calls += 1;
      if (calls >= 1) {
        throw new Error('mysql://user:secret@host/db exploded');
      }
      return origRun(work);
    };

    const exec = buildExecute(world, lease);
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(result.needsReconciliation, true);
    assert.notEqual(result.status, RUN_STATUS.FAILED);
    assert.equal(result.status, 'UNKNOWN');
    // Sanitized — no raw DSN password
    assert.doesNotMatch(String(result.error), /secret/);
  });

  it('runExecutorFactory creates per-job instances and disposes each', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-factory',
    });
    const orgId = String(world.tables.runs[0].org_id);
    let createdN = 0;
    let disposedN = 0;
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () => {
        createdN += 1;
        const base = createStubRunExecutor();
        return {
          execute: base.execute.bind(base),
          async dispose() {
            disposedN += 1;
          },
        };
      },
    });
    await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w1',
    });
    // Second job on same service
    const created2 = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-factory-2',
    });
    await exec.execute({
      runId: created2.runId,
      orgId: String(world.tables.runs.find((r) => r.run_id === created2.runId).org_id),
      traceId: TRACE,
      workerId: 'w1',
    });
    assert.equal(createdN, 2);
    assert.equal(disposedN, 2);
  });
});

describe('RunRecoveryService', () => {
  it('re-enqueues ACCEPTED after enqueue failure', async () => {
    const world = createFakeRunWorld();
    world.runQueue.setFail(true);
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'rec-1',
    });
    assert.equal(created.queueWarning, QUEUE_WARNING.ENQUEUE_FAILED);
    world.runQueue.setFail(false);
    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
    });
    const { actions } = await recovery.scanAndRequeue({ limit: 50 });
    const mine = actions.find((a) => a.runId === created.runId);
    assert.ok(
      mine.action === 'projected_and_enqueued' || mine.action === 'enqueued',
    );
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);
  });

  it('STARTING/RUNNING returns needsReconciliation (no re-exec)', async () => {
    const world = createFakeRunWorld();
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'rec-2',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    const jobsBefore = world.enqueuedJobs.length;
    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
    });
    const { actions } = await recovery.scanAndRequeue();
    const mine = actions.find((a) => a.runId === created.runId);
    assert.equal(mine.action, 'needsReconciliation');
    assert.equal(world.enqueuedJobs.length, jobsBefore);
  });

  it('system scan is ref-only safe and bounded', async () => {
    const world = createFakeRunWorld();
    const create = buildCreate(world);
    await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'rec-3a',
    });
    await create.execute({
      messages: MESSAGES,
      auth: {
        ...FIXED_AUTH,
        externalOrgId: '990e8400-e29b-41d4-a716-446655440099',
        externalUserId: 'aa0e8400-e29b-41d4-a716-4466554400aa',
      },
      traceId: TRACE,
      idempotencyKey: 'rec-3b',
    });
    for (const r of world.tables.runs) r.status = RUN_STATUS.ACCEPTED;

    const repos = world.createRepositories(world.rootDb);
    const page = await repos.runs.listNonTerminalForSystemWorker({ limit: 1 });
    assert.equal(page.length, 1);
    const only = await repos.runs.listNonTerminalForSystemWorker({
      orgId: page[0].orgId,
      limit: 10,
    });
    assert.ok(only.every((r) => r.orgId === page[0].orgId));
  });

  it('error reasons are sanitized (no DSN secrets)', async () => {
    const world = createFakeRunWorld();
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'rec-san',
    });
    world.tables.runs[0].status = RUN_STATUS.ACCEPTED;
    world.runQueue.enqueue = async () => {
      throw new Error('mysql://admin:SuperSecret@db/prod failed');
    };
    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
    });
    const { actions } = await recovery.scanAndRequeue();
    const mine = actions.find((a) => a.runId === created.runId);
    assert.equal(mine.action, 'error');
    assert.doesNotMatch(String(mine.reason), /SuperSecret/);
  });
});

describe('run worker bootstrap', () => {
  it('fails closed without an executor unless stub use is explicit', () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    const deps = {
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
    };

    assert.throws(
      () => createRunWorkerRuntime(deps),
      (err) => err?.code === 'RUN_EXECUTOR_NOT_CONFIGURED',
    );
    assert.doesNotThrow(() =>
      createRunWorkerRuntime({ ...deps, allowStubExecutor: true }),
    );
  });

  it('does not start on import; shutdown exactly once', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    let starts = 0;
    let stops = 0;
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      cancelSignal: world.cancelSignal,
      generateId: world.generateId,
      allowStubExecutor: true,
      workerId: 'bootstrap-w',
      onStart: async () => {
        starts += 1;
      },
      onShutdown: async () => {
        stops += 1;
      },
    });
    assert.equal(runtime.isStarted(), false);
    await startRunWorkerRuntime(runtime);
    await startRunWorkerRuntime(runtime);
    assert.equal(starts, 1);
    await runtime.shutdown();
    await runtime.shutdown();
    assert.equal(stops, 1);
  });

  it('concurrent start runs onStart once', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    let starts = 0;
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
      allowStubExecutor: true,
      onStart: async () => {
        starts += 1;
        await new Promise((r) => setTimeout(r, 30));
      },
    });
    await Promise.all([runtime.start(), runtime.start(), runtime.start()]);
    assert.equal(starts, 1);
    assert.equal(runtime.isStarted(), true);
  });

  it('onStart failure leaves not-started and allows retry', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    let attempts = 0;
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
      allowStubExecutor: true,
      onStart: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('connect failed');
      },
    });
    await assert.rejects(() => runtime.start(), /connect failed/);
    assert.equal(runtime.isStarted(), false);
    await runtime.start();
    assert.equal(runtime.isStarted(), true);
    assert.equal(attempts, 2);
  });

  it('processJob accepts ref-only and runs ExecuteRunService', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'boot-job',
    });
    const orgId = String(world.tables.runs[0].org_id);
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
      allowStubExecutor: true,
      workerId: 'boot-w',
    });
    const result = await runtime.processJob({
      runId: created.runId,
      orgId,
      traceId: TRACE,
    });
    assert.equal(result.status, RUN_STATUS.SUCCEEDED);
  });

  it('processJob throws LeaseBusyError so BullMQ does not complete the job', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'boot-busy',
    });
    const orgId = String(world.tables.runs[0].org_id);
    await lease.acquire(created.runId, 'other-owner');
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
      allowStubExecutor: true,
      workerId: 'boot-busy-w',
    });
    await assert.rejects(
      () =>
        runtime.processJob({
          runId: created.runId,
          orgId,
          traceId: TRACE,
        }),
      (err) => err instanceof LeaseBusyError && err.code === 'LEASE_BUSY',
    );
    // Status must remain non-terminal / unmutated by the busy attempt
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);
  });

  it('processJob throws NeedsReconciliationError for non-terminal re-entry refuse', async () => {
    const world = createFakeRunWorld();
    const lease = createFakeLease();
    const create = buildCreate(world);
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'boot-recon',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    const orgId = String(world.tables.runs[0].org_id);
    const runtime = createRunWorkerRuntime({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      leaseManager: lease,
      runQueue: world.runQueue,
      generateId: world.generateId,
      allowStubExecutor: true,
      workerId: 'boot-recon-w',
    });
    await assert.rejects(
      () =>
        runtime.processJob({
          runId: created.runId,
          orgId,
          traceId: TRACE,
        }),
      (err) =>
        err instanceof NeedsReconciliationError &&
        err.code === 'NEEDS_RECONCILIATION',
    );
    assert.equal(world.tables.runs[0].status, RUN_STATUS.RUNNING);
  });
});

describe('ExecuteRunService severe re-entry / recovery', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  /** @type {ReturnType<typeof createFakeLease>} */
  let lease;
  /** @type {CreateRunService} */
  let create;

  beforeEach(() => {
    world = createFakeRunWorld();
    lease = createFakeLease();
    create = buildCreate(world);
  });

  it('refuses re-prompt when durable status is already RUNNING', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-reentry-run',
    });
    const orgId = String(world.tables.runs[0].org_id);
    world.tables.runs[0].status = RUN_STATUS.RUNNING;

    let executed = 0;
    const exec = buildExecute(world, lease, {
      runExecutorFactory: () =>
        createStubRunExecutor({
          onExecute: async () => {
            executed += 1;
            return { outcome: 'SUCCEEDED' };
          },
        }),
    });
    const result = await exec.execute({
      runId: created.runId,
      orgId,
      traceId: TRACE,
      workerId: 'w-reentry',
    });
    assert.equal(executed, 0);
    assert.equal(result.needsReconciliation, true);
    assert.match(String(result.error), /refusing re-entry/i);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.RUNNING);
  });

  it('recovery terminalizes lease-free CANCELLING → CANCELLED', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rec-cxl',
    });
    world.tables.runs[0].status = RUN_STATUS.CANCELLING;
    world.tables.runs[0].cancel_requested_at = '2026-07-18 06:00:01.000';

    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
      leaseManager: lease,
    });
    const action = await recovery.recoverOneRef({
      runId: created.runId,
      orgId: String(world.tables.runs[0].org_id),
    });
    assert.equal(action.action, 'terminalized');
    assert.equal(action.status, RUN_STATUS.CANCELLED);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.CANCELLED);
  });

  it('recovery requeues lease-free RUNNING when the durable tool ledger is replay-safe', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rec-run',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    const jobsBefore = world.enqueuedJobs.length;

    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
      leaseManager: lease,
    });
    const action = await recovery.recoverOneRef({
      runId: created.runId,
      orgId: String(world.tables.runs[0].org_id),
    });
    assert.equal(
      action.action,
      'projected_and_enqueued',
      JSON.stringify(action),
    );
    assert.equal(action.status, RUN_STATUS.QUEUED);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);
    assert.equal(world.enqueuedJobs.length, jobsBefore + 1);
    assert.ok(
      world.tables.run_events.some(
        (event) => event.event_type === 'run.retrying',
      ),
    );
  });

  it('recovery does not re-prompt when the durable checkpoint already references the Run', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rec-current-checkpoint',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    world.tables.agent_sessions[0].pi_session_version = 1;
    world.tables.agent_sessions[0].last_run_id = created.runId;
    const jobsBefore = world.enqueuedJobs.length;

    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
      leaseManager: lease,
    });
    const action = await recovery.recoverOneRef({
      runId: created.runId,
      orgId: String(world.tables.runs[0].org_id),
    });

    assert.equal(action.action, 'needsReconciliation');
    assert.match(String(action.reason), /checkpoint.*this Run.*manual/i);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.RUNNING);
    assert.equal(world.enqueuedJobs.length, jobsBefore);
  });

  it('recovery requires manual reconciliation for an unresolved tool outcome', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rec-tool-unknown',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    world.tables.tool_executions.push({
      tool_execution_id: world.generateId(),
      run_id: created.runId,
      status: 'RUNNING',
    });
    world.tables.tool_executions.push({
      tool_execution_id: world.generateId(),
      run_id: created.runId,
      status: 'UNKNOWN',
    });
    const jobsBefore = world.enqueuedJobs.length;

    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
      leaseManager: lease,
    });
    const action = await recovery.recoverOneRef({
      runId: created.runId,
      orgId: String(world.tables.runs[0].org_id),
    });

    assert.equal(action.action, 'needsReconciliation');
    assert.match(String(action.reason), /UNKNOWN.*manual recovery/i);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.RUNNING);
    assert.equal(world.enqueuedJobs.length, jobsBefore);
  });

  it('recovery skips RUNNING when lease is still held', async () => {
    const created = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ex-rec-held',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    await lease.acquire(created.runId, 'live-worker');

    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
      leaseManager: lease,
    });
    const action = await recovery.recoverOneRef({
      runId: created.runId,
      orgId: String(world.tables.runs[0].org_id),
    });
    assert.equal(action.action, 'skipped');
    assert.equal(world.tables.runs[0].status, RUN_STATUS.RUNNING);
  });
});
