import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { CancelRunService } from '../../src/application/cancel-run-service.js';
import { InteractionResponseService } from '../../src/application/interaction-response-service.js';
import { RunRecoveryService } from '../../src/application/run-recovery-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'b'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};

function seed(state, interactionStatus = 'PENDING', toolStatus = 'RUNNING') {
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
      conversation_id: CONVERSATION,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status: RUN_STATUS.WAITING_INPUT,
      status_reason: 'user interaction pending',
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      trace_state: null,
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
      result_json:
        interactionStatus === 'RESOLVED'
          ? JSON.stringify({ interactionId: INTERACTION, response: 'eu' })
          : null,
      status: toolStatus,
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: NOW,
      completed_at: interactionStatus === 'RESOLVED' ? NOW : null,
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
      response_json:
        interactionStatus === 'RESOLVED' ? JSON.stringify('eu') : null,
      response_hash: interactionStatus === 'RESOLVED' ? 'a'.repeat(64) : null,
      responded_by: interactionStatus === 'RESOLVED' ? USER : null,
      resume_phase: interactionStatus === 'RESOLVED' ? 'READY' : 'NONE',
      resume_claimed_at: null,
      resume_applied_at: null,
      cancelled_at: null,
      created_at: NOW,
      resolved_at: interactionStatus === 'RESOLVED' ? NOW : null,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
  state.tables.trace_spans = [];
}

describe('CancelRunService parked interaction transaction', () => {
  let state;
  let knex;
  let generateId;
  let enqueued;
  let cancelSignals;
  let createRepositories;
  let cancel;
  let respond;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
    generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    enqueued = [];
    cancelSignals = [];
    createRepositories = (db) =>
      createRepositoryBundle(db, {
        now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
        generateId,
      });
    const transactionManager = { run: (fn) => knex.transaction(fn) };
    const runQueue = {
      async enqueue(ref, options) {
        enqueued.push({ ref, options });
        return { id: options?.jobId ?? ref.runId };
      },
    };
    cancel = new CancelRunService({
      transactionManager,
      createRepositories,
      cancelSignal: {
        async request(runId, meta) {
          cancelSignals.push({ runId, meta });
        },
      },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
    respond = new InteractionResponseService({
      transactionManager,
      createRepositories,
      runQueue,
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
  });

  it('cancels the Run, pending interaction, and ask_user tool atomically and once', async () => {
    const first = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'user requested',
    });

    assert.equal(first.status, RUN_STATUS.CANCELLED);
    assert.equal(first.terminal, true);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.run_interactions[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].error_code, 'RUN_CANCELLED');
    assert.ok(state.tables.run_interactions[0].cancelled_at);
    assert.ok(state.tables.tool_executions[0].completed_at);
    assert.deepEqual(
      state.tables.run_events.map((row) => row.event_type),
      [
        'interaction.cancelled',
        'tool.execution.failed',
        'run.status.changed',
        'run.status.changed',
        'run.cancelled',
      ],
    );
    assert.deepEqual(
      state.tables.domain_outbox.map((row) => row.event_type),
      state.tables.run_events.map((row) => row.event_type),
    );
    assert.equal(cancelSignals.length, 0);

    const eventCount = state.tables.run_events.length;
    const outboxCount = state.tables.domain_outbox.length;
    const repeated = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'different retry reason',
    });
    assert.equal(repeated.status, RUN_STATUS.CANCELLED);
    assert.equal(repeated.cancelRequested, true);
    assert.equal(state.tables.run_events.length, eventCount);
    assert.equal(state.tables.domain_outbox.length, outboxCount);
    assert.equal(state.tables.runs[0].cancel_reason, 'user requested');
    assert.equal(cancelSignals.length, 0);
  });

  it('rejects a response after cancellation without reviving or re-enqueueing the Run', async () => {
    await cancel.execute({ runId: RUN, auth: AUTH, reason: 'stop' });

    await assert.rejects(
      () =>
        respond.respond({
          auth: AUTH,
          runId: RUN,
          interactionId: INTERACTION,
          response: 'eu',
        }),
      ConflictError,
    );
    assert.equal(state.tables.runs[0].status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.run_interactions[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].status, 'CANCELLED');
    assert.equal(enqueued.length, 0);
  });

  it('preserves a response that won the lock race, then recovery does not enqueue the cancelled Run', async () => {
    const answered = await respond.respond({
      auth: AUTH,
      runId: RUN,
      interactionId: INTERACTION,
      response: 'eu',
    });
    assert.equal(answered.changed, true);
    assert.equal(enqueued.length, 1);

    const cancelled = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'cancel after answer',
    });
    assert.equal(cancelled.status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.run_interactions[0].status, 'RESOLVED');
    assert.equal(state.tables.tool_executions[0].status, 'SUCCEEDED');

    const jobsBeforeRecovery = enqueued.length;
    const recovery = new RunRecoveryService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories,
      runQueue: {
        async enqueue(ref, options) {
          enqueued.push({ ref, options });
        },
      },
      generateId,
    });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'skipped');
    assert.equal(action.reason, 'terminal');
    assert.equal(enqueued.length, jobsBeforeRecovery);
  });

  it('rolls back intent, ledgers, events, and Run status when outbox persistence fails', async () => {
    createRepositories = (db) => {
      const repos = createRepositoryBundle(db, {
        now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
        generateId,
      });
      const insert = repos.outbox.insert.bind(repos.outbox);
      return {
        ...repos,
        outbox: {
          async insert(input) {
            if (input.eventType === 'interaction.cancelled') {
              throw new Error('outbox unavailable');
            }
            return insert(input);
          },
        },
      };
    };
    cancel = new CancelRunService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories,
      cancelSignal: { async request() {} },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });

    await assert.rejects(
      () => cancel.execute({ runId: RUN, auth: AUTH, reason: 'stop' }),
      /outbox unavailable/,
    );
    assert.equal(state.tables.runs[0].status, RUN_STATUS.WAITING_INPUT);
    assert.equal(state.tables.runs[0].cancel_requested_at, null);
    assert.equal(state.tables.run_interactions[0].status, 'PENDING');
    assert.equal(state.tables.tool_executions[0].status, 'RUNNING');
    assert.equal(state.tables.run_events.length, 0);
    assert.equal(state.tables.domain_outbox.length, 0);
  });
});
