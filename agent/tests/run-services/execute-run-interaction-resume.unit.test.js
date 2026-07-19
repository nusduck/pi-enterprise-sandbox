import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { ExecuteRunService } from '../../src/application/execute-run-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'c'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const SCOPE = { orgId: ORG, userId: USER };

function seed(state, interactionStatus, toolStatus = 'SUCCEEDED') {
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
      status: RUN_STATUS.WAITING_INPUT,
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
      arguments_json: JSON.stringify({ interaction_type: 'input' }),
      result_json: JSON.stringify({ interactionId: INTERACTION, response: 'yes' }),
      status: toolStatus,
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: NOW,
      completed_at: NOW,
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
      interaction_type: 'input',
      request_json: JSON.stringify({ title: 'Need confirmation' }),
      status: interactionStatus,
      response_json:
        interactionStatus === 'RESOLVED' ? JSON.stringify('yes') : null,
      response_hash: interactionStatus === 'RESOLVED' ? 'd'.repeat(64) : null,
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

function makeLease() {
  const owners = new Map();
  return {
    async acquire(runId, owner) {
      if (owners.has(runId)) return false;
      owners.set(runId, owner);
      return true;
    },
    async renew(runId, owner) {
      return owners.get(runId) === owner;
    },
    async release(runId, owner) {
      if (owners.get(runId) !== owner) return false;
      owners.delete(runId);
      return true;
    },
  };
}

describe('ExecuteRunService WAITING_INPUT resume', () => {
  let state;
  let knex;
  let generateId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  });

  function build(interactionStatus, toolStatus, executor) {
    seed(state, interactionStatus, toolStatus);
    return new ExecuteRunService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      leaseManager: makeLease(),
      runExecutorFactory: () => executor,
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
      leaseRenewIntervalMs: 60_000,
      cancelPollIntervalMs: 60_000,
    });
  }

  it('leaves the Run parked and does not invoke the executor while input is pending', async () => {
    let calls = 0;
    const executor = {
      async execute() {
        calls += 1;
        return { outcome: RUN_STATUS.SUCCEEDED };
      },
      async dispose() {},
    };
    const service = build('PENDING', 'RUNNING', executor);
    const result = await service.execute({
      runId: RUN,
      orgId: ORG,
      traceId: TRACE,
      workerId: 'worker-pending',
    });

    assert.equal(result.status, RUN_STATUS.WAITING_INPUT);
    assert.equal(result.outcome, RUN_STATUS.WAITING_INPUT);
    assert.equal(result.needsReconciliation, false);
    assert.equal(calls, 0);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.WAITING_INPUT);
  });

  it('claims only a resolved interaction, passes its continuation context, then completes', async () => {
    const seen = [];
    const executor = {
      async execute(ctx) {
        seen.push(ctx);
        return { outcome: RUN_STATUS.SUCCEEDED };
      },
      async dispose() {},
    };
    const service = build('RESOLVED', 'SUCCEEDED', executor);
    const result = await service.execute({
      runId: RUN,
      orgId: ORG,
      traceId: TRACE,
      workerId: 'worker-resume',
    });

    assert.equal(result.status, RUN_STATUS.SUCCEEDED);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.SUCCEEDED);
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].run.interactionResume, {
      interactionId: INTERACTION,
      status: 'RESOLVED',
      interactionType: 'input',
      response: 'yes',
      responseHash: 'd'.repeat(64),
      resumePhase: 'CLAIMED',
      toolExecutionId: TOOL,
      toolCallId: 'ask-user-1',
      toolName: 'ask_user',
    });
    assert.ok(
      state.tables.run_events.some(
        (row) =>
          row.event_type === 'run.status.changed' &&
          JSON.parse(row.payload_json).to === RUN_STATUS.RUNNING,
      ),
      'resume claims WAITING_INPUT → RUNNING durably before execution',
    );
    assert.ok(
      state.tables.run_events.some((row) => row.event_type === 'run.completed'),
    );
  });

  it('fails closed when the interaction is resolved but its tool ledger is not terminal-success', async () => {
    let calls = 0;
    const executor = {
      async execute() {
        calls += 1;
        return { outcome: RUN_STATUS.SUCCEEDED };
      },
      async dispose() {},
    };
    const service = build('RESOLVED', 'RUNNING', executor);
    const result = await service.execute({
      runId: RUN,
      orgId: ORG,
      traceId: TRACE,
      workerId: 'worker-invalid',
    });

    assert.equal(result.status, RUN_STATUS.WAITING_INPUT);
    assert.equal(result.needsReconciliation, true);
    assert.match(result.error, /not resumable/i);
    assert.equal(calls, 0);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.WAITING_INPUT);
  });
});
