/**
 * PR-14 offline: load + concurrency matrix (plan §25.6 / §25.8).
 *
 * No Docker / live MySQL / live Redis / network. Meaningful invariants:
 * - concurrent CreateRun same key → one Run, no duplicate side effects
 * - different tenants concurrent → isolated rows
 * - 10_000 event replay remains contiguous and O(pages) without gaps/dupes
 * - 100 concurrent SSE openStreams complete without sequence inversion
 *
 * Does NOT assume Sandbox /agent-runs or /agent-sessions (removed PR-13).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreateRunService,
  GetRunService,
  OwnerScopedNotFoundError,
} from '../../src/application/index.js';
import {
  RunEventSseService,
  shouldEmitSequence,
} from '../../src/application/run-event-sse-service.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from '../run-services/helpers/fake-run-world.js';

const MESSAGES = [{ role: 'user', content: [{ type: 'text', text: 'load' }] }];

function ulidLike(i) {
  // Valid Crockford base32 ULID alphabet, fixed length 26
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = '01K0G2PAV8FPMVC9QHJG7';
  const n = String(i).padStart(5, '0');
  for (const ch of n) {
    s += alphabet[Number(ch) % alphabet.length];
  }
  return s.slice(0, 26);
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

function buildGet(world) {
  return new GetRunService({
    createRepositories: world.createRepositories,
    db: world.rootDb,
  });
}

describe('PR-14 load/concurrency: CreateRun idempotency', () => {
  /** @type {ReturnType<typeof createFakeRunWorld>} */
  let world;
  /** @type {CreateRunService} */
  let create;

  beforeEach(() => {
    world = createFakeRunWorld();
    create = buildCreate(world);
  });

  it('burst same key+body yields one Run (no duplicate side-effect rows)', async () => {
    // Offline fake txn manager is not multi-writer safe (documented live MySQL gate).
    // Serialize txn.run to exercise service-level idempotency under concurrent callers
    // without fake-table corruption.
    let chain = Promise.resolve();
    const innerRun = world.transactionManager.run.bind(world.transactionManager);
    world.transactionManager.run = (work) => {
      const next = chain.then(() => innerRun(work));
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

    const key = 'pr14-concurrent-idem';
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        create.execute({
          messages: MESSAGES,
          auth: FIXED_AUTH,
          traceId: TRACE,
          idempotencyKey: key,
        }),
      ),
    );

    const runIds = new Set(results.map((r) => r.runId));
    assert.equal(runIds.size, 1, 'exactly one durable Run id');
    assert.equal(world.tables.runs.length, 1);
    assert.equal(world.tables.messages.length, 1);
    // Deterministic jobId = runId: enqueue may retry, never second Run rows
    const runId = results[0].runId;
    assert.ok(world.enqueuedJobs.every((j) => j.runId === runId));
    assert.equal(
      world.tables.run_events.filter((e) => e.event_type === 'run.accepted')
        .length,
      1,
    );
  });

  it('different orgs concurrent create remain isolated (cross-tenant GET fails)', async () => {
    const authA = FIXED_AUTH;
    const authB = {
      provider: 'bff',
      externalOrgId: '880e8400-e29b-41d4-a716-446655440088',
      externalUserId: '990e8400-e29b-41d4-a716-446655440099',
    };

    const [a, b] = await Promise.all([
      create.execute({
        messages: MESSAGES,
        auth: authA,
        traceId: TRACE,
        idempotencyKey: 'org-a',
      }),
      create.execute({
        messages: MESSAGES,
        auth: authB,
        traceId: TRACE,
        idempotencyKey: 'org-b',
      }),
    ]);

    assert.notEqual(a.runId, b.runId);
    assert.equal(world.tables.runs.length, 2);
    assert.notEqual(world.tables.runs[0].org_id, world.tables.runs[1].org_id);

    const get = buildGet(world);
    await assert.rejects(
      () => get.execute({ runId: a.runId, auth: authB }),
      OwnerScopedNotFoundError,
    );
    await assert.rejects(
      () => get.execute({ runId: b.runId, auth: authA }),
      OwnerScopedNotFoundError,
    );
  });

  it('rapid sequential submits for same conversation do not corrupt sequence uniqueness', async () => {
    const conv = 'conv-pr14-multi';
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await create.execute({
        messages: [{ role: 'user', content: `turn-${i}` }],
        auth: { ...FIXED_AUTH, externalConversationId: conv },
        traceId: TRACE,
        idempotencyKey: `turn-${i}`,
      });
      ids.push(r.runId);
    }
    assert.equal(new Set(ids).size, 8);
    assert.equal(world.tables.conversations.length, 1);
    assert.equal(world.tables.agent_sessions.length, 1);
    const seqs = world.tables.run_events.map(
      (e) => `${e.run_id}:${e.sequence_no}`,
    );
    assert.equal(seqs.length, new Set(seqs).size, 'no (run,sequence) dupes');
  });
});

describe('PR-14 load: 10k event replay + 100 concurrent SSE', () => {
  it('10_000 MySQL history events replay contiguous without duplicates', async () => {
    const TOTAL = 10_000;
    const events = Array.from({ length: TOTAL }, (_, i) => {
      const seq = i + 1;
      const eventId = ulidLike(seq);
      return {
        sequence: seq,
        event: {
          type: seq === TOTAL ? 'run.completed' : 'message.delta',
          event_type: seq === TOTAL ? 'run.completed' : 'message.delta',
          eventId,
          event_id: eventId,
        },
        ts: 1_000 + seq,
        eventId,
        event_id: eventId,
      };
    });

    let maxPageAfter = -1;
    const eventQueryService = {
      async listEvents({ afterSequence = 0, limit = 100 }) {
        const page = events
          .filter((e) => e.sequence > afterSequence)
          .slice(0, limit);
        maxPageAfter = Math.max(maxPageAfter, afterSequence);
        const last = page.length ? page[page.length - 1].sequence : afterSequence;
        return {
          events: page,
          terminal: last >= TOTAL && page.length < limit,
          status: last >= TOTAL ? 'SUCCEEDED' : 'RUNNING',
        };
      },
    };

    const svc = new RunEventSseService({
      eventQueryService,
      runEventStream: null,
      pollMs: 1,
      heartbeatMs: 60 * 60 * 1000,
      historyPageSize: 250,
    });

    const sequences = [];
    const result = await svc.openStream(
      {
        runId: '01K0G2PAV8FPMVC9QHJG7JPN53',
        auth: { externalOrgId: 'o', externalUserId: 'u' },
        afterSequence: 0,
      },
      {
        write: (chunk) => {
          const m = /"sequence":(\d+)/.exec(chunk);
          if (m) sequences.push(Number(m[1]));
          return true;
        },
        isClosed: () => false,
      },
    );

    assert.equal(result.lastSequence, TOTAL);
    assert.equal(sequences.length, TOTAL);
    for (let i = 0; i < TOTAL; i += 1) {
      assert.equal(sequences[i], i + 1);
    }
    assert.equal(new Set(sequences).size, TOTAL);
    // Paging must advance (not re-scan from 0 each time for full set)
    assert.ok(maxPageAfter > 0, 'history must page past sequence 0');
  });

  it('100 concurrent SSE streams each see contiguous sequences independently', async () => {
    const N = 100;
    const PER_RUN = 50;

    function makeEvents(runIndex) {
      return Array.from({ length: PER_RUN }, (_, i) => {
        const seq = i + 1;
        const eventId = ulidLike(runIndex * 1000 + seq);
        return {
          sequence: seq,
          event: {
            type: seq === PER_RUN ? 'run.completed' : 'tool.execution.completed',
            eventId,
          },
          ts: seq,
          eventId,
        };
      });
    }

    const streams = Array.from({ length: N }, (_, runIndex) => {
      const events = makeEvents(runIndex);
      const eventQueryService = {
        async listEvents({ afterSequence = 0, limit = 100 }) {
          const page = events
            .filter((e) => e.sequence > afterSequence)
            .slice(0, limit);
          return {
            events: page,
            terminal: true,
            status: 'SUCCEEDED',
          };
        },
      };
      const svc = new RunEventSseService({
        eventQueryService,
        pollMs: 1,
        heartbeatMs: 60 * 60 * 1000,
      });
      const sequences = [];
      return svc
        .openStream(
          {
            runId: ulidLike(runIndex + 1),
            auth: { externalOrgId: `org-${runIndex}`, externalUserId: 'u' },
            afterSequence: 0,
          },
          {
            write: (chunk) => {
              const m = /"sequence":(\d+)/.exec(chunk);
              if (m) sequences.push(Number(m[1]));
              return true;
            },
            isClosed: () => false,
          },
        )
        .then((result) => ({ result, sequences }));
    });

    const outcomes = await Promise.all(streams);
    assert.equal(outcomes.length, N);
    for (const { result, sequences } of outcomes) {
      assert.equal(result.lastSequence, PER_RUN);
      assert.equal(sequences.length, PER_RUN);
      for (let i = 0; i < PER_RUN; i += 1) {
        assert.equal(sequences[i], i + 1);
        assert.equal(shouldEmitSequence({ sequence: i + 1 }, i), true);
      }
    }
  });
});

describe('PR-14 concurrency: recovery scan does not re-exec RUNNING', () => {
  it('queue-failed ACCEPTED requeues once; RUNNING without leaseManager stays needsReconciliation', async () => {
    const { RunRecoveryService } = await import(
      '../../src/application/run-recovery-service.js'
    );
    const world = createFakeRunWorld();
    const create = buildCreate(world);

    world.runQueue.setFail(true);
    const accepted = await create.execute({
      messages: MESSAGES,
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'pr14-rec-a',
    });
    world.runQueue.setFail(false);

    const running = await create.execute({
      messages: MESSAGES,
      auth: {
        ...FIXED_AUTH,
        externalUserId: '770e8400-e29b-41d4-a716-446655440077',
      },
      traceId: TRACE,
      idempotencyKey: 'pr14-rec-r',
    });
    const runningRow = world.tables.runs.find((r) => r.run_id === running.runId);
    runningRow.status = RUN_STATUS.RUNNING;

    const jobsBefore = world.enqueuedJobs.length;
    const recovery = new RunRecoveryService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      runQueue: world.runQueue,
      generateId: world.generateId,
    });
    const { actions } = await recovery.scanAndRequeue({ limit: 50 });
    const a = actions.find((x) => x.runId === accepted.runId);
    const r = actions.find((x) => x.runId === running.runId);
    assert.ok(a && (a.action === 'enqueued' || a.action === 'projected_and_enqueued'));
    assert.equal(r.action, 'needsReconciliation');
    // RUNNING must not enqueue another side-effecting job
    assert.ok(
      !world.enqueuedJobs.slice(jobsBefore).some((j) => j.runId === running.runId),
    );
  });
});
