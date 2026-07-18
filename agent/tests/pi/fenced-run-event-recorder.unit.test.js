/**
 * FencedRunEventRecorder offline tests (PR-06).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import {
  FencedRunEventRecorder,
  buildCanonicalEnvelope,
  redactEventData,
} from '../../src/application/fenced-run-event-recorder.js';
import { SessionFenceConflictError } from '../../src/domain/session/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const TRACE = 'b'.repeat(32);

describe('buildCanonicalEnvelope / redactEventData', () => {
  it('builds plan §15.3 envelope shape', () => {
    const env = buildCanonicalEnvelope({
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
      sequence: 18,
      type: 'tool.execution.completed',
      timestamp: new Date('2026-07-18T04:31:22.417Z'),
      context: {
        orgId: ORG,
        userId: USER,
        conversationId: CONV,
        agentSessionId: SESS,
        runId: RUN,
        traceId: TRACE,
        spanId: '91',
      },
      data: { toolName: 'bash' },
    });
    assert.equal(env.eventVersion, 1);
    assert.equal(env.sequence, 18);
    assert.equal(env.type, 'tool.execution.completed');
    assert.equal(env.context.orgId, ORG);
    assert.equal(env.context.spanId, '91');
    assert.equal(env.data.toolName, 'bash');
    assert.ok(Object.isFrozen(env));
  });

  it('redacts secret-looking fields', () => {
    const r = redactEventData({
      apiKey: 'sk-live-secret',
      note: 'Bearer abcdefghijklmnop',
      ok: true,
    });
    assert.equal(r.apiKey, '[redacted]');
    assert.match(String(r.note), /redacted/i);
    assert.equal(r.ok, true);
  });
});

describe('FencedRunEventRecorder', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    state.tables.agent_sessions = [
      {
        agent_session_id: SESS,
        org_id: ORG,
        user_id: USER,
        conversation_id: CONV,
        agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
        sandbox_session_id: '01K0G2PAV8FPMVC9QHJG7JPN5F',
        workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
        status: 'ACTIVE',
        pi_session_version: 0,
        last_run_id: RUN,
        execution_fence_token: 7,
        recovery_reason_code: null,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
        closed_at: null,
      },
    ];
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        conversation_id: CONV,
        agent_session_id: SESS,
        agent_version_id: '01K0G2PAV8FPMVC9QHJG7JPN5E',
        triggering_message_id: '01K0G2PAV8FPMVC9QHJG7JPN5J',
        source: 'api',
        status: 'RUNNING',
        status_reason: null,
        queue_name: 'runs',
        attempt: 1,
        trace_id: TRACE,
        next_event_sequence: 0,
        cancel_requested_at: null,
        cancel_reason: null,
        started_at: '2026-07-18 00:00:00.000',
        completed_at: null,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.run_events = [];
    state.tables.domain_outbox = [];
  });

  function makeRecorder(opts = {}) {
    /** @type {object[]} */
    const emitted = [];
    const recorder = new FencedRunEventRecorder({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(),
          generateId: nextId,
        }),
      generateId: nextId,
      context: {
        orgId: ORG,
        userId: USER,
        conversationId: CONV,
        agentSessionId: SESS,
        runId: RUN,
        traceId: TRACE,
      },
      executionFenceToken: 7,
      now: () => new Date('2026-07-18T04:31:22.417Z'),
      emit: async (env) => {
        emitted.push(env);
      },
      isLockLost: opts.isLockLost ?? (() => false),
    });
    return { recorder, emitted };
  }

  it('records with fence + run_events + outbox and emits only after commit', async () => {
    const { recorder, emitted } = makeRecorder();
    const env = await recorder.record({
      type: 'model.request.started',
      data: { correlationId: 'prov:1' },
    });
    assert.ok(env);
    assert.equal(env.type, 'model.request.started');
    assert.equal(env.eventVersion, 1);
    assert.equal(env.sequence, 1);
    assert.equal(env.context.runId, RUN);
    assert.equal(env.context.traceId, TRACE);
    assert.equal(env.data.correlationId, 'prov:1');
    assert.equal(state.tables.run_events.length, 1);
    assert.equal(state.tables.domain_outbox.length, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].eventId, env.eventId);
    // outbox carries full envelope
    const ob = state.tables.domain_outbox[0];
    const payload =
      typeof ob.payload_json === 'string'
        ? JSON.parse(ob.payload_json)
        : ob.payload_json;
    assert.equal(payload.sequence, 1);
    assert.equal(payload.context.orgId, ORG);
  });

  it('dedupes by stable key (no double write)', async () => {
    const { recorder, emitted } = makeRecorder();
    const a = await recorder.record({
      type: 'tool.execution.started',
      data: { toolCallId: 't1' },
      dedupeKey: 'tool.execution.started:t1',
    });
    const b = await recorder.record({
      type: 'tool.execution.started',
      data: { toolCallId: 't1' },
      dedupeKey: 'tool.execution.started:t1',
    });
    assert.ok(a);
    assert.equal(b, null);
    assert.equal(state.tables.run_events.length, 1);
    assert.equal(emitted.length, 1);
  });

  it('refuses write when lock lost', async () => {
    const { recorder, emitted } = makeRecorder({
      isLockLost: () => true,
    });
    await assert.rejects(
      () => recorder.record({ type: 'error.occurred', data: {} }),
      SessionFenceConflictError,
    );
    assert.equal(state.tables.run_events.length, 0);
    assert.equal(emitted.length, 0);
  });

  it('does not emit when transaction fails (fence mismatch)', async () => {
    state.tables.agent_sessions[0].execution_fence_token = 99;
    const { recorder, emitted } = makeRecorder();
    await assert.rejects(
      () => recorder.record({ type: 'message.completed', data: {} }),
      /fence|Fence|conflict|token|ACTIVE/i,
    );
    assert.equal(emitted.length, 0);
  });

  it('preserves order across sequential records', async () => {
    const { recorder } = makeRecorder();
    const e1 = await recorder.record({ type: 'model.request.started', data: {} });
    const e2 = await recorder.record({
      type: 'model.request.completed',
      data: {},
    });
    assert.equal(e1.sequence, 1);
    assert.equal(e2.sequence, 2);
  });

  it('concurrent same dedupeKey writes only one durable event', async () => {
    const { recorder } = makeRecorder();
    const key = 'tool.execution.started:concurrent-1';
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        recorder.record({
          type: 'tool.execution.started',
          data: { toolCallId: 'concurrent-1' },
          dedupeKey: key,
        }),
      ),
    );
    const nonNull = results.filter((r) => r != null);
    // One owner returns envelope; joiners resolve to same envelope (or null path).
    // Durable rows must be exactly one.
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.started',
      ).length,
      1,
    );
    assert.ok(nonNull.length >= 1);
    // All non-null results share the same eventId
    const ids = new Set(nonNull.map((r) => r.eventId));
    assert.equal(ids.size, 1);
  });

  it('failed pending dedupe allows retry', async () => {
    state.tables.agent_sessions[0].execution_fence_token = 99;
    const { recorder } = makeRecorder();
    await assert.rejects(
      () =>
        recorder.record({
          type: 'error.occurred',
          data: {},
          dedupeKey: 'retry-key',
        }),
      /fence|Fence|conflict|token|ACTIVE/i,
    );
    // Restore fence and retry same key
    state.tables.agent_sessions[0].execution_fence_token = 7;
    const env = await recorder.record({
      type: 'error.occurred',
      data: { ok: true },
      dedupeKey: 'retry-key',
    });
    assert.ok(env);
    assert.equal(state.tables.run_events.length, 1);
  });
});
