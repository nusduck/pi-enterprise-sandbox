import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { ApprovalDecisionService } from '../../src/application/approval-decision-service.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN54';
const APPROVAL = '01K0G2PAV8FPMVC9QHJG7JPN55';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN56';
const MESSAGE = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'a'.repeat(32);
const AUTH = Object.freeze({
  provider: 'bff',
  externalOrgId: 'org-ext',
  externalUserId: 'user-ext',
});
const NOW = '2026-07-18 06:00:00.000';

function seedWorld(state) {
  state.tables.organizations = [
    {
      org_id: ORG,
      name: 'Acme',
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.organization_external_refs = [
    {
      provider: 'bff',
      external_subject: 'org-ext',
      org_id: ORG,
      created_at: NOW,
    },
  ];
  state.tables.users = [
    {
      user_id: USER,
      external_subject: 'bff:user-ext',
      display_name: 'Owner',
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
      role: 'owner',
      status: 'active',
      created_at: NOW,
    },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VERSION,
      triggering_message_id: MESSAGE,
      source: 'api',
      status: 'WAITING_APPROVAL',
      status_reason: 'approval pending',
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      next_event_sequence: 0,
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
      agent_session_id: SESS,
      tool_call_id: 'call-original',
      tool_name: 'mcp__crm__delete',
      tool_source: 'mcp',
      risk_level: 'high',
      arguments_json: JSON.stringify({ id: 'customer-1' }),
      result_json: null,
      status: 'WAITING_APPROVAL',
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: null,
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
      status: 'PENDING',
      request_json: JSON.stringify({ toolCallId: 'call-original' }),
      decision_reason: null,
      expires_at: null,
      created_at: NOW,
      decided_at: null,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}

describe('ApprovalDecisionService', () => {
  let state;
  let knex;
  let queueCalls;
  let queueFailure;
  let failResolvedOutbox;
  let service;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    queueCalls = [];
    queueFailure = null;
    failResolvedOutbox = false;
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    service = new ApprovalDecisionService({
      transactionManager: { run: (work) => knex.transaction(work) },
      createRepositories(db) {
        const repos = createRepositoryBundle(db, {
          now: () => new Date('2026-07-18T06:00:00.000Z'),
          generateId,
        });
        if (!failResolvedOutbox) return repos;
        return {
          ...repos,
          outbox: {
            async insert(input) {
              if (input.eventType === 'approval.resolved') {
                throw new Error('injected resolved outbox failure');
              }
              return repos.outbox.insert(input);
            },
          },
        };
      },
      runQueue: {
        async enqueue(ref) {
          if (queueFailure) throw queueFailure;
          queueCalls.push(ref);
        },
      },
      generateId,
      now: () => new Date('2026-07-18T06:00:00.000Z'),
    });
  });

  it('resolves once, treats the same decision as idempotent, and conflicts on reversal', async () => {
    const first = await service.resolve({
      approvalId: APPROVAL,
      decision: 'approve',
      auth: AUTH,
    });
    const replay = await service.resolve({
      approvalId: APPROVAL,
      decision: 'approve',
      auth: AUTH,
    });

    assert.equal(first.changed, true);
    assert.equal(first.status, 'approved');
    assert.equal(replay.changed, false);
    assert.equal(state.tables.approvals[0].status, 'APPROVED');
    assert.equal(state.tables.tool_executions[0].status, 'WAITING_APPROVAL');
    assert.equal(
      state.tables.run_events.filter((row) => row.event_type === 'approval.resolved').length,
      1,
    );
    assert.equal(
      state.tables.domain_outbox.filter((row) => row.event_type === 'approval.resolved').length,
      1,
    );
    assert.equal(queueCalls.length, 2);

    await assert.rejects(
      () =>
        service.resolve({
          approvalId: APPROVAL,
          decision: 'reject',
          auth: AUTH,
        }),
      ConflictError,
    );
  });

  it('rejects without executing the tool and terminalizes its ledger atomically', async () => {
    const result = await service.resolve({
      approvalId: APPROVAL,
      decision: 'reject',
      reason: 'not authorized',
      auth: AUTH,
    });

    assert.equal(result.status, 'rejected');
    assert.equal(state.tables.approvals[0].status, 'REJECTED');
    assert.equal(state.tables.tool_executions[0].status, 'FAILED');
    assert.equal(state.tables.tool_executions[0].error_code, 'APPROVAL_REJECTED');
    assert.equal(
      state.tables.run_events.filter((row) => row.event_type === 'tool.execution.failed').length,
      1,
    );
  });

  it('keeps the terminal MySQL decision when Redis enqueue fails', async () => {
    queueFailure = new Error('redis unavailable');
    const result = await service.resolve({
      approvalId: APPROVAL,
      decision: 'approve',
      auth: AUTH,
    });

    assert.equal(result.resumePending, true);
    assert.equal(result.queued, false);
    assert.equal(state.tables.approvals[0].status, 'APPROVED');
    assert.equal(state.tables.run_events[0].event_type, 'approval.resolved');
  });

  it('rolls back the decision and event if its outbox append fails', async () => {
    failResolvedOutbox = true;
    await assert.rejects(
      () =>
        service.resolve({
          approvalId: APPROVAL,
          decision: 'approve',
          auth: AUTH,
        }),
      /injected resolved outbox failure/,
    );

    assert.equal(state.tables.approvals[0].status, 'PENDING');
    assert.equal(state.tables.run_events.length, 0);
    assert.equal(state.tables.domain_outbox.length, 0);
    assert.equal(queueCalls.length, 0);
  });

  it('hides foreign approvals and Runs and refuses to resume pending approval', async () => {
    const foreign = { ...AUTH, externalUserId: 'foreign-user' };
    await assert.rejects(
      () =>
        service.resolve({
          approvalId: APPROVAL,
          decision: 'approve',
          auth: foreign,
        }),
      OwnerScopedNotFoundError,
    );
    await assert.rejects(
      () => service.resume({ runId: RUN, approvalId: APPROVAL, auth: foreign }),
      OwnerScopedNotFoundError,
    );
    await assert.rejects(
      () => service.resume({ runId: RUN, approvalId: APPROVAL, auth: AUTH }),
      ConflictError,
    );
    assert.equal(queueCalls.length, 0);
  });
});
