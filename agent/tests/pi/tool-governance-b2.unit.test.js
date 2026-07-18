/**
 * PR-06 B2: durable ToolExecution / policy audit / Approval request facts.
 * Offline — fake knex, no network/DB/Redis, no legacy waiter.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedToolGovernanceRecorder } from '../../src/application/fenced-tool-governance-recorder.js';
import {
  createEnterpriseExtensionBundle,
  createPolicyEngine,
} from '../../src/extensions/index.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import {
  APPROVAL_STATUS,
  DURABLE_APPROVAL_PENDING,
} from '../../src/domain/tool/approval-status.js';
import { ConflictError, NotFoundError } from '../../src/infrastructure/mysql/errors.js';
import { PINNED_PI_SDK_VERSION } from '../../src/infrastructure/pi/pi-runtime-factory.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN99';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const TRACE = 'b'.repeat(32);
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const DEF = '01K0G2PAV8FPMVC9QHJG7JPN5D';
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

describe('ToolExecutionRepository owner scope + idempotency', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
  });

  function repos(db = knex) {
    return createRepositoryBundle(db, {
      now: () => new Date(),
      generateId: nextId,
    });
  }

  it('cross-user access denied', async () => {
    const r = repos();
    await assert.rejects(
      () =>
        r.toolExecutions.getOrCreate({
          toolExecutionId: nextId(),
          runId: RUN,
          agentSessionId: SESS,
          toolCallId: 'tc-x',
          toolName: 'bash',
          toolSource: 'sandbox',
          riskLevel: 'low',
          argumentsJson: { command: 'echo 1' },
          traceId: TRACE,
          orgId: ORG,
          userId: OTHER_USER,
        }),
      NotFoundError,
    );
  });

  it('replay same tool_call_id returns same row; conflicting args fail', async () => {
    const r = repos();
    const id1 = nextId();
    const a = await r.toolExecutions.getOrCreate({
      toolExecutionId: id1,
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-1',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'low',
      argumentsJson: { command: 'echo 1' },
      traceId: TRACE,
      orgId: ORG,
      userId: USER,
    });
    assert.equal(a.created, true);
    const b = await r.toolExecutions.getOrCreate({
      toolExecutionId: nextId(),
      runId: RUN,
      agentSessionId: SESS,
      toolCallId: 'tc-1',
      toolName: 'bash',
      toolSource: 'sandbox',
      riskLevel: 'low',
      argumentsJson: { command: 'echo 1' },
      traceId: TRACE,
      orgId: ORG,
      userId: USER,
    });
    assert.equal(b.created, false);
    assert.equal(b.toolExecution.toolExecutionId, a.toolExecution.toolExecutionId);

    await assert.rejects(
      () =>
        r.toolExecutions.getOrCreate({
          toolExecutionId: nextId(),
          runId: RUN,
          agentSessionId: SESS,
          toolCallId: 'tc-1',
          toolName: 'bash',
          toolSource: 'sandbox',
          riskLevel: 'low',
          argumentsJson: { command: 'echo DIFFERENT' },
          traceId: TRACE,
          orgId: ORG,
          userId: USER,
        }),
      ConflictError,
    );
  });
});

describe('FencedToolGovernanceRecorder', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
  });

  function makeGov(opts = {}) {
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
      isLockLost: opts.isLockLost ?? (() => false),
      emit: async (env) => {
        emitted.push(env);
      },
    });
    return { gov, emitted };
  }

  it('local bash: ToolExecution + audit, zero approvals', async () => {
    const { gov, emitted } = makeGov();
    const decision = {
      decision: 'allow',
      reasonCode: 'LOCAL_SANDBOX_ALLOW',
      reason: 'local allow',
      policyId: 'platform:local-low',
      riskLevel: 'low',
    };
    const r = await gov.recordPolicyDecision({
      toolCallId: 'tc-bash-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      decision,
    });
    assert.ok(r.toolExecution);
    assert.equal(r.toolExecution.status, TOOL_EXECUTION_STATUS.PROPOSED);
    assert.equal(state.tables.approvals.length, 0);
    assert.equal(state.tables.sandbox_audit_events.length, 1);
    assert.equal(
      state.tables.sandbox_audit_events[0].event_type,
      'policy.decision',
    );
    void emitted;
  });

  it('external high risk: pending approval + approval.requested + outbox; block path', async () => {
    const { gov, emitted } = makeGov();
    await gov.recordPolicyDecision({
      toolCallId: 'tc-mcp-1',
      toolName: 'mcp__crm__delete',
      args: { id: '1' },
      decision: {
        decision: 'require_approval',
        reasonCode: 'EXTERNAL_HIGH_RISK',
        reason: 'needs approval',
        policyId: 'platform:mcp-high',
        riskLevel: 'high',
      },
    });
    const pending = await gov.requestApproval({
      toolCallId: 'tc-mcp-1',
      toolName: 'mcp__crm__delete',
      args: { id: '1' },
      decision: {
        decision: 'require_approval',
        reasonCode: 'EXTERNAL_HIGH_RISK',
        reason: 'needs approval',
        policyId: 'platform:mcp-high',
        riskLevel: 'high',
      },
    });
    assert.equal(pending.approval.status, APPROVAL_STATUS.PENDING);
    assert.equal(pending.durablePending.kind, DURABLE_APPROVAL_PENDING);
    assert.equal(pending.toolExecution.status, TOOL_EXECUTION_STATUS.WAITING_APPROVAL);
    assert.ok(
      state.tables.run_events.some((e) => e.event_type === 'approval.requested'),
    );
    assert.ok(
      state.tables.domain_outbox.some((e) => e.event_type === 'approval.requested'),
    );
    assert.ok(emitted.some((e) => e.type === 'approval.requested'));
  });

  it('tool start/end transitions idempotently; conflict on different end result', async () => {
    const { gov } = makeGov();
    await gov.recordPolicyDecision({
      toolCallId: 'tc-rw',
      toolName: 'read',
      args: { path: 'a.txt' },
      decision: {
        decision: 'allow',
        reasonCode: 'LOCAL_SANDBOX_ALLOW',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    await gov.recordToolStarted({
      toolCallId: 'tc-rw',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    await gov.recordToolStarted({
      toolCallId: 'tc-rw',
      toolName: 'read',
      args: { path: 'a.txt' },
    });
    assert.equal(
      state.tables.run_events.filter((e) => e.event_type === 'tool.execution.started')
        .length,
      1,
    );
    await gov.recordToolEnded({
      toolCallId: 'tc-rw',
      toolName: 'read',
      isError: false,
      result: { content: 'x' },
    });
    await gov.recordToolEnded({
      toolCallId: 'tc-rw',
      toolName: 'read',
      isError: false,
      result: { content: 'x' },
    });
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.completed',
      ).length,
      1,
    );
    // conflicting end after terminal with different result
    await assert.rejects(
      () =>
        gov.recordToolEnded({
          toolCallId: 'tc-rw',
          toolName: 'read',
          isError: false,
          result: { content: 'DIFFERENT' },
        }),
      /conflict|Conflict|CONFLICT|terminal/i,
    );
  });

  it('fence mismatch rolls back tool/audit/event/outbox; no emit', async () => {
    state.tables.agent_sessions[0].execution_fence_token = 99;
    const { gov, emitted } = makeGov();
    await assert.rejects(
      () =>
        gov.recordPolicyDecision({
          toolCallId: 'tc-fence',
          toolName: 'bash',
          args: { command: 'x' },
          decision: {
            decision: 'allow',
            reasonCode: 'OK',
            reason: 'ok',
            policyId: 'p',
            riskLevel: 'low',
          },
        }),
      /fence|Fence|ACTIVE|token/i,
    );
    assert.equal(state.tables.tool_executions.length, 0);
    assert.equal(state.tables.sandbox_audit_events.length, 0);
    assert.equal(state.tables.run_events.length, 0);
    assert.equal(emitted.length, 0);
  });

  it('approval retry after failed transaction can succeed', async () => {
    const { gov } = makeGov();
    // First attempt fails mid-way by wrong fence after prepare? Simulate:
    // call with bad fence once, then restore.
    state.tables.agent_sessions[0].execution_fence_token = 1;
    await assert.rejects(
      () =>
        gov.requestApproval({
          toolCallId: 'tc-retry',
          toolName: 'mcp__x__y',
          args: {},
          decision: {
            decision: 'require_approval',
            reasonCode: 'R',
            reason: 'r',
            policyId: 'p',
            riskLevel: 'high',
          },
        }),
      /fence|Fence|ACTIVE|token/i,
    );
    state.tables.agent_sessions[0].execution_fence_token = 3;
    await gov.recordPolicyDecision({
      toolCallId: 'tc-retry',
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
    const ok = await gov.requestApproval({
      toolCallId: 'tc-retry',
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
    assert.equal(ok.approval.status, APPROVAL_STATUS.PENDING);
  });
});

describe('enterprise-policy + governance integration', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
  });

  function makeGov() {
    return new FencedToolGovernanceRecorder({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(),
          generateId: nextId,
        }),
      generateId: nextId,
      context: RUN_CTX,
      executionFenceToken: 3,
      now: () => new Date(),
    });
  }

  async function invokeToolCall(factory, event) {
    const handlers = new Map();
    const pi = {
      registerTool() {},
      on(ev, h) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(h);
      },
    };
    await factory(pi);
    const hs = handlers.get('tool_call') || [];
    return hs[0](event, {});
  }

  it('ordinary bash allow: durable audit, zero approvals, no block', async () => {
    const gov = makeGov();
    const engine = createPolicyEngine({
      auditSink: async () => {},
    });
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: Object.fromEntries(
        [
          'readFile',
          'writeFile',
          'editFile',
          'bash',
          'python',
          'processStart',
          'processStatus',
          'processRead',
          'processKill',
          'submitArtifact',
        ].map((m) => [m, async () => ({})]),
      ),
    });
    const r = await invokeToolCall(factories[1], {
      toolCallId: 'pi-tc-bash',
      toolName: 'bash',
      input: { command: 'echo hi' },
    });
    assert.equal(r, undefined);
    assert.equal(state.tables.approvals.length, 0);
    assert.ok(state.tables.tool_executions.length >= 1);
    assert.ok(state.tables.sandbox_audit_events.length >= 1);
  });

  it('external high risk: block + durable pending; transport not invoked', async () => {
    const transportCalls = [];
    const gov = makeGov();
    const engine = createPolicyEngine({
      auditSink: async () => {},
      agentVersionToolPolicy: {
        'mcp__crm__delete': 'require_approval',
      },
    });
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: Object.fromEntries(
        [
          'readFile',
          'writeFile',
          'editFile',
          'bash',
          'python',
          'processStart',
          'processStatus',
          'processRead',
          'processKill',
          'submitArtifact',
        ].map((m) => [
          m,
          async () => {
            transportCalls.push(m);
            return {};
          },
        ]),
      ),
    });
    const r = await invokeToolCall(factories[1], {
      toolCallId: 'pi-tc-mcp',
      toolName: 'mcp__crm__delete',
      input: { id: '1' },
    });
    assert.equal(r.block, true);
    assert.equal(r.durablePending?.kind, DURABLE_APPROVAL_PENDING);
    assert.equal(r.runStatusHint, null);
    assert.equal(transportCalls.length, 0);
    assert.equal(state.tables.approvals.length, 1);
    assert.ok(
      state.tables.run_events.some((e) => e.event_type === 'approval.requested'),
    );
  });

  it('missing toolCallId fails closed', async () => {
    const gov = makeGov();
    const engine = createPolicyEngine({ auditSink: async () => {} });
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: Object.fromEntries(
        [
          'readFile',
          'writeFile',
          'editFile',
          'bash',
          'python',
          'processStart',
          'processStatus',
          'processRead',
          'processKill',
          'submitArtifact',
        ].map((m) => [m, async () => ({})]),
      ),
    });
    const r = await invokeToolCall(factories[1], {
      toolName: 'bash',
      input: { command: 'x' },
    });
    assert.equal(r.block, true);
    assert.match(r.reason, /TOOL_CALL_ID_REQUIRED/);
  });
});

describe('B2 static guards', () => {
  it('no Map/Promise approval authority and no old waiter import in new paths', () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../src',
    );
    const files = [
      'application/fenced-tool-governance-recorder.js',
      'extensions/enterprise-policy/index.js',
      'infrastructure/mysql/repositories/approval-repository.js',
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(root, rel), 'utf8');
      assert.equal(
        /approval-waiter|ApprovalSuspendedError|createApprovalPending/.test(src),
        false,
        rel,
      );
      // Must not use process-local Map as approval authority
      assert.equal(
        /new Map\(\).*approval|approvalWaiters|pendingApprovals\s*=\s*new Map/.test(
          src,
        ),
        false,
        rel,
      );
    }
  });
});
