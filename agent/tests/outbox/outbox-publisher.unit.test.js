/**
 * Offline unit tests for OutboxPublisher (fake repository + fake stream).
 * Covers eligibility, permanent mapping, Redis retry, ack-miss recovery,
 * stable eventId, no Run SM.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeOutboxKnex,
  createFakeState,
  seedOutboxRow,
} from './fake-outbox-knex.js';
import {
  OutboxRepository,
  OutboxPublisher,
  mapOutboxToRunStreamEvent,
  resolveStableEventId,
  resolveSequence,
  parseNonNegativeSafeInteger,
  PermanentMappingError,
  isPermanentMappingError,
  RUN_STREAM_CLAIM_ELIGIBILITY,
  OUTBOX_STATUS,
} from '../../src/infrastructure/outbox/index.js';

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const OB1 = '01K0G2PAV8FPMVC9QHJG7JPN71';
const OB2 = '01K0G2PAV8FPMVC9QHJG7JPN72';
const EVT = '01K0G2PAV8FPMVC9QHJG7JPN73';
const ORG_OB = '01K0G2PAV8FPMVC9QHJG7JPN74';
const FIXED_NOW = new Date('2026-07-18T05:00:00.000Z');
const CREATED = '2026-07-18T04:31:22.000Z';

function createFakeStream() {
  /** @type {Array<{ runId: string, fields: Record<string, string> }>} */
  const appends = [];
  let failNext = 0;
  return {
    appends,
    failNextTimes(n) {
      failNext = n;
    },
    async append(runId, fields) {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('redis connection refused');
      }
      appends.push({ runId, fields: { ...fields } });
      return '1-0';
    },
  };
}

describe('stream mapper strict shapes', () => {
  it('uses stable eventId from payload or outbox_id', () => {
    assert.equal(
      resolveStableEventId({
        outboxId: OB1,
        payloadJson: { eventId: EVT },
      }),
      EVT,
    );
    assert.equal(
      resolveStableEventId({ outboxId: OB1, payloadJson: {} }),
      OB1,
    );
  });

  it('rejects invalid/missing sequence (never coerces to 0)', () => {
    assert.equal(parseNonNegativeSafeInteger(0), 0);
    assert.equal(parseNonNegativeSafeInteger(18), 18);
    assert.equal(parseNonNegativeSafeInteger(-1), null);
    assert.equal(parseNonNegativeSafeInteger(1.5), null);
    assert.equal(parseNonNegativeSafeInteger(Number.MAX_SAFE_INTEGER + 1), null);
    assert.equal(parseNonNegativeSafeInteger('01'), null);
    assert.equal(parseNonNegativeSafeInteger(''), null);

    assert.throws(
      () => resolveSequence({ payloadJson: {} }),
      PermanentMappingError,
    );
    assert.throws(
      () => resolveSequence({ payloadJson: { sequence: -3 } }),
      PermanentMappingError,
    );
    assert.throws(
      () => resolveSequence({ payloadJson: { sequence: 1.2 } }),
      PermanentMappingError,
    );
    assert.throws(
      () => resolveSequence({ payloadJson: { sequence: 'nope' } }),
      PermanentMappingError,
    );
    assert.equal(resolveSequence({ payloadJson: { sequence: 0 } }), '0');
    assert.equal(resolveSequence({ payloadJson: { sequenceNo: 4 } }), '4');
  });

  it('maps valid run-scoped rows and rejects non-run without runId as permanent', () => {
    const mapped = mapOutboxToRunStreamEvent({
      outboxId: OB1,
      aggregateType: 'run',
      aggregateId: RUN,
      eventType: 'tool.execution.started',
      payloadJson: { eventId: EVT, sequence: 18, foo: 'bar' },
      createdAt: CREATED,
    });
    assert.equal(mapped.runId, RUN);
    assert.deepEqual(mapped.fields, {
      eventId: EVT,
      sequence: '18',
      type: 'tool.execution.started',
      payload: JSON.stringify({ eventId: EVT, sequence: 18, foo: 'bar' }),
      createdAt: CREATED,
    });

    assert.throws(
      () =>
        mapOutboxToRunStreamEvent({
          outboxId: OB1,
          aggregateType: 'conversation',
          aggregateId: '01K0G2PAV8FPMVC9QHJG7JPN51',
          eventType: 'message.created',
          payloadJson: {},
          createdAt: CREATED,
        }),
      (err) => isPermanentMappingError(err),
    );

    const viaPayload = mapOutboxToRunStreamEvent({
      outboxId: OB1,
      aggregateType: 'tool',
      aggregateId: '01K0G2PAV8FPMVC9QHJG7JPN99',
      eventType: 'tool.execution.completed',
      payloadJson: { runId: RUN, sequence: 2, eventId: EVT },
      createdAt: CREATED,
    });
    assert.equal(viaPayload.runId, RUN);
  });

  it('malformed run aggregate (bad aggregate_id) is permanent mapping error', () => {
    assert.throws(
      () =>
        mapOutboxToRunStreamEvent({
          outboxId: OB1,
          aggregateType: 'run',
          aggregateId: 'not-a-ulid',
          eventType: 'run.started',
          payloadJson: { sequence: 1 },
          createdAt: CREATED,
        }),
      PermanentMappingError,
    );
  });
});

describe('OutboxPublisher unit', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {OutboxRepository} */
  let repo;
  /** @type {ReturnType<typeof createFakeStream>} */
  let stream;
  let tokenSeq;

  beforeEach(() => {
    state = createFakeState();
    const knex = createFakeOutboxKnex(state);
    tokenSeq = 0;
    repo = new OutboxRepository(knex, {
      now: () => FIXED_NOW,
      maxAttempts: 3,
      staleClaimMs: 30_000,
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      generateClaimToken: () => {
        tokenSeq += 1;
        return `PUBCLAIM${String(tokenSeq).padStart(18, '0')}`.slice(0, 26);
      },
    });
    stream = createFakeStream();
    state.tables.runs = [{ run_id: RUN, status: 'RUNNING' }];
  });

  it('publishes claimed rows to stream with stable eventId', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({
        eventId: EVT,
        sequence: 7,
        runId: RUN,
      }),
    });
    const publisher = new OutboxPublisher({
      repository: repo,
      stream,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    const result = await publisher.publishOnce();
    assert.equal(result.claimed, 1);
    assert.equal(result.published, 1);
    assert.equal(stream.appends.length, 1);
    assert.equal(stream.appends[0].runId, RUN);
    assert.equal(stream.appends[0].fields.eventId, EVT);
    assert.equal(stream.appends[0].fields.sequence, '7');
    assert.equal(stream.appends[0].fields.type, 'run.started');
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHED');
  });

  it('does not claim or fail unrelated non-run outbox rows', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({ eventId: EVT, sequence: 1, runId: RUN }),
    });
    seedOutboxRow(state, {
      outbox_id: ORG_OB,
      aggregate_type: 'organization',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      event_type: 'org.updated',
      payload_json: JSON.stringify({ name: 'acme' }),
      created_at: '2026-07-18 04:30:00.000',
    });

    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.claimed, 1);
    assert.equal(result.published, 1);
    assert.equal(result.failed, 0);

    const org = state.tables.domain_outbox.find((r) => r.outbox_id === ORG_OB);
    assert.equal(org.status, 'PENDING');
    assert.equal(org.attempts, 0);
    assert.equal(org.claim_token, null);
    assert.equal(org.last_error, null);
    assert.equal(state.tables.runs[0].status, 'RUNNING');
  });

  it('publishes non-run rows that intentionally carry payload.runId', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      aggregate_type: 'tool',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN99',
      event_type: 'tool.execution.completed',
      payload_json: JSON.stringify({
        eventId: EVT,
        sequence: 9,
        runId: RUN,
      }),
    });
    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.published, 1);
    assert.equal(stream.appends[0].fields.sequence, '9');
  });

  it('marks permanent mapping failures FAILED once (no Redis retries)', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({
        eventId: EVT,
        // missing sequence → permanent
        runId: RUN,
      }),
    });
    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.failed, 1);
    assert.equal(result.retried, 0);
    assert.equal(stream.appends.length, 0);
    assert.equal(state.tables.domain_outbox[0].status, 'FAILED');
    assert.match(String(state.tables.domain_outbox[0].last_error), /sequence/i);
    assert.equal(state.tables.runs[0].status, 'RUNNING');
  });

  it('malformed run-stream row (invalid sequence) fails permanently without redis', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({
        eventId: EVT,
        sequence: -1,
        runId: RUN,
      }),
    });
    const publisher = new OutboxPublisher({ repository: repo, stream });
    const r1 = await publisher.publishOnce();
    assert.equal(r1.failed, 1);
    assert.equal(stream.appends.length, 0);
    // already FAILED — not claimed again
    const r2 = await publisher.publishOnce();
    assert.equal(r2.claimed, 0);
  });

  it('on Redis failure schedules retry and never mutates Run status', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    stream.failNextTimes(1);
    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.retried, 1);
    assert.equal(result.published, 0);
    assert.equal(stream.appends.length, 0);
    assert.equal(state.tables.domain_outbox[0].status, 'PENDING');
    assert.ok(state.tables.domain_outbox[0].last_error);
    assert.equal(state.tables.runs[0].status, 'RUNNING');
  });

  it('tolerates at-least-once republish with same stable eventId after crash recovery', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({ eventId: EVT, sequence: 1, runId: RUN }),
      status: 'PUBLISHING',
      claim_token: 'STALETOKENSTALETOKENSTALET',
      claimed_at: '2026-07-18 04:00:00.000',
      attempts: 1,
    });

    const publisher = new OutboxPublisher({ repository: repo, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.published, 1);
    assert.equal(stream.appends[0].fields.eventId, EVT);

    seedOutboxRow(state, {
      outbox_id: OB2,
      payload_json: JSON.stringify({ eventId: EVT, sequence: 1, runId: RUN }),
      created_at: '2026-07-18 04:32:00.000',
    });
    const result2 = await publisher.publishOnce();
    assert.equal(result2.published, 1);
    assert.equal(stream.appends[1].fields.eventId, EVT);
  });

  it('when markPublished returns false after Redis success, leaves PUBLISHING (ackMissed)', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({ eventId: EVT, sequence: 1, runId: RUN }),
    });

    let calls = 0;
    // Wrapper: prototype is frozen, so DI a thin repository facade.
    const facade = {
      claimBatch: (opts) => repo.claimBatch(opts),
      markPendingForRetry: (...args) => repo.markPendingForRetry(...args),
      markFailed: (...args) => repo.markFailed(...args),
      markPublished: async () => {
        calls += 1;
        // Token-loss / concurrent settle: leave row PUBLISHING for stale reclaim.
        return false;
      },
    };

    const publisher = new OutboxPublisher({ repository: facade, stream });
    const result = await publisher.publishOnce();
    assert.equal(result.published, 0);
    assert.equal(result.ackMissed, 1);
    assert.equal(stream.appends.length, 1);
    assert.equal(stream.appends[0].fields.eventId, EVT);
    // Row still PUBLISHING — recoverable via stale reclaim; at-least-once.
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHING');
    assert.equal(calls, 1);
    assert.equal(state.tables.runs[0].status, 'RUNNING');
  });

  it('when markPublished throws after Redis success, propagates and leaves PUBLISHING', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      payload_json: JSON.stringify({ eventId: EVT, sequence: 1, runId: RUN }),
    });

    const facade = {
      claimBatch: (opts) => repo.claimBatch(opts),
      markPendingForRetry: (...args) => repo.markPendingForRetry(...args),
      markFailed: (...args) => repo.markFailed(...args),
      markPublished: async () => {
        throw new Error('mysql connection lost during markPublished');
      },
    };

    const publisher = new OutboxPublisher({ repository: facade, stream });
    await assert.rejects(
      () => publisher.publishOnce(),
      /mysql connection lost during markPublished/,
    );
    assert.equal(stream.appends.length, 1);
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHING');
    assert.equal(state.tables.runs[0].status, 'RUNNING');
  });

  it('runLoop is bounded and stop() does not leak timers', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    seedOutboxRow(state, {
      outbox_id: OB2,
      created_at: '2026-07-18 04:31:23.000',
    });

    let sleepCalls = 0;
    /** @type {ReturnType<typeof setTimeout>[]} */
    const liveTimers = [];
    const sleep = (ms, signal) => {
      sleepCalls += 1;
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          const i = liveTimers.indexOf(t);
          if (i >= 0) liveTimers.splice(i, 1);
          resolve();
        }, ms);
        liveTimers.push(t);
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(t);
              const i = liveTimers.indexOf(t);
              if (i >= 0) liveTimers.splice(i, 1);
              resolve();
            },
            { once: true },
          );
        }
      });
    };

    const publisher = new OutboxPublisher({
      repository: repo,
      stream,
      batchSize: 1,
      maxPasses: 10,
      idleDelayMs: 50,
      sleep,
    });

    const loopPromise = publisher.runLoop({ maxPasses: 5 });
    await publisher.stop();
    const summary = await loopPromise;
    assert.ok(summary.passes >= 1);
    assert.ok(summary.passes <= 5);
    assert.equal(publisher.running, false);
    assert.equal(liveTimers.length, 0);
    void sleepCalls;
  });

  it('after max Redis failures marks FAILED without Run status change', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    const publisher = new OutboxPublisher({ repository: repo, stream });

    for (let i = 0; i < 3; i += 1) {
      for (const row of state.tables.domain_outbox) {
        if (row.status === 'PENDING') row.next_attempt_at = null;
      }
      stream.failNextTimes(1);
      await publisher.publishOnce();
    }

    assert.equal(state.tables.domain_outbox[0].status, 'FAILED');
    assert.equal(state.tables.runs[0].status, 'RUNNING');
    assert.equal(stream.appends.length, 0);
  });

  it('single pass API exists and is independent of loop lifecycle', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    const publisher = new OutboxPublisher({ repository: repo, stream });
    assert.equal(publisher.running, false);
    const once = await publisher.publishOnce();
    assert.equal(once.published, 1);
    assert.equal(publisher.running, false);
  });
});
