import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { InteractionResponseService } from '../../src/application/interaction-response-service.js';
import { CanonicalJsonError } from '../../src/application/errors.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'b'.repeat(32);
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};
const NOW = '2026-07-19 01:02:03.004';

function makeIdGenerator() {
  return createUlidGenerator({ now: () => 1_721_278_800_000 });
}

function seed(state, status = 'WAITING_INPUT', interactionStatus = 'PENDING') {
  state.tables.organizations = [
    {
      org_id: ORG,
      name: 'Acme',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.users = [
    {
      user_id: USER,
      external_subject: 'bff:user-ext-1',
      display_name: 'Test User',
      email: null,
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.organization_memberships = [
    {
      org_id: ORG,
      user_id: USER,
      role: 'member',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.organization_external_refs = [
    {
      provider: 'bff',
      external_subject: 'org-ext-1',
      org_id: ORG,
      created_at: NOW,
    },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status,
      status_reason: 'user interaction pending',
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      cancel_requested_by: null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.tool_executions = [
    {
      tool_execution_id: TOOL,
      run_id: RUN,
      agent_session_id: SESSION,
      tool_call_id: 'ask-user-1',
      tool_name: 'ask_user',
      tool_source: 'internal',
      risk_level: 'low',
      arguments_json: JSON.stringify({ interaction_type: 'select' }),
      result_json: null,
      status: 'RUNNING',
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
    },
  ];
  state.tables.run_interactions = [
    {
      interaction_id: INTERACTION,
      org_id: ORG,
      user_id: USER,
      run_id: RUN,
      agent_session_id: SESSION,
      tool_execution_id: TOOL,
      tool_call_id: 'ask-user-1',
      interaction_type: 'select',
      request_json: JSON.stringify({
        title: 'Choose a region',
        message: 'Where should we deploy?',
        options: ['eu', 'us'],
      }),
      status: interactionStatus,
      response_json: null,
      response_hash: null,
      responded_by: null,
      created_at: NOW,
      resolved_at: null,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}

describe('InteractionResponseService', () => {
  let state;
  let knex;
  let generateId;
  let queued;
  let service;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
    generateId = makeIdGenerator();
    queued = [];
    service = new InteractionResponseService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      runQueue: {
        async enqueue(ref) {
          queued.push(ref);
          return { id: ref.runId };
        },
      },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
  });

  it('resolves atomically, completes the tool, appends events, then wakes the Run', async () => {
    const result = await service.respond({
      auth: AUTH,
      runId: RUN,
      interactionId: INTERACTION,
      response: 'eu',
    });

    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.queued, true);
    assert.equal(result.resume_pending, false);
    assert.deepEqual(queued, [{ runId: RUN, orgId: ORG, traceId: TRACE }]);
    assert.equal(state.tables.run_interactions[0].status, 'RESOLVED');
    assert.equal(state.tables.tool_executions[0].status, 'SUCCEEDED');
    assert.equal(state.tables.run_events.length, 2);
    assert.deepEqual(
      state.tables.run_events.map((row) => row.event_type),
      ['tool.execution.completed', 'interaction.resolved'],
    );
    assert.equal(state.tables.domain_outbox.length, 2);
    assert.equal(
      JSON.parse(state.tables.domain_outbox[1].payload_json).data.respondedBy,
      USER,
    );
  });

  it('does not duplicate durable completion on an identical retry', async () => {
    const first = await service.respond({
      auth: AUTH,
      runId: RUN,
      interactionId: INTERACTION,
      response: 'eu',
    });
    const eventsAfterFirst = state.tables.run_events.length;
    const second = await service.respond({
      auth: AUTH,
      runId: RUN,
      interactionId: INTERACTION,
      response: 'eu',
    });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(state.tables.run_events.length, eventsAfterFirst);
    assert.equal(state.tables.domain_outbox.length, eventsAfterFirst);
    // A retry may enqueue another ref; the durable CAS remains the authority.
    assert.equal(queued.length, 2);
  });

  it('keeps the durable answer when Redis wake-up fails', async () => {
    service.runQueue.enqueue = async () => {
      throw new Error('redis unavailable: bearer secret=do-not-store');
    };
    const result = await service.respond({
      auth: AUTH,
      runId: RUN,
      interactionId: INTERACTION,
      response: 'us',
    });

    assert.equal(result.changed, true);
    assert.equal(result.queued, false);
    assert.equal(result.resume_pending, true);
    assert.doesNotMatch(result.resume_error, /secret=do-not-store/i);
    assert.equal(state.tables.run_interactions[0].status, 'RESOLVED');
    assert.equal(state.tables.tool_executions[0].status, 'SUCCEEDED');
  });

  it('rejects a multibyte response that exceeds the canonical byte limit', async () => {
    state.tables.run_interactions[0].interaction_type = 'input';

    await assert.rejects(
      () =>
        service.respond({
          auth: AUTH,
          runId: RUN,
          interactionId: INTERACTION,
          response: '界'.repeat(32 * 1024),
        }),
      (error) => {
        assert.ok(error instanceof CanonicalJsonError);
        assert.match(error.message, /response_json is invalid/i);
        return true;
      },
    );
    assert.equal(state.tables.run_interactions[0].status, 'PENDING');
    assert.equal(state.tables.tool_executions[0].status, 'RUNNING');
  });

  it('rehydrates pending and resolved rows with different wake behavior', async () => {
    const pending = await service.rehydrateWaiting({ auth: AUTH, runId: RUN });
    assert.deepEqual(pending.items[0], {
      run_id: RUN,
      status: 'waiting_input',
      interaction_id: INTERACTION,
      interaction_type: 'select',
      title: 'Choose a region',
      message: 'Where should we deploy?',
      options: ['eu', 'us'],
      resolved: false,
      queued: false,
      resume_pending: false,
      resume_error: null,
    });

    state.tables.run_interactions[0].status = 'RESOLVED';
    state.tables.run_interactions[0].response_json = JSON.stringify('eu');
    state.tables.run_interactions[0].response_hash = 'a'.repeat(64);
    const resolved = await service.rehydrateWaiting({ auth: AUTH, runId: RUN });
    assert.equal(resolved.items[0].resolved, true);
    assert.equal(resolved.items[0].queued, true);
    assert.equal(queued.length, 1);
  });

  it('rejects a pending interaction when the Run is no longer parked', async () => {
    state.tables.runs[0].status = 'RUNNING';
    await assert.rejects(
      () =>
        service.respond({
          auth: AUTH,
          runId: RUN,
          interactionId: INTERACTION,
          response: 'eu',
        }),
      ConflictError,
    );
    assert.equal(state.tables.run_interactions[0].status, 'PENDING');
    assert.equal(state.tables.tool_executions[0].status, 'RUNNING');
  });
});
