/**
 * A Run that parked for approval must not be failed by its own deadline.
 *
 * Reproduction: the approval row is committed to MySQL as PENDING and the
 * runtime session is aborted, exactly as the durable park expects. If the
 * wall-clock deadline fires in that same window, the executor returned FAILED
 * before it ever looked at `pendingApproval` — so the Run reached a terminal
 * state while an approval sat PENDING against it, which nobody can decide any
 * more. The identical guard already existed one branch below for promptError;
 * the deadline check simply did not have it.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createFakeRedis } from '../redis/fake-redis.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { PiRunExecutor } from '../../src/application/pi-run-executor.js';
import { SessionLockManager } from '../../src/infrastructure/redis/session-lock-manager.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { seedExecutorWorld, ORG, USER, CONV, SESS, VER, TRIG, RUN, fullModel } from './executor-world.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pi runtime double whose prompt() outlives the run deadline. */
function slowRuntimeFactory(onPromptStart) {
  return {
    async create(input) {
      const subs = [];
      const sessionManager = {
        getHeader: () => ({
          type: 'session',
          version: 3,
          id: input.agentSession.agentSessionId,
          timestamp: '2026-07-18T00:00:00.000Z',
          cwd: input.cwd,
        }),
        getEntries: () => [],
        getCwd: () => input.cwd,
        getSessionId: () => input.agentSession.agentSessionId,
      };
      const session = {
        subscribe(fn) {
          subs.push(fn);
          return () => {};
        },
        abort() {},
        async prompt() {
          await onPromptStart();
          // Long enough for the deadline timer to fire while parked.
          await sleep(120);
        },
      };
      return { session, sessionManager, dispose: async () => {} };
    },
  };
}

describe('run deadline vs a durably parked approval', () => {
  let state;
  let knex;
  let redis;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  const scope = { orgId: ORG, userId: USER };

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    redis = createFakeRedis();
    seedExecutorWorld(state);
  });

  function executorParkingAfter(parkKind) {
    const generateId = nextId;
    /** @type {object | null} */
    let suspensionPort = null;
    const factory = slowRuntimeFactory(async () => {
      assert.ok(suspensionPort, 'extension bundle must expose the suspension port');
      if (parkKind === 'approval') {
        suspensionPort.onDurableApprovalPending({
          kind: 'DURABLE_APPROVAL_PENDING',
          runId: RUN,
          approvalId: '01K0G2PAV8FPMVC9QHJG7JPN60',
          toolCallId: 'call-1',
        });
      }
      if (parkKind === 'interaction') {
        suspensionPort.onDurableInteractionPending({
          kind: 'DURABLE_INTERACTION_PENDING',
          runId: RUN,
          interactionId: '01K0G2PAV8FPMVC9QHJG7JPN61',
          toolCallId: 'ask-1',
          status: 'PENDING',
        });
      }
    });
    return new PiRunExecutor({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, { now: () => new Date(), generateId }),
      sessionLockManager: new SessionLockManager(redis, {
        ttlMs: 30_000,
        renewIntervalMs: 60_000,
      }),
      piRuntimeFactory: factory,
      modelResolver: async () => fullModel,
      workspaceResolver: async (sess) => `/workspace/${sess.workspaceId}`,
      generateId,
      now: () => new Date(),
      agentDir: '/tmp/agent-dir',
      sessionLockRenewIntervalMs: 60_000,
      // Deadline expires while prompt() is still unwinding the park.
      toolBudget: { runDeadlineMs: 20 },
      extensionBundleFactory: (_ctx, opts) => {
        suspensionPort = opts.runSuspensionPort;
        return [];
      },
    });
  }

  const run = () => ({
    runId: RUN,
    agentSessionId: SESS,
    conversationId: CONV,
    agentVersionId: VER,
    triggeringMessageId: TRIG,
    traceId: 'b'.repeat(32),
    orgId: ORG,
    userId: USER,
  });

  it('parks for approval instead of failing on the deadline', async () => {
    const exec = executorParkingAfter('approval');
    const result = await exec.execute({
      run: run(),
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(
      result.outcome,
      RUN_STATUS.WAITING_APPROVAL,
      'a Run with a PENDING approval must not go terminal on its deadline',
    );
    await exec.dispose();
  });

  it('parks for user input instead of failing on the deadline', async () => {
    const exec = executorParkingAfter('interaction');
    const result = await exec.execute({
      run: run(),
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.WAITING_INPUT);
    await exec.dispose();
  });

  it('still fails on the deadline when nothing is parked', async () => {
    const exec = executorParkingAfter('none');
    const result = await exec.execute({
      run: run(),
      scope,
      workerId: 'w1',
      signal: new AbortController().signal,
    });
    assert.equal(result.outcome, RUN_STATUS.FAILED);
    assert.match(String(result.statusReason), /deadline exceeded/i);
    await exec.dispose();
  });
});
