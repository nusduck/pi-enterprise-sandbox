/**
 * PR-06 B2 second-review regressions: join select, integrity envelope,
 * policy durable fail-closed, start args/source match, approval ID bind.
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
  integrityFingerprint,
  stableCanonicalStringify,
  packJsonWithIntegrity,
  publicJsonView,
  extractIntegrity,
  MAX_INTEGRITY_CANONICAL_BYTES,
  TOOL_EXECUTION_CHILD_SELECT,
  INTEGRITY_META_KEY,
  ENVELOPE_KEYS,
} from '../../src/infrastructure/mysql/repositories/tool-execution-repository.js';
import { APPROVAL_CHILD_SELECT } from '../../src/infrastructure/mysql/repositories/approval-repository.js';
import {
  createEnterpriseExtensionBundle,
  createPolicyEngine,
} from '../../src/extensions/index.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

describe('join child-only select (static + constants)', () => {
  it('repositories require te.* / a.* child selects', () => {
    assert.deepEqual([...TOOL_EXECUTION_CHILD_SELECT], ['te.*']);
    assert.deepEqual([...APPROVAL_CHILD_SELECT], ['a.*']);
    const teSrc = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/infrastructure/mysql/repositories/tool-execution-repository.js',
      ),
      'utf8',
    );
    const apSrc = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../src/infrastructure/mysql/repositories/approval-repository.js',
      ),
      'utf8',
    );
    assert.match(teSrc, /\.select\(\.\.\.TOOL_EXECUTION_CHILD_SELECT\)/);
    assert.match(apSrc, /\.select\(\.\.\.APPROVAL_CHILD_SELECT\)/);
    assert.match(apSrc, /\.select\(\.\.\.TOOL_EXECUTION_CHILD_SELECT\)/);
  });
});

describe('integrity envelope + full hash', () => {
  it('shared DAG refs are not marked Circular; true cycles are', () => {
    const shared = { x: 1 };
    const dag = { a: shared, b: shared };
    const s = stableCanonicalStringify(dag);
    assert.ok(!s.includes('[Circular]'));
    assert.match(s, /"x":1/);

    /** @type {any} */
    const cyclic = { n: 1 };
    cyclic.self = cyclic;
    assert.match(stableCanonicalStringify(cyclic), /Circular/);
  });

  it('rejects oversized canonical input (no silent truncate)', () => {
    const huge = 'x'.repeat(MAX_INTEGRITY_CANONICAL_BYTES + 10);
    assert.throws(
      () => integrityFingerprint(huge),
      (e) => e.code === 'INTEGRITY_INPUT_TOO_LARGE',
    );
    // Inputs that would only differ past a silent 1MiB truncate: both rejected
    // if over bound; under bound full hash distinguishes.
    const a = 'a'.repeat(1000) + 'TAIL-A';
    const b = 'a'.repeat(1000) + 'TAIL-B';
    assert.notEqual(integrityFingerprint(a), integrityFingerprint(b));
  });

  it('rejects reserved keys in caller objects', () => {
    assert.throws(
      () => packJsonWithIntegrity({ [INTEGRITY_META_KEY]: 'x' }, 64 * 1024),
      /RESERVED_KEY_FORBIDDEN/,
    );
    assert.throws(
      () => packJsonWithIntegrity({ $payload: 'x' }, 64 * 1024),
      /RESERVED_KEY_FORBIDDEN/,
    );
  });

  it('preserves array/primitive result shape publicly', () => {
    const arrPacked = packJsonWithIntegrity([1, 2, 3], 64 * 1024);
    const arrView = publicJsonView(JSON.parse(arrPacked));
    assert.deepEqual(arrView, [1, 2, 3]);
    assert.ok(extractIntegrity(JSON.parse(arrPacked)));

    const primPacked = packJsonWithIntegrity('hello', 64 * 1024);
    assert.equal(publicJsonView(JSON.parse(primPacked)), 'hello');

    const env = JSON.parse(primPacked);
    // Core envelope keys always present; $policyFingerprint is optional.
    for (const k of ['$v', '$integrity', '$payload']) {
      assert.ok(Object.prototype.hasOwnProperty.call(env, k));
    }
    assert.equal(Object.prototype.hasOwnProperty.call(env, '$policyFingerprint'), false);
  });

  it('different secret terminal results conflict', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seedWorld(state);
    const nextId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    const gov = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-res-sec',
      toolName: 'bash',
      args: { command: 'x' },
      decision: {
        decision: 'allow',
        reasonCode: 'OK',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    await gov.recordToolStarted({
      toolCallId: 'tc-res-sec',
      toolName: 'bash',
      args: { command: 'x' },
    });
    await gov.recordToolEnded({
      toolCallId: 'tc-res-sec',
      toolName: 'bash',
      isError: false,
      result: { apiKey: 'sk-AAA', out: 1 },
    });
    await assert.rejects(
      () =>
        gov.recordToolEnded({
          toolCallId: 'tc-res-sec',
          toolName: 'bash',
          isError: false,
          result: { apiKey: 'sk-BBB', out: 1 },
        }),
      ConflictError,
    );
  });
});

describe('start replay args/source + approval bind', () => {
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

  it('restart start with different secret-bearing args conflicts', async () => {
    const gov = makeGov(knex, nextId);
    await gov.recordPolicyDecision({
      toolCallId: 'tc-start-sec',
      toolName: 'bash',
      args: { apiKey: 'sk-AAA', command: 'echo' },
      decision: {
        decision: 'allow',
        reasonCode: 'OK',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    await gov.recordToolStarted({
      toolCallId: 'tc-start-sec',
      toolName: 'bash',
      args: { apiKey: 'sk-AAA', command: 'echo' },
    });

    const nextId2 = createUlidGenerator({ now: () => 1_721_278_900_000 });
    const gov2 = makeGov(knex, nextId2);
    await assert.rejects(
      () =>
        gov2.recordToolStarted({
          toolCallId: 'tc-start-sec',
          toolName: 'bash',
          args: { apiKey: 'sk-BBB', command: 'echo' },
        }),
      ConflictError,
    );
  });

  it('requestApproval rejects wrong toolExecutionId for this call', async () => {
    const gov = makeGov(knex, nextId);
    const a = await gov.recordPolicyDecision({
      toolCallId: 'tc-a',
      toolName: 'mcp__x__a',
      args: { n: 1 },
      decision: {
        decision: 'require_approval',
        reasonCode: 'R',
        reason: 'r',
        policyId: 'p',
        riskLevel: 'high',
      },
    });
    const b = await gov.recordPolicyDecision({
      toolCallId: 'tc-b',
      toolName: 'mcp__x__b',
      args: { n: 2 },
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
        gov.requestApproval({
          toolCallId: 'tc-a',
          toolName: 'mcp__x__a',
          args: { n: 1 },
          decision: {
            decision: 'require_approval',
            reasonCode: 'R',
            reason: 'r',
            policyId: 'p',
            riskLevel: 'high',
          },
          // Wrong execution (belongs to tc-b)
          toolExecutionId: b.toolExecution.toolExecutionId,
        }),
      /toolCallId|Conflict|does not match/i,
    );
    // Correct id works
    const ok = await gov.requestApproval({
      toolCallId: 'tc-a',
      toolName: 'mcp__x__a',
      args: { n: 1 },
      decision: {
        decision: 'require_approval',
        reasonCode: 'R',
        reason: 'r',
        policyId: 'p',
        riskLevel: 'high',
      },
      toolExecutionId: a.toolExecution.toolExecutionId,
    });
    assert.equal(ok.created, true);
  });
});

describe('durable policy replay fail-closed (extension e2e)', () => {
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
    const hs = handlers.get('tool_call') || [];
    assert.ok(hs.length >= 1, 'tool_call handler registered');
    return await hs[0]({ toolCallId, toolName, input: args }, {});
  }

  it('require_approval then fresh allow still blocked; same require_approval idempotent', async () => {
    const gov = makeGov(knex, nextId);
    let evalN = 0;
    const engine = {
      evaluateToolCall: async () => {
        evalN += 1;
        if (evalN === 1) {
          return {
            decision: 'require_approval',
            reasonCode: 'EXTERNAL_HIGH_RISK',
            reason: 'needs approval',
            policyId: 'p',
            riskLevel: 'high',
          };
        }
        // Fresh re-eval wrongly says allow — durable must block
        return {
          decision: 'allow',
          reasonCode: 'WRONG_ALLOW',
          reason: 'should not bypass',
          policyId: 'p',
          riskLevel: 'low',
        };
      },
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: FULL_TRANSPORT,
    });
    const r1 = await invoke(factories[1], 'tc-pol-1', 'mcp__crm__delete', {
      id: '1',
    });
    assert.equal(r1.block, true);
    assert.equal(r1.durablePending?.kind, 'DURABLE_APPROVAL_PENDING');
    assert.equal(state.tables.sandbox_audit_events.length, 1);

    const r2 = await invoke(factories[1], 'tc-pol-1', 'mcp__crm__delete', {
      id: '1',
    });
    assert.equal(r2.block, true);
    assert.match(
      r2.reasonCode,
      /POLICY_DURABLE|PENDING|FINGERPRINT|CONFLICT/,
    );
    // No extra audit
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('deny then fresh allow still blocked; same deny replay stable', async () => {
    const gov = makeGov(knex, nextId);
    let evalN = 0;
    const engine = {
      evaluateToolCall: async () => {
        evalN += 1;
        if (evalN <= 2) {
          return {
            decision: 'deny',
            reasonCode: 'HOST_ESCAPE_DENIED',
            reason: 'denied',
            policyId: 'p',
            riskLevel: 'critical',
          };
        }
        return {
          decision: 'allow',
          reasonCode: 'WRONG',
          reason: 'nope',
          policyId: 'p',
          riskLevel: 'low',
        };
      },
    };
    const factories = createEnterpriseExtensionBundle(RUN_CTX, {
      policyEngine: engine,
      governanceRecorder: gov,
      sandboxTransport: FULL_TRANSPORT,
    });
    const r1 = await invoke(factories[1], 'tc-deny-1', 'bash', {
      command: 'cat /etc/passwd',
    });
    assert.equal(r1.block, true);
    assert.equal(state.tables.sandbox_audit_events.length, 1);

    // Same deny — idempotent block, no extra audit
    const r2 = await invoke(factories[1], 'tc-deny-1', 'bash', {
      command: 'cat /etc/passwd',
    });
    assert.equal(r2.block, true);
    assert.equal(state.tables.sandbox_audit_events.length, 1);

    // Fresh allow — still blocked by durable FAILED
    const r3 = await invoke(factories[1], 'tc-deny-1', 'bash', {
      command: 'cat /etc/passwd',
    });
    assert.equal(r3.block, true);
    assert.match(
      r3.reasonCode,
      /POLICY_DURABLE|DENIED|FINGERPRINT|CONFLICT|ALREADY/,
    );
    assert.equal(state.tables.sandbox_audit_events.length, 1);
  });

  it('assertCompatiblePolicyReplay unit cases (fingerprint required)', async () => {
    const { policyDecisionFingerprint } = await import(
      '../../src/infrastructure/mysql/repositories/tool-execution-repository.js'
    );
    const fp = policyDecisionFingerprint({
      decision: 'require_approval',
      reasonCode: 'R',
      reason: 'r',
      policyId: 'p',
      riskLevel: 'high',
    });
    assert.throws(
      () =>
        assertCompatiblePolicyReplay(
          {
            status: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
            _policyFingerprint: fp,
          },
          {
            decision: 'allow',
            desiredStatus: TOOL_EXECUTION_STATUS.PROPOSED,
            policyFingerprint: fp,
          },
        ),
      (e) => e.reasonCode === 'POLICY_DURABLE_PENDING',
    );
    assert.doesNotThrow(() =>
      assertCompatiblePolicyReplay(
        {
          status: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
          _policyFingerprint: fp,
        },
        {
          decision: 'require_approval',
          desiredStatus: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
          policyFingerprint: fp,
        },
      ),
    );
  });
});
