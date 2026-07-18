/**
 * CreateRun / GetRun / CancelRun service tests (PR-04 T2).
 * Offline fakes only — no MySQL/Redis/Docker/network.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateRunService,
  GetRunService,
  CancelRunService,
  IdempotencyInProgressError,
  IdempotencyConflictError,
  OwnerScopedNotFoundError,
  ValidationError,
  buildEventsUrl,
  normalizeTraceId,
  QUEUE_WARNING,
  RunParentProvisioner,
} from '../../src/application/index.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { isLegacyOrUuidIdentity, isUlid } from '../../src/domain/shared/ulid.js';
import { assertTraceId } from '../../src/infrastructure/mysql/repositories/run-repository.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from './helpers/fake-run-world.js';

const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];

/**
 * @param {ReturnType<typeof createFakeRunWorld>} world
 */
function buildServices(world) {
  const create = new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T06:00:00.000Z'),
    runQueue: world.runQueue,
  });
  const get = new GetRunService({
    createRepositories: world.createRepositories,
    db: world.rootDb,
  });
  const cancel = new CancelRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T06:00:00.000Z'),
    cancelSignal: world.cancelSignal,
  });
  return { create, get, cancel };
}

describe('CreateRunService durable path', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  /** @type {ReturnType<typeof buildServices>} */
  let svc;

  beforeEach(() => {
    world = createFakeRunWorld();
    svc = buildServices(world);
  });

  it('persists before enqueue: commit then job; immediate GET works', async () => {
    const order = [];
    const origEnqueue = world.runQueue.enqueue.bind(world.runQueue);
    world.runQueue.enqueue = async (ref) => {
      order.push('enqueue');
      // At enqueue time, run must already be committed.
      assert.equal(world.tables.runs.length, 1);
      assert.equal(world.tables.runs[0].status, RUN_STATUS.ACCEPTED);
      return origEnqueue(ref);
    };

    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'key-1',
    });
    order.push('response');

    assert.equal(created.status, 'ACCEPTED');
    assert.ok(isUlid(created.runId));
    assert.ok(isUlid(created.conversationId));
    assert.equal(created.eventsUrl, buildEventsUrl(created.runId));
    assert.ok(!isLegacyOrUuidIdentity(created.runId));
    assert.ok(!isLegacyOrUuidIdentity(created.conversationId));

    // External UUID never stored in CHAR(26) columns
    for (const row of world.tables.runs) {
      assert.ok(isUlid(String(row.run_id)));
      assert.ok(isUlid(String(row.org_id)));
      assert.ok(isUlid(String(row.user_id)));
      assert.notEqual(String(row.org_id), FIXED_AUTH.externalOrgId);
      assert.notEqual(String(row.user_id), FIXED_AUTH.externalUserId);
    }
    assert.ok(
      world.tables.organization_external_refs.some(
        (r) => r.external_subject === FIXED_AUTH.externalOrgId,
      ),
    );

    assert.equal(world.tables.messages.length, 1);
    assert.equal(world.tables.run_events.length, 2); // accepted + queued
    assert.equal(world.tables.domain_outbox.length, 2);
    assert.equal(world.enqueuedJobs.length, 1);
    assert.deepEqual(world.enqueuedJobs[0], {
      runId: created.runId,
      orgId: world.tables.runs[0].org_id,
      traceId: TRACE,
    });
    assert.deepEqual(order, ['enqueue', 'response']);

    // After enqueue path, status should be QUEUED (CAS in second txn).
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);

    const got = await svc.get.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
    });
    assert.equal(got.runId, created.runId);
    assert.equal(got.status, RUN_STATUS.QUEUED);
  });

  it('duplicate same key+body replays without second rows/jobs', async () => {
    const first = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'dup-key',
    });
    const runsAfterFirst = world.tables.runs.length;
    const jobsAfterFirst = world.enqueuedJobs.length;
    const eventsAfterFirst = world.tables.run_events.length;
    const outboxAfterFirst = world.tables.domain_outbox.length;
    const messagesAfterFirst = world.tables.messages.length;

    const second = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'dup-key',
    });

    assert.equal(second.runId, first.runId);
    assert.equal(second.replayed, true);
    assert.equal(world.tables.runs.length, runsAfterFirst);
    // Replay may safely re-enqueue (deterministic jobId); never a second Run/message.
    assert.ok(world.enqueuedJobs.length >= jobsAfterFirst);
    assert.ok(world.enqueuedJobs.length <= jobsAfterFirst + 1);
    assert.equal(world.tables.messages.length, messagesAfterFirst);
    // No second accepted event
    assert.equal(
      world.tables.run_events.filter((e) => e.event_type === 'run.accepted')
        .length,
      world.tables.run_events
        .slice(0, eventsAfterFirst)
        .filter((e) => e.event_type === 'run.accepted').length || 1,
    );
    assert.ok(world.tables.domain_outbox.length >= outboxAfterFirst);
  });

  it('different body with same key conflicts', async () => {
    await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'conflict-key',
    });
    await assert.rejects(
      () =>
        svc.create.execute({
          messages: [{ role: 'user', content: 'other' }],
          auth: FIXED_AUTH,
          traceId: TRACE,
          idempotencyKey: 'conflict-key',
        }),
      IdempotencyConflictError,
    );
  });

  it('queue failure keeps committed ACCEPTED facts and returns warning', async () => {
    world.runQueue.setFail(true);
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'q-fail',
    });
    assert.equal(created.status, 'ACCEPTED');
    assert.equal(created.queueWarning, QUEUE_WARNING.ENQUEUE_FAILED);
    assert.equal(world.tables.runs.length, 1);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.ACCEPTED);
    assert.equal(world.enqueuedJobs.length, 0);
    // accepted event+outbox present; no queued transition
    assert.equal(
      world.tables.run_events.filter((e) => e.event_type === 'run.accepted')
        .length,
      1,
    );
    assert.equal(
      world.tables.run_events.filter((e) => e.event_type === 'run.queued')
        .length,
      0,
    );

    const got = await svc.get.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
    });
    assert.equal(got.status, RUN_STATUS.ACCEPTED);
  });

  it('enqueue success + QUEUED projection failure returns ACCEPTED with warning', async () => {
    let txN = 0;
    const inner = world.transactionManager.run.bind(world.transactionManager);
    world.transactionManager.run = async (work) => {
      txN += 1;
      // 1st txn: create commit; 2nd: projection — fail it
      if (txN === 2) {
        throw new Error('projection txn boom');
      }
      return inner(work);
    };
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'proj-fail',
    });
    assert.equal(created.status, 'ACCEPTED');
    assert.equal(
      created.queueWarning,
      QUEUE_WARNING.STATUS_PROJECTION_FAILED,
    );
    assert.equal(world.tables.runs[0].status, RUN_STATUS.ACCEPTED);
    assert.equal(world.enqueuedJobs.length, 1);
  });

  it('replay after enqueue failure re-enqueues without second Run', async () => {
    world.runQueue.setFail(true);
    const first = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'replay-enq',
    });
    assert.equal(first.queueWarning, QUEUE_WARNING.ENQUEUE_FAILED);
    assert.equal(world.enqueuedJobs.length, 0);
    assert.equal(world.tables.runs.length, 1);

    world.runQueue.setFail(false);
    const second = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'replay-enq',
    });
    assert.equal(second.replayed, true);
    assert.equal(second.runId, first.runId);
    assert.equal(world.tables.runs.length, 1);
    assert.equal(world.enqueuedJobs.length, 1);
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);
  });

  it('terminal replay does not enqueue', async () => {
    const first = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'term-replay',
    });
    world.tables.runs[0].status = RUN_STATUS.SUCCEEDED;
    const jobsBefore = world.enqueuedJobs.length;
    const second = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'term-replay',
    });
    assert.equal(second.replayed, true);
    assert.equal(second.runId, first.runId);
    assert.equal(world.enqueuedJobs.length, jobsBefore);
  });

  it('replay projection failure yields warning without second run', async () => {
    world.runQueue.setFail(true);
    await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'replay-proj',
    });
    world.runQueue.setFail(false);
    const reposFactory = world.createRepositories;
    world.createRepositories = (db) => {
      const repos = reposFactory(db);
      return {
        ...repos,
        outbox: {
          insert: async (input) => {
            if (input.eventType === 'run.queued') {
              throw new Error('outbox projection fail');
            }
            return repos.outbox.insert(input);
          },
        },
      };
    };
    svc = buildServices(world);

    const second = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'replay-proj',
    });
    assert.equal(second.replayed, true);
    assert.equal(world.tables.runs.length, 1);
    assert.equal(
      second.queueWarning,
      QUEUE_WARNING.STATUS_PROJECTION_FAILED,
    );
    assert.equal(world.tables.runs[0].status, RUN_STATUS.ACCEPTED);
  });

  it('accepted→queued race is idempotent when worker wins CAS', async () => {
    // Intercept second transaction CAS: after first commit, flip to QUEUED.
    let createTx = 0;
    const innerRun = world.transactionManager.run.bind(world.transactionManager);
    world.transactionManager.run = async (work) => {
      createTx += 1;
      if (createTx === 2) {
        // Pretend worker already transitioned ACCEPTED→QUEUED / STARTING.
        for (const r of world.tables.runs) {
          if (r.status === RUN_STATUS.ACCEPTED) r.status = RUN_STATUS.QUEUED;
        }
      }
      return innerRun(work);
    };

    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'race-key',
    });
    assert.equal(created.status, 'ACCEPTED');
    // Still exactly one run; queue may have 1 accepted + 0 or 1 queued events.
    assert.equal(world.tables.runs.length, 1);
    assert.ok(
      [RUN_STATUS.QUEUED, RUN_STATUS.ACCEPTED].includes(
        world.tables.runs[0].status,
      ),
    );
  });

  it('events + outbox share create transaction (rollback simulation)', async () => {
    // First call succeeds.
    await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'ok-1',
    });
    const snap = world.snapshot();

    // Force failure mid-txn after repositories would write — simulate by
    // failing the next transaction entirely before work completes.
    world.failNextTransaction();
    await assert.rejects(
      () =>
        svc.create.execute({
          messages: MESSAGES,
          auth: {
            ...FIXED_AUTH,
            externalUserId: '770e8400-e29b-41d4-a716-446655440099',
          },
          traceId: TRACE,
          idempotencyKey: 'rollback-key',
        }),
      /simulated transaction failure/,
    );

    // Tables restored to snapshot shape for new tenant rows — no partial
    // message/run/event/outbox for the failed attempt.
    assert.equal(world.tables.runs.length, snap.runs.length);
    assert.equal(world.tables.messages.length, snap.messages.length);
    assert.equal(world.tables.run_events.length, snap.run_events.length);
    assert.equal(world.tables.domain_outbox.length, snap.domain_outbox.length);
    assert.ok(world.rollbackCount >= 1);
  });

  it('reuses parents on second create for same external conversation', async () => {
    const a = await svc.create.execute({
      messages: MESSAGES,
      auth: {
        ...FIXED_AUTH,
        externalConversationId: 'conv-uuid-1',
      },
      traceId: TRACE,
      idempotencyKey: 'p1',
    });
    const b = await svc.create.execute({
      messages: [{ role: 'user', content: 'follow-up' }],
      auth: {
        ...FIXED_AUTH,
        externalConversationId: 'conv-uuid-1',
      },
      traceId: TRACE,
      idempotencyKey: 'p2',
    });
    assert.equal(a.conversationId, b.conversationId);
    assert.notEqual(a.runId, b.runId);
    assert.equal(world.tables.conversations.length, 1);
    assert.equal(world.tables.organizations.length, 1);
    assert.equal(world.tables.users.length, 1);
    assert.equal(world.tables.agent_definitions.length, 1);
    // Active session reused
    assert.equal(world.tables.agent_sessions.length, 1);
  });

  it('tenant isolation: foreign owner gets not found on GET', async () => {
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'iso-1',
    });
    await assert.rejects(
      () =>
        svc.get.execute({
          runId: created.runId,
          auth: {
            provider: 'bff',
            externalOrgId: '880e8400-e29b-41d4-a716-446655440088',
            externalUserId: '990e8400-e29b-41d4-a716-446655440099',
          },
        }),
      OwnerScopedNotFoundError,
    );
  });

  it('new services do not use process-local Map as status authority', async () => {
    // Structural: CreateRunService source must not reference a runs Map.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    for (const file of [
      'create-run-service.js',
      'get-run-service.js',
      'cancel-run-service.js',
    ]) {
      const src = fs.readFileSync(
        path.join(dir, '../../src/application', file),
        'utf8',
      );
      assert.equal(src.includes('new Map'), false, `${file} must not use Map`);
      assert.equal(
        /const\s+runs\s*=/.test(src),
        false,
        `${file} must not keep runs registry`,
      );
    }
  });
});

describe('CancelRunService durable intent', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  /** @type {ReturnType<typeof buildServices>} */
  let svc;

  beforeEach(() => {
    world = createFakeRunWorld();
    svc = buildServices(world);
  });

  it('records intent and transitions QUEUED→CANCELLING; never returns CANCELLED', async () => {
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'c1',
    });
    assert.equal(world.tables.runs[0].status, RUN_STATUS.QUEUED);

    const cancelled = await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
      reason: 'user requested',
    });
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(cancelled.status, RUN_STATUS.CANCELLING);
    assert.equal(cancelled.transitionedToCancelling, true);
    assert.equal(cancelled.signalPending, false);
    assert.notEqual(cancelled.status, RUN_STATUS.CANCELLED);
    assert.ok(world.tables.runs[0].cancel_requested_at);
    assert.equal(world.tables.runs[0].cancel_reason, 'user requested');
    assert.ok(isUlid(String(world.tables.runs[0].cancel_requested_by)));
    assert.equal(world.cancelSignals.length, 1);
  });

  it('intent durable despite Redis failure; signalPending=true', async () => {
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'c2',
    });
    world.cancelSignal.setFail(true);
    const cancelled = await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
      reason: 'stop',
    });
    assert.equal(cancelled.signalPending, true);
    assert.ok(world.tables.runs[0].cancel_requested_at);
    assert.equal(world.cancelSignals.length, 0);
  });

  it('ACCEPTED without queue transition: intent only, no illegal edge', async () => {
    world.runQueue.setFail(true);
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'c3',
    });
    assert.equal(world.tables.runs[0].status, RUN_STATUS.ACCEPTED);

    const cancelled = await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
    });
    assert.equal(cancelled.status, RUN_STATUS.ACCEPTED);
    assert.equal(cancelled.transitionedToCancelling, false);
    assert.ok(world.tables.runs[0].cancel_requested_at);
    // No invented CANCELLING from ACCEPTED
    assert.equal(
      world.tables.run_events.filter(
        (e) =>
          e.event_type === 'run.status.changed' &&
          String(e.payload_json).includes('CANCELLING'),
      ).length,
      0,
    );
  });

  it('terminal run cancel is idempotent without new intent or redis signal', async () => {
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'c4',
    });
    world.tables.runs[0].status = RUN_STATUS.SUCCEEDED;
    // No prior cancel intent
    world.tables.runs[0].cancel_requested_at = null;
    world.tables.runs[0].cancel_reason = null;
    world.tables.runs[0].cancel_requested_by = null;
    const signalsBefore = world.cancelSignals.length;

    const cancelled = await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
      reason: 'should-not-write',
    });
    assert.equal(cancelled.terminal, true);
    assert.equal(cancelled.status, RUN_STATUS.SUCCEEDED);
    assert.equal(cancelled.transitionedToCancelling, false);
    assert.equal(cancelled.cancelRequested, false);
    assert.equal(cancelled.signalPending, false);
    // Must not write intent or fire Redis on terminal
    assert.equal(world.tables.runs[0].cancel_requested_at, null);
    assert.equal(world.cancelSignals.length, signalsBefore);
  });

  it('terminal with existing intent returns it without re-signal', async () => {
    const created = await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'c5',
    });
    // Non-terminal cancel first
    await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
      reason: 'user',
    });
    const intentAt = world.tables.runs[0].cancel_requested_at;
    world.tables.runs[0].status = RUN_STATUS.CANCELLED;
    const signalsBefore = world.cancelSignals.length;

    const again = await svc.cancel.execute({
      runId: created.runId,
      auth: FIXED_AUTH,
      reason: 'again',
    });
    assert.equal(again.terminal, true);
    assert.equal(again.cancelRequested, true);
    assert.ok(again.cancelRequestedAt);
    assert.equal(world.cancelSignals.length, signalsBefore);
    assert.equal(world.tables.runs[0].cancel_reason, 'user');
    assert.equal(world.tables.runs[0].cancel_requested_at, intentAt);
  });
});

describe('trace-id W3C validation', () => {
  it('rejects all-zero trace-id and lowercases', () => {
    assert.throws(() => normalizeTraceId('0'.repeat(32)), ValidationError);
    assert.throws(() => assertTraceId('0'.repeat(32)), /all-zero|traceId/);
    assert.equal(normalizeTraceId('A'.repeat(32)), 'a'.repeat(32));
    assert.equal(assertTraceId('B'.repeat(32)), 'b'.repeat(32));
  });
});

describe('parent provisioning session version binding', () => {
  it('reused session binds Run to session.agentVersionId not new default', async () => {
    const world = createFakeRunWorld();
    const first = await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      const p = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        { generateId: world.generateId, db: trx },
      );
      return p.provision({
        ...FIXED_AUTH,
        externalConversationId: 'conv-ver-1',
      });
    });
    const originalVersion = first.agentVersionId;
    assert.ok(isUlid(originalVersion));

    // Simulate tenant default active version change: new version row + pointer
    const newVer = world.generateId();
    world.tables.agent_versions.push({
      agent_version_id: newVer,
      agent_id: first.agentId,
      version_no: 2,
      config_json: '{}',
      config_hash: 'b'.repeat(64),
      pi_sdk_version: '0.80.3',
      status: 'active',
      created_by: first.userId,
      created_at: '2026-07-18 07:00:00.000',
    });
    for (const d of world.tables.agent_definitions) {
      if (d.agent_id === first.agentId) d.active_version_id = newVer;
    }

    const second = await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      const p = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        { generateId: world.generateId, db: trx },
      );
      return p.provision({
        ...FIXED_AUTH,
        externalConversationId: 'conv-ver-1',
      });
    });
    assert.equal(second.agentSessionId, first.agentSessionId);
    assert.equal(second.agentVersionId, originalVersion);
    assert.notEqual(second.agentVersionId, newVer);
  });
});

describe('parent provisioning created flags', () => {
  it('created.membership is true only when membership was absent', async () => {
    const world = createFakeRunWorld();
    const first = await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      const p = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        { generateId: world.generateId, db: trx },
      );
      return p.provision(FIXED_AUTH);
    });
    assert.equal(first.created.organization, true);
    assert.equal(first.created.user, true);
    assert.equal(first.created.membership, true);

    const second = await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      const p = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        { generateId: world.generateId, db: trx },
      );
      return p.provision({
        ...FIXED_AUTH,
        externalConversationId: 'shared-conv',
      });
    });
    assert.equal(second.created.organization, false);
    assert.equal(second.created.user, false);
    assert.equal(second.created.membership, false);
    assert.equal(second.orgId, first.orgId);
    assert.equal(second.userId, first.userId);

    // New user in same org → membership created without org create
    const third = await world.transactionManager.run(async (trx) => {
      const repos = world.createRepositories(trx);
      const p = new RunParentProvisioner(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
          catalog: repos.catalog,
          conversations: repos.conversations,
          sessions: repos.sessions,
        },
        { generateId: world.generateId, db: trx },
      );
      return p.provision({
        ...FIXED_AUTH,
        externalUserId: 'aa0e8400-e29b-41d4-a716-4466554400aa',
      });
    });
    assert.equal(third.created.organization, false);
    assert.equal(third.created.user, true);
    assert.equal(third.created.membership, true);
    assert.equal(third.orgId, first.orgId);
  });
});

describe('in-progress idempotency', () => {
  it('returns retryable conflict when record incomplete', async () => {
    const world = createFakeRunWorld();
    const svc = buildServices(world);
    // Seed incomplete idempotency under owner that provisioner will resolve.
    // First begin a create, but inject incomplete by pre-inserting after parents.
    // Simpler: create once, then manually clear response to simulate in-progress.
    await svc.create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'prog-key',
    });
    const rec = world.tables.idempotency_records[0];
    rec.response_status = null;
    rec.response_json = null;
    // Same hash → in_progress
    await assert.rejects(
      () =>
        svc.create.execute({
          messages: MESSAGES,
          auth: FIXED_AUTH,
          traceId: TRACE,
          idempotencyKey: 'prog-key',
        }),
      IdempotencyInProgressError,
    );
  });
});
