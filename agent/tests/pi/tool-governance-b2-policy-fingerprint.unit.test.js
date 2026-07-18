/**
 * PR-06 B2 final: exact policy fingerprint + no re-execution of durable states.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import {
  FencedToolGovernanceRecorder,
  DurablePolicyConflictError,
  assertCompatiblePolicyReplay,
} from '../../src/application/fenced-tool-governance-recorder.js';
import {
  policyDecisionFingerprint,
  extractPolicyFingerprint,
  publicJsonView,
} from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { createEnterpriseExtensionBundle } from '../../src/extensions/index.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
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

function makeGov(knex, nextId) {
  return new FencedToolGovernanceRecorder({
    transactionManager: { run: (fn) => knex.transaction(fn) },
    createRepositories: (db) =>
      createRepositoryBundle(db, { now: () => new Date(), generateId: nextId }),
    generateId: nextId,
    context: RUN_CTX,
    executionFenceToken: 3,
    now: () => new Date('2026-07-18T12:00:00.000Z'),
  });
}

const FULL_TRANSPORT = Object.fromEntries(
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
);

const ALLOW = {
  decision: 'allow',
  reasonCode: 'LOCAL_SANDBOX_ALLOW',
  reason: 'allowed',
  policyId: 'platform:local-low',
  riskLevel: 'low',
};

describe('policyDecisionFingerprint', () => {
  it('is exact over five fields; any field change differs', () => {
    const base = policyDecisionFingerprint(ALLOW);
    assert.equal(policyDecisionFingerprint({ ...ALLOW }), base);
    assert.notEqual(
      policyDecisionFingerprint({ ...ALLOW, reasonCode: 'OTHER' }),
      base,
    );
    assert.notEqual(
      policyDecisionFingerprint({ ...ALLOW, reason: 'other text' }),
      base,
    );
    assert.notEqual(
      policyDecisionFingerprint({ ...ALLOW, policyId: 'other-id' }),
      base,
    );
    assert.notEqual(
      policyDecisionFingerprint({ ...ALLOW, riskLevel: 'high' }),
      base,
    );
    assert.notEqual(
      policyDecisionFingerprint({ ...ALLOW, decision: 'deny' }),
      base,
    );
  });
});

describe('exact policy fingerprint persistence + replay', () => {
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

  it('stores fingerprint in envelope; public args hide it', async () => {
    const gov = makeGov(knex, nextId);
    const r = await gov.recordPolicyDecision({
      toolCallId: 'tc-fp-hide',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: ALLOW,
    });
    assert.ok(r.toolExecution._policyFingerprint);
    assert.equal(
      r.toolExecution._policyFingerprint,
      policyDecisionFingerprint(ALLOW),
    );
    // Public mapped args must not expose fingerprint
    assert.equal(r.toolExecution.argumentsJson.$policyFingerprint, undefined);
    assert.equal(r.toolExecution.argumentsJson.$integrity, undefined);
    const raw = state.tables.tool_executions[0].arguments_json;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    assert.ok(extractPolicyFingerprint(parsed));
    assert.deepEqual(publicJsonView(parsed), { command: 'echo 1' });
  });

  it('exact same decision replay is idempotent with no new audit', async () => {
    const gov = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-fp-same',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: ALLOW,
    });
    assert.equal(state.tables.sandbox_audit_events.length, 1);
    const r2 = await gov.recordPolicyDecision({
      toolCallId: 'tc-fp-same',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: ALLOW,
    });
    assert.equal(r2.created, false);
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('each changed decision field conflicts', async () => {
    const gov = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-fp-chg',
      toolName: 'bash',
      args: { command: 'echo 1' },
      decision: ALLOW,
    });
    for (const patch of [
      { reasonCode: 'OTHER' },
      { reason: 'changed reason' },
      { policyId: 'other-policy' },
      { riskLevel: 'high' },
    ]) {
      await assert.rejects(
        () =>
          gov.recordPolicyDecision({
            toolCallId: 'tc-fp-chg',
            toolName: 'bash',
            args: { command: 'echo 1' },
            decision: { ...ALLOW, ...patch },
          }),
        (e) =>
          e instanceof DurablePolicyConflictError ||
          e?.code === 'CONFLICT' ||
          e?.reasonCode === 'POLICY_FINGERPRINT_MISMATCH' ||
          /FINGERPRINT|Conflict/i.test(String(e?.message)),
      );
    }
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('legacy row without policy fingerprint fails closed on policy replay', async () => {
    // Insert a tool_execution without $policyFingerprint (legacy envelope)
    state.tables.tool_executions.push({
      tool_execution_id: nextId(),
      run_id: RUN,
      agent_session_id: SESS,
      tool_call_id: 'tc-legacy-fp',
      tool_name: 'bash',
      tool_source: 'sandbox',
      risk_level: 'low',
      arguments_json: JSON.stringify({
        $v: 1,
        $integrity: policyDecisionFingerprint(ALLOW), // fake args hash
        $payload: { command: 'echo 1' },
        // no $policyFingerprint
      }),
      result_json: null,
      status: TOOL_EXECUTION_STATUS.PROPOSED,
      error_code: null,
      trace_id: TRACE,
      started_at: null,
      completed_at: null,
      created_at: '2026-07-18 00:00:00.000',
    });
    // Fix integrity to match real args so only policy fingerprint is missing
    const { packJsonWithIntegrity } = await import(
      '../../src/infrastructure/mysql/repositories/tool-execution-repository.js'
    );
    state.tables.tool_executions[0].arguments_json = packJsonWithIntegrity(
      { command: 'echo 1' },
      64 * 1024,
      // no policyFingerprint
    );

    const gov = makeGov(knex, nextId);
    await assert.rejects(
      () =>
        gov.recordPolicyDecision({
          toolCallId: 'tc-legacy-fp',
          toolName: 'bash',
          args: { command: 'echo 1' },
          decision: ALLOW,
        }),
      (e) =>
        e?.reasonCode === 'POLICY_FINGERPRINT_MISSING' ||
        e?.code === 'CONFLICT' ||
        /FINGERPRINT_MISSING/i.test(String(e?.message)),
    );
  });
});

describe('no re-execution of durable RUNNING/SUCCEEDED/FAILED', () => {
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

  async function invoke(factory, toolCallId, toolName, args = {}) {
    const handlers = new Map();
    const pi = {
      registerTool() {},
      on(ev, h) {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev).push(h);
      },
    };
    await factory(pi);
    return await handlers.get('tool_call')[0](
      { toolCallId, toolName, input: args },
      {},
    );
  }

  it('allow→RUNNING then replay allow is blocked; no new audit', async () => {
    const gov = makeGov(knex, nextId);
    const engine = {
      evaluateToolCall: async () => ALLOW,
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: FULL_TRANSPORT,
    });
    const r1 = await invoke(factories[1], 'tc-run', 'bash', {
      command: 'echo hi',
    });
    assert.equal(r1, undefined); // allow
    assert.equal(state.tables.sandbox_audit_events.length, 1);

    await gov.recordToolStarted({
      toolCallId: 'tc-run',
      toolName: 'bash',
      args: { command: 'echo hi' },
    });
    assert.equal(
      state.tables.tool_executions[0].status,
      TOOL_EXECUTION_STATUS.RUNNING,
    );

    const r2 = await invoke(factories[1], 'tc-run', 'bash', {
      command: 'echo hi',
    });
    assert.equal(r2.block, true);
    assert.equal(r2.reasonCode, 'POLICY_DURABLE_ALREADY_EXECUTED');
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('allow→SUCCEEDED replay allow is blocked', async () => {
    const gov = makeGov(knex, nextId);
    const engine = { evaluateToolCall: async () => ALLOW };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: FULL_TRANSPORT,
    });
    assert.equal(
      await invoke(factories[1], 'tc-ok', 'bash', { command: 'x' }),
      undefined,
    );
    await gov.recordToolStarted({
      toolCallId: 'tc-ok',
      toolName: 'bash',
      args: { command: 'x' },
    });
    await gov.recordToolEnded({
      toolCallId: 'tc-ok',
      toolName: 'bash',
      isError: false,
      result: { exitCode: 0 },
    });
    const r2 = await invoke(factories[1], 'tc-ok', 'bash', { command: 'x' });
    assert.equal(r2.block, true);
    assert.equal(r2.reasonCode, 'POLICY_DURABLE_ALREADY_EXECUTED');
    assert.equal(state.tables.sandbox_audit_events.length, 1);
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.completed',
      ).length,
      1,
    );
  });

  it('tool FAILED (execution) then replay allow is blocked', async () => {
    const gov = makeGov(knex, nextId);
    const engine = { evaluateToolCall: async () => ALLOW };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: FULL_TRANSPORT,
    });
    assert.equal(
      await invoke(factories[1], 'tc-fail', 'bash', { command: 'x' }),
      undefined,
    );
    await gov.recordToolStarted({
      toolCallId: 'tc-fail',
      toolName: 'bash',
      args: { command: 'x' },
    });
    await gov.recordToolEnded({
      toolCallId: 'tc-fail',
      toolName: 'bash',
      isError: true,
      result: { exitCode: 1 },
    });
    const r2 = await invoke(factories[1], 'tc-fail', 'bash', { command: 'x' });
    assert.equal(r2.block, true);
    assert.equal(r2.reasonCode, 'POLICY_DURABLE_ALREADY_EXECUTED');
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('assertCompatiblePolicyReplay: only PROPOSED allow; fingerprint exact', () => {
    const fp = policyDecisionFingerprint(ALLOW);
    assert.doesNotThrow(() =>
      assertCompatiblePolicyReplay(
        {
          status: TOOL_EXECUTION_STATUS.PROPOSED,
          _policyFingerprint: fp,
        },
        {
          decision: 'allow',
          desiredStatus: TOOL_EXECUTION_STATUS.PROPOSED,
          policyFingerprint: fp,
        },
      ),
    );
    assert.throws(
      () =>
        assertCompatiblePolicyReplay(
          {
            status: TOOL_EXECUTION_STATUS.RUNNING,
            _policyFingerprint: fp,
          },
          {
            decision: 'allow',
            desiredStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            policyFingerprint: fp,
          },
        ),
      (e) => e.reasonCode === 'POLICY_DURABLE_ALREADY_EXECUTED',
    );
    assert.throws(
      () =>
        assertCompatiblePolicyReplay(
          {
            status: TOOL_EXECUTION_STATUS.PROPOSED,
            _policyFingerprint: fp,
          },
          {
            decision: 'allow',
            desiredStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            policyFingerprint: policyDecisionFingerprint({
              ...ALLOW,
              reason: 'changed',
            }),
          },
        ),
      (e) => e.reasonCode === 'POLICY_FINGERPRINT_MISMATCH',
    );
    assert.throws(
      () =>
        assertCompatiblePolicyReplay(
          {
            status: TOOL_EXECUTION_STATUS.PROPOSED,
            _policyFingerprint: null,
          },
          {
            decision: 'allow',
            desiredStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            policyFingerprint: fp,
          },
        ),
      (e) => e.reasonCode === 'POLICY_FINGERPRINT_MISSING',
    );
  });
});
