/**
 * Prove observability + session subscriber do not double-write when
 * recorder dedupe keys are used (PR-06 event ownership).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedRunEventRecorder } from '../../src/application/fenced-run-event-recorder.js';
import { createObservabilityExtension } from '../../src/extensions/observability/index.js';
import { PlatformEventProjector } from '../../src/infrastructure/pi/platform-event-projector.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const TRACE = 'b'.repeat(32);

describe('observability vs projector double-write guard', () => {
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
        sandbox_session_id: null,
        workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
        status: 'ACTIVE',
        pi_session_version: 0,
        last_run_id: RUN,
        execution_fence_token: 1,
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

  it('dedupe prevents double tool.execution.started from obs + projector', async () => {
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
      executionFenceToken: 1,
    });

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    };
    const obs = createObservabilityExtension({
      runContext: {
        orgId: ORG,
        userId: USER,
        conversationId: CONV,
        agentSessionId: SESS,
        runId: RUN,
        sandboxSessionId: null,
        traceId: TRACE,
      },
      deps: { recorder },
    });
    await obs(pi);

    const toolEvent = {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
    };

    // Observability path
    for (const h of handlers.get('tool_execution_start') || []) {
      await h(toolEvent);
    }

    // Simulated session subscriber projector path with same dedupe key scheme
    const projector = new PlatformEventProjector();
    const projected = projector.project(toolEvent, {
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: SESS,
      runId: RUN,
      traceId: TRACE,
    });
    await recorder.recordProjected(projected, {
      dedupeKeyFor: (ev) => {
        const p = ev.payload || {};
        if (ev.type.startsWith('tool.') && p.toolCallId) {
          return `${ev.type}:${p.toolCallId}`;
        }
        return null;
      },
    });

    const started = state.tables.run_events.filter(
      (e) => e.event_type === 'tool.execution.started',
    );
    assert.equal(started.length, 1, 'exactly one durable tool.execution.started');
  });
});
