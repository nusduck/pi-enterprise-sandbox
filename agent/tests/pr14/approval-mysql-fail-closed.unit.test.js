/**
 * PR-14 offline: approval decision idempotency + MySQL fail-closed authority.
 *
 * - decideIf CAS: terminal decision is sticky; second decide is no-op or conflict
 * - getOrCreatePending: one lifecycle per tool execution
 * - cross-tenant / cross-user approval access fail-closed
 * - transaction failure leaves no partial approval row
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { APPROVAL_STATUS } from '../../src/domain/tool/approval-status.js';
import {
  ConflictError,
  NotFoundError,
} from '../../src/infrastructure/mysql/errors.js';
import {
  CreateRunService,
  QUEUE_WARNING,
} from '../../src/application/index.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from '../run-services/helpers/fake-run-world.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN99';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const TRACE32 = 'b'.repeat(32);
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';

function seedWorld(state) {
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: VER,
      triggering_message_id: '01K0G2PAV8FPMVC9QHJG7JPN5J',
      source: 'api',
      status: 'RUNNING',
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE32,
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      started_at: '2026-07-18 00:00:00.000',
      completed_at: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
    },
  ];
  state.tables.agent_sessions = [
    {
      agent_session_id: SESS,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_version_id: VER,
      sandbox_session_id: SBX,
      workspace_id: WSP,
      status: 'ACTIVE',
      pi_session_version: 0,
      last_run_id: RUN,
      execution_fence_token: 3,
      recovery_reason_code: null,
      created_at: '2026-07-18 00:00:00.000',
      updated_at: '2026-07-18 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.tool_executions = [];
  state.tables.approvals = [];
  state.tables.sandbox_audit_events = [];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}

describe('PR-14 approval decide CAS + tenant isolation', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {() => string} */
  let nextId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  });

  it('duplicate decide on same approval: first wins; second is sticky no-op or conflict', async () => {
    const repos = createRepositoryBundle(knex, {
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      generateId: nextId,
    });
    const te = await repos.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-decide',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'high',
      argumentsJson: { command: 'rm -rf /' },
      traceId: TRACE32,
      orgId: ORG,
      userId: USER,
    });
    const teId = te.toolExecution.toolExecutionId;
    const approvalId = nextId();
    const created = await repos.approvals.getOrCreatePending({
      approvalId,
      orgId: ORG,
      userId: USER,
      runId: RUN,
      toolExecutionId: teId,
      requestedBy: USER,
      requestJson: { tool: 'bash' },
    });
    assert.equal(created.created, true);
    assert.equal(created.approval.status, APPROVAL_STATUS.PENDING);

    const first = await repos.approvals.decideIf({
      approvalId,
      orgId: ORG,
      userId: USER,
      toStatus: APPROVAL_STATUS.APPROVED,
      decisionBy: USER,
      decisionReason: 'ok',
    });
    assert.equal(first.changed, true);
    assert.equal(first.approval.status, APPROVAL_STATUS.APPROVED);

    // Same decision again → sticky no-op (changed=false)
    const second = await repos.approvals.decideIf({
      approvalId,
      orgId: ORG,
      userId: USER,
      toStatus: APPROVAL_STATUS.APPROVED,
      decisionBy: USER,
    });
    assert.equal(second.changed, false);
    assert.equal(second.approval.status, APPROVAL_STATUS.APPROVED);

    // Opposite decision after terminal → ConflictError (no flip-flop side effect)
    await assert.rejects(
      () =>
        repos.approvals.decideIf({
          approvalId,
          orgId: ORG,
          userId: USER,
          toStatus: APPROVAL_STATUS.REJECTED,
          decisionBy: USER,
        }),
      ConflictError,
    );
    assert.equal(state.tables.approvals.length, 1);
    assert.equal(state.tables.approvals[0].status, APPROVAL_STATUS.APPROVED);
  });

  it('getOrCreatePending twice returns same approval; no second row', async () => {
    const repos = createRepositoryBundle(knex, {
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      generateId: nextId,
    });
    const te = await repos.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-idem',
      toolName: 'http',
      toolSource: 'mcp',
      riskLevel: 'high',
      argumentsJson: { url: 'https://x' },
      traceId: TRACE32,
      orgId: ORG,
      userId: USER,
    });
    const teId = te.toolExecution.toolExecutionId;
    const a1 = await repos.approvals.getOrCreatePending({
      approvalId: nextId(),
      orgId: ORG,
      userId: USER,
      runId: RUN,
      toolExecutionId: teId,
      requestedBy: USER,
      requestJson: { tool: 'http' },
    });
    const a2 = await repos.approvals.getOrCreatePending({
      approvalId: nextId(),
      orgId: ORG,
      userId: USER,
      runId: RUN,
      toolExecutionId: teId,
      requestedBy: USER,
      requestJson: { tool: 'http' },
    });
    assert.equal(a1.created, true);
    assert.equal(a2.created, false);
    assert.equal(a1.approval.approvalId, a2.approval.approvalId);
    assert.equal(state.tables.approvals.length, 1);
  });

  it('foreign user cannot get/decide approval', async () => {
    const repos = createRepositoryBundle(knex, {
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      generateId: nextId,
    });
    const te = await repos.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-iso',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'high',
      argumentsJson: {},
      traceId: TRACE32,
      orgId: ORG,
      userId: USER,
    });
    const approvalId = nextId();
    await repos.approvals.getOrCreatePending({
      approvalId,
      orgId: ORG,
      userId: USER,
      runId: RUN,
      toolExecutionId: te.toolExecution.toolExecutionId,
      requestedBy: USER,
      requestJson: {},
    });
    await assert.rejects(
      () =>
        repos.approvals.getById(approvalId, {
          orgId: ORG,
          userId: OTHER_USER,
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        repos.approvals.decideIf({
          approvalId,
          orgId: ORG,
          userId: OTHER_USER,
          toStatus: APPROVAL_STATUS.APPROVED,
          decisionBy: OTHER_USER,
        }),
      NotFoundError,
    );
  });
});

describe('PR-14 MySQL / queue failure fail-closed (CreateRun authority)', () => {
  it('queue failure keeps ACCEPTED MySQL facts; no phantom QUEUED', async () => {
    const world = createFakeRunWorld();
    world.runQueue.setFail(true);
    const create = new CreateRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: () => new Date('2026-07-18T06:00:00.000Z'),
      runQueue: world.runQueue,
    });
    const created = await create.execute({
      messages: [{ role: 'user', content: 'x' }],
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'pr14-mysql-qfail',
    });
    assert.equal(created.status, 'ACCEPTED');
    assert.equal(created.queueWarning, QUEUE_WARNING.ENQUEUE_FAILED);
    assert.equal(world.tables.runs[0].status, 'ACCEPTED');
    assert.equal(world.enqueuedJobs.length, 0);
    assert.equal(
      world.tables.run_events.filter((e) => e.event_type === 'run.queued')
        .length,
      0,
    );
  });

  it('transaction failure rolls back; zero partial run/event/outbox', async () => {
    const world = createFakeRunWorld();
    const create = new CreateRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: () => new Date('2026-07-18T06:00:00.000Z'),
      runQueue: world.runQueue,
    });
    await create.execute({
      messages: [{ role: 'user', content: 'ok' }],
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'pr14-ok-first',
    });
    const snapRuns = world.tables.runs.length;
    const snapEvents = world.tables.run_events.length;
    const snapOutbox = world.tables.domain_outbox.length;

    world.failNextTransaction();
    await assert.rejects(
      () =>
        create.execute({
          messages: [{ role: 'user', content: 'fail' }],
          auth: {
            ...FIXED_AUTH,
            externalUserId: '770e8400-e29b-41d4-a716-446655440099',
          },
          traceId: TRACE,
          idempotencyKey: 'pr14-tx-fail',
        }),
      /simulated transaction failure/,
    );
    assert.equal(world.tables.runs.length, snapRuns);
    assert.equal(world.tables.run_events.length, snapEvents);
    assert.equal(world.tables.domain_outbox.length, snapOutbox);
    assert.ok(world.rollbackCount >= 1);
  });
});
