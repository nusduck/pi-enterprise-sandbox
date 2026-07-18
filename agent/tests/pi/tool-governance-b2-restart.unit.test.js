/**
 * PR-06 B2 restart/ownership/integrity regressions (Codex review fixes).
 * Offline — second recorder instances prove MySQL is authority.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedToolGovernanceRecorder } from '../../src/application/fenced-tool-governance-recorder.js';
import {
  integrityFingerprint,
  INTEGRITY_META_KEY,
} from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import { APPROVAL_STATUS } from '../../src/domain/tool/approval-status.js';
import {
  ConflictError,
  NotFoundError,
} from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN99';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const TRACE = 'b'.repeat(32);
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';

const RUN_CTX = Object.freeze({
  orgId: ORG,
  userId: USER,
  conversationId: CONV,
  agentSessionId: SESS,
  runId: RUN,
  sandboxSessionId: SBX,
  traceId: TRACE,
  executionFenceToken: 3,
});

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

function makeGov(knex, nextId, opts = {}) {
  /** @type {object[]} */
  const emitted = [];
  const gov = new FencedToolGovernanceRecorder({
    transactionManager: { run: (fn) => knex.transaction(fn) },
    createRepositories: (db) =>
      createRepositoryBundle(db, {
        now: () => new Date(),
        generateId: nextId,
      }),
    generateId: nextId,
    context: RUN_CTX,
    executionFenceToken: 3,
    now: () => new Date('2026-07-18T12:00:00.000Z'),
    emit: async (env) => {
      emitted.push(env);
    },
    ...opts,
  });
  return { gov, emitted };
}

describe('integrity fingerprints (secret-aware)', () => {
  it('same secret → same hash; different secrets with same redacted view differ', () => {
    const a = { apiKey: 'sk-live-AAA', path: 'x' };
    const b = { apiKey: 'sk-live-BBB', path: 'x' };
    // Public redaction collapses keys, but integrity must not.
    assert.notEqual(integrityFingerprint(a), integrityFingerprint(b));
    assert.equal(integrityFingerprint(a), integrityFingerprint({ ...a }));
  });
});

describe('restart-safe MySQL-authoritative idempotency', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  let nextId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  });

  it('second recorder does not duplicate policy audit', async () => {
    const { gov: g1 } = makeGov(knex, nextId);
    const r1 = await g1.recordPolicyDecision({
      toolCallId: 'tc-restart-pol',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: {
        decision: 'allow',
        reasonCode: 'LOCAL_SANDBOX_ALLOW',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    assert.equal(r1.created, true);
    assert.ok(r1.toolExecution?.toolExecutionId);
    assert.equal(state.tables.sandbox_audit_events.length, 1);

    // New process: fresh recorder, same DB
    const nextId2 = createUlidGenerator({ now: () => 1_721_278_800_100 });
    const { gov: g2 } = makeGov(knex, nextId2);
    const r2 = await g2.recordPolicyDecision({
      toolCallId: 'tc-restart-pol',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: {
        decision: 'allow',
        reasonCode: 'LOCAL_SANDBOX_ALLOW',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    assert.equal(r2.created, false);
    assert.equal(
      r2.toolExecution.toolExecutionId,
      r1.toolExecution.toolExecutionId,
    );
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('second recorder does not duplicate approval.requested event', async () => {
    const { gov: g1, emitted: e1 } = makeGov(knex, nextId);
    await g1.recordPolicyDecision({
      toolCallId: 'tc-restart-appr',
      toolName: 'mcp__crm__delete',
      args: { id: '1' },
      decision: {
        decision: 'require_approval',
        reasonCode: 'EXTERNAL_HIGH_RISK',
        reason: 'needs approval',
        policyId: 'p',
        riskLevel: 'high',
      },
    });
    const p1 = await g1.requestApproval({
      toolCallId: 'tc-restart-appr',
      toolName: 'mcp__crm__delete',
      args: { id: '1' },
      decision: {
        decision: 'require_approval',
        reasonCode: 'EXTERNAL_HIGH_RISK',
        reason: 'needs approval',
        policyId: 'p',
        riskLevel: 'high',
      },
    });
    assert.equal(p1.created, true);
    assert.ok(p1.envelope);
    assert.equal(
      state.tables.run_events.filter((e) => e.event_type === 'approval.requested')
        .length,
      1,
    );
    assert.equal(e1.filter((e) => e.type === 'approval.requested').length, 1);

    const nextId2 = createUlidGenerator({ now: () => 1_721_278_800_200 });
    const { gov: g2, emitted: e2 } = makeGov(knex, nextId2);
    const p2 = await g2.requestApproval({
      toolCallId: 'tc-restart-appr',
      toolName: 'mcp__crm__delete',
      args: { id: '1' },
      decision: {
        decision: 'require_approval',
        reasonCode: 'EXTERNAL_HIGH_RISK',
        reason: 'needs approval',
        policyId: 'p',
        riskLevel: 'high',
      },
      toolExecutionId: p1.toolExecution.toolExecutionId,
    });
    assert.equal(p2.created, false);
    assert.equal(p2.envelope, null);
    assert.equal(p2.approval.approvalId, p1.approval.approvalId);
    assert.equal(
      state.tables.run_events.filter((e) => e.event_type === 'approval.requested')
        .length,
      1,
    );
    assert.equal(e2.filter((e) => e.type === 'approval.requested').length, 0);
  });

  it('second recorder: start/end same result no new events; different result conflicts', async () => {
    const { gov: g1 } = makeGov(knex, nextId);
    await g1.recordPolicyDecision({
      toolCallId: 'tc-restart-io',
      toolName: 'read',
      args: { path: 'a.txt' },
      decision: {
        decision: 'allow',
        reasonCode: 'OK',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    const s1 = await g1.recordToolStarted({
      toolCallId: 'tc-restart-io',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    assert.equal(s1.statusChanged, true);
    assert.ok(s1.envelope);
    const e1 = await g1.recordToolEnded({
      toolCallId: 'tc-restart-io',
      toolName: 'read',
      isError: false,
      result: { content: 'hello' },
    });
    assert.equal(e1.statusChanged, true);
    assert.ok(e1.envelope);

    const nextId2 = createUlidGenerator({ now: () => 1_721_278_800_300 });
    const { gov: g2, emitted: em2 } = makeGov(knex, nextId2);
    const s2 = await g2.recordToolStarted({
      toolCallId: 'tc-restart-io',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    assert.equal(s2.statusChanged, false);
    assert.equal(s2.envelope, null);
    const e2 = await g2.recordToolEnded({
      toolCallId: 'tc-restart-io',
      toolName: 'read',
      isError: false,
      result: { content: 'hello' },
    });
    assert.equal(e2.statusChanged, false);
    assert.equal(e2.envelope, null);
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.started',
      ).length,
      1,
    );
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.completed',
      ).length,
      1,
    );
    assert.equal(em2.length, 0);

    await assert.rejects(
      () =>
        g2.recordToolEnded({
          toolCallId: 'tc-restart-io',
          toolName: 'read',
          isError: false,
          result: { content: 'DIFFERENT' },
        }),
      ConflictError,
    );
  });

  it('policy deny sets completedAt', async () => {
    const { gov } = makeGov(knex, nextId);
    const r = await gov.recordPolicyDecision({
      toolCallId: 'tc-deny-ts',
      toolName: 'bash',
      args: { command: 'cat /etc/passwd' },
      decision: {
        decision: 'deny',
        reasonCode: 'HOST_ESCAPE_DENIED',
        reason: 'denied',
        policyId: 'p',
        riskLevel: 'critical',
      },
    });
    assert.equal(r.toolExecution.status, TOOL_EXECUTION_STATUS.FAILED);
    assert.ok(r.toolExecution.completedAt, 'FAILED must have completedAt');
  });

  it('same secret replay ok; different secret conflicts despite redaction', async () => {
    const r = createRepositoryBundle(knex, {
      now: () => new Date(),
      generateId: nextId,
    });
    const a = await r.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-sec',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'low',
      argumentsJson: { apiKey: 'sk-AAA-secret', command: 'echo' },
      traceId: TRACE,
      orgId: ORG,
      userId: USER,
    });
    assert.equal(a.created, true);
    // Public view must not expose raw secret
    assert.notEqual(a.toolExecution.argumentsJson.apiKey, 'sk-AAA-secret');
    // Stored row has integrity meta (envelope $integrity)
    const raw = state.tables.tool_executions[0].arguments_json;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const { extractIntegrity } = await import(
      '../../src/infrastructure/mysql/repositories/tool-execution-repository.js'
    );
    assert.ok(extractIntegrity(parsed));
    assert.equal(parsed.$v, 1);
    assert.ok(parsed.$integrity);

    const b = await r.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-sec',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'low',
      argumentsJson: { apiKey: 'sk-AAA-secret', command: 'echo' },
      traceId: TRACE,
      orgId: ORG,
      userId: USER,
    });
    assert.equal(b.created, false);

    await assert.rejects(
      () =>
        r.toolExecutions.getOrCreate({
          toolExecutionId: nextId(),
          runId: RUN,
          agentSessionId: SESS,
          toolCallId: 'tc-sec',
          toolName: 'bash',
          toolSource: 'sandbox',
          riskLevel: 'low',
          argumentsJson: { apiKey: 'sk-BBB-other', command: 'echo' },
          traceId: TRACE,
          orgId: ORG,
          userId: USER,
        }),
      ConflictError,
    );
  });

  it('WAITING_APPROVAL cannot start or end', async () => {
    const { gov } = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-wait',
      toolName: 'mcp__x__y',
      args: {},
      decision: {
        decision: 'require_approval',
        reasonCode: 'R',
        reason: 'r',
        policyId: 'p',
        riskLevel: 'high',
      },
    });
    await gov.requestApproval({
      toolCallId: 'tc-wait',
      toolName: 'mcp__x__y',
      args: {},
      decision: {
        decision: 'require_approval',
        reasonCode: 'R',
        reason: 'r',
        policyId: 'p',
        riskLevel: 'high',
      },
    });
    await assert.rejects(
      () =>
        gov.recordToolStarted({
          toolCallId: 'tc-wait',
          toolName: 'mcp__x__y',
          args: {},
        }),
      /WAITING_APPROVAL|Conflict/i,
    );
    await assert.rejects(
      () =>
        gov.recordToolEnded({
          toolCallId: 'tc-wait',
          toolName: 'mcp__x__y',
          isError: false,
          result: {},
        }),
      /WAITING_APPROVAL|Conflict/i,
    );
  });

  it('toolName mismatch on start/end fails closed', async () => {
    const { gov } = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-name',
      toolName: 'bash',
      args: { command: 'true' },
      decision: {
        decision: 'allow',
        reasonCode: 'OK',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    await assert.rejects(
      () =>
        gov.recordToolStarted({
          toolCallId: 'tc-name',
          toolName: 'read',
          args: {},
        }),
      ConflictError,
    );
  });
});

describe('owner-scoped by-id (same-org cross-user)', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  let nextId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
  });

  it('getById / listByToolExecutionId deny other user in same org', async () => {
    const r = createRepositoryBundle(knex, {
      now: () => new Date(),
      generateId: nextId,
    });
    const created = await r.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-own',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'low',
      argumentsJson: { command: 'x' },
      traceId: TRACE,
      orgId: ORG,
      userId: USER,
    });
    const teId = created.toolExecution.toolExecutionId;

    await assert.rejects(
      () =>
        r.toolExecutions.getById(teId, { orgId: ORG, userId: OTHER_USER }),
      NotFoundError,
    );

    await r.approvals.getOrCreatePending({
      approvalId: nextId(),
      orgId: ORG,
      userId: USER,
      runId: RUN,
      toolExecutionId: teId,
      requestedBy: USER,
      requestJson: { tool: 'bash' },
    });

    await assert.rejects(
      () =>
        r.approvals.listByToolExecutionId(teId, {
          orgId: ORG,
          userId: OTHER_USER,
        }),
      NotFoundError,
    );

    // Owner can list
    const list = await r.approvals.listByToolExecutionId(teId, {
      orgId: ORG,
      userId: USER,
    });
    assert.equal(list.length, 1);
    assert.equal(list[0].status, APPROVAL_STATUS.PENDING);
  });
});
