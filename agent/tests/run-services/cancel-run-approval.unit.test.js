/**
 * Parked WAITING_APPROVAL cancel (docs/2026-07-29-waiting-approval-bugs.md).
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { CancelRunService } from '../../src/application/cancel-run-service.js';
import { RunRecoveryService } from '../../src/application/run-recovery-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const APPROVAL = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'b'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};

function seed(state, { approvalStatus = 'PENDING', toolStatus = 'WAITING_APPROVAL' } = {}) {
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
      status: RUN_STATUS.WAITING_APPROVAL,
      status_reason: 'approval pending',
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
      tool_call_id: 'mcp-call-1',
      tool_name: 'mcp__exa__web_search_exa',
      tool_source: 'mcp',
      risk_level: 'high',
      arguments_json: JSON.stringify({ query: 'x' }),
      result_json: null,
      status: toolStatus,
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
  state.tables.approvals = [
    {
      approval_id: APPROVAL,
      org_id: ORG,
      run_id: RUN,
      tool_execution_id: TOOL,
      requested_by: USER,
      decision_by: null,
      status: approvalStatus,
      request_json: JSON.stringify({ toolCallId: 'mcp-call-1' }),
      decision_reason: null,
      expires_at: null,
      created_at: NOW,
      decided_at: null,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
  state.tables.trace_spans = [];
}

describe('CancelRunService parked WAITING_APPROVAL', () => {
  let state;
  let knex;
  let generateId;
  let cancelSignals;
  let createRepositories;
  let cancel;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
    generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    cancelSignals = [];
    createRepositories = (db) =>
      createRepositoryBundle(db, {
        now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
        generateId,
      });
    cancel = new CancelRunService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories,
      cancelSignal: {
        async request(runId, meta) {
          cancelSignals.push({ runId, meta });
        },
      },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
  });

  it('cancels the Run, PENDING approval, and tool atomically', async () => {
    const first = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'user cancelled while waiting approval',
    });

    assert.equal(first.status, RUN_STATUS.CANCELLED);
    assert.equal(first.terminal, true);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.approvals[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].error_code, 'RUN_CANCELLED');
    assert.ok(state.tables.tool_executions[0].completed_at);
    assert.ok(
      state.tables.run_events.some((e) => e.event_type === 'approval.resolved'),
    );
    assert.ok(
      state.tables.run_events.some((e) => e.event_type === 'run.cancelled'),
    );
    // Terminalized in API txn — no Redis cancel signal needed.
    assert.equal(cancelSignals.length, 0);

    const eventCount = state.tables.run_events.length;
    const repeated = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'retry',
    });
    assert.equal(repeated.status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.run_events.length, eventCount);
  });

  it('cancels APPROVED-but-unexecuted tool when cancel wins after approve', async () => {
    seed(state, { approvalStatus: 'APPROVED', toolStatus: 'WAITING_APPROVAL' });
    state.tables.approvals[0].decision_by = USER;
    state.tables.approvals[0].decided_at = NOW;

    const result = await cancel.execute({
      runId: RUN,
      auth: AUTH,
      reason: 'cancel after approve',
    });
    assert.equal(result.status, RUN_STATUS.CANCELLED);
    // Historical APPROVED fact preserved; tool is cancelled so no side effect.
    assert.equal(state.tables.approvals[0].status, 'APPROVED');
    assert.equal(state.tables.tool_executions[0].status, 'CANCELLED');
  });

  it('recovery terminalizes WAITING_APPROVAL when cancel intent is set', async () => {
    // Simulate the pre-fix stuck state: intent written, status still parked.
    state.tables.runs[0].cancel_requested_at = NOW;
    state.tables.runs[0].cancel_reason = 'stuck intent';
    state.tables.runs[0].cancel_requested_by = USER;

    const recovery = new RunRecoveryService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories,
      runQueue: { async enqueue() {} },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'terminalized');
    assert.equal(state.tables.runs[0].status, RUN_STATUS.CANCELLED);
    assert.equal(state.tables.approvals[0].status, 'CANCELLED');
    assert.equal(state.tables.tool_executions[0].status, 'CANCELLED');
  });
});
