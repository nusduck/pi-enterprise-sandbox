/**
 * PR-07B batch 2A2: FencedToolGovernanceRecorder.recordToolUnknown.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedToolGovernanceRecorder } from '../../src/application/fenced-tool-governance-recorder.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';

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

describe('FencedToolGovernanceRecorder.recordToolUnknown', () => {
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

  async function prepareRunning(gov, toolCallId = 'tc-unk') {
    await gov.recordPolicyDecision({
      toolCallId,
      toolName: 'bash',
      args: { command: 'sleep 999' },
      decision: {
        decision: 'allow',
        reasonCode: 'LOCAL_SANDBOX_ALLOW',
        reason: 'ok',
        policyId: 'p',
        riskLevel: 'low',
      },
    });
    await gov.recordToolStarted({
      toolCallId,
      toolName: 'bash',
      args: { command: 'sleep 999' },
    });
  }

  it('requires existing RUNNING ledger; transitions UNKNOWN + durable failed/unknown event', async () => {
    const { gov, emitted } = makeGov();
    await assert.rejects(
      () =>
        gov.recordToolUnknown({
          toolCallId: 'missing',
          toolName: 'bash',
        }),
      (err) =>
        err instanceof ConflictError &&
        /requires an existing ToolExecution/i.test(err.message),
    );

    await prepareRunning(gov);
    const r = await gov.recordToolUnknown({
      toolCallId: 'tc-unk',
      toolName: 'bash',
    });
    assert.equal(r.statusChanged, true);
    assert.equal(r.toolExecution.status, TOOL_EXECUTION_STATUS.UNKNOWN);
    assert.equal(r.toolExecution.errorCode, 'TOOL_OUTCOME_UNKNOWN');
    assert.equal(r.envelope?.type, 'tool.execution.failed');
    assert.equal(r.envelope?.data?.unknownOutcome, true);
    assert.equal(r.envelope?.data?.isError, true);
    assert.ok(
      state.tables.run_events.some(
        (e) =>
          e.event_type === 'tool.execution.failed' &&
          String(e.payload_json).includes('unknownOutcome'),
      ),
    );
    assert.ok(emitted.some((e) => e.type === 'tool.execution.failed'));
  });

  it('same UNKNOWN + omitted result is idempotent (no second event)', async () => {
    const { gov, emitted } = makeGov();
    await prepareRunning(gov);
    const first = await gov.recordToolUnknown({
      toolCallId: 'tc-unk',
      toolName: 'bash',
    });
    assert.equal(first.statusChanged, true);
    const second = await gov.recordToolUnknown({
      toolCallId: 'tc-unk',
      toolName: 'bash',
    });
    assert.equal(second.statusChanged, false);
    assert.equal(second.toolExecution.status, TOOL_EXECUTION_STATUS.UNKNOWN);
    assert.equal(
      state.tables.run_events.filter(
        (e) => e.event_type === 'tool.execution.failed',
      ).length,
      1,
    );
    assert.equal(
      emitted.filter((e) => e.type === 'tool.execution.failed').length,
      1,
    );
  });

  it('same UNKNOWN + same explicit result is idempotent; different result conflicts', async () => {
    const { gov } = makeGov();
    await prepareRunning(gov);
    await gov.recordToolUnknown({
      toolCallId: 'tc-unk',
      toolName: 'bash',
      result: { reason: 'timeout' },
    });
    const again = await gov.recordToolUnknown({
      toolCallId: 'tc-unk',
      toolName: 'bash',
      result: { reason: 'timeout' },
    });
    assert.equal(again.statusChanged, false);

    await assert.rejects(
      () =>
        gov.recordToolUnknown({
          toolCallId: 'tc-unk',
          toolName: 'bash',
          result: { reason: 'DIFFERENT' },
        }),
      /conflict|Conflict|terminal result/i,
    );
  });

  it('conflicts with SUCCEEDED/FAILED/CANCELLED/WAITING_APPROVAL/PROPOSED', async () => {
    const { gov } = makeGov();

    // PROPOSED
    await gov.recordPolicyDecision({
      toolCallId: 'tc-prop',
      toolName: 'bash',
      args: {},
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
        gov.recordToolUnknown({
          toolCallId: 'tc-prop',
          toolName: 'bash',
        }),
      /cannot mark UNKNOWN from status PROPOSED/i,
    );

    // SUCCEEDED
    await prepareRunning(gov, 'tc-ok');
    await gov.recordToolEnded({
      toolCallId: 'tc-ok',
      toolName: 'bash',
      isError: false,
      result: { ok: true },
    });
    await assert.rejects(
      () =>
        gov.recordToolUnknown({
          toolCallId: 'tc-ok',
          toolName: 'bash',
        }),
      /already terminal as SUCCEEDED/i,
    );

    // FAILED via normal recordToolEnded
    await prepareRunning(gov, 'tc-fail');
    await gov.recordToolEnded({
      toolCallId: 'tc-fail',
      toolName: 'bash',
      isError: true,
      result: { err: 'boom' },
    });
    assert.equal(
      state.tables.tool_executions.find((t) => t.tool_call_id === 'tc-fail')
        .status,
      TOOL_EXECUTION_STATUS.FAILED,
    );
    await assert.rejects(
      () =>
        gov.recordToolUnknown({
          toolCallId: 'tc-fail',
          toolName: 'bash',
        }),
      /already terminal as FAILED/i,
    );

    // WAITING_APPROVAL
    await gov.recordPolicyDecision({
      toolCallId: 'tc-appr',
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
      toolCallId: 'tc-appr',
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
        gov.recordToolUnknown({
          toolCallId: 'tc-appr',
          toolName: 'mcp__x__y',
        }),
      /WAITING_APPROVAL|approval is pending/i,
    );

    // CANCELLED — force status
    await prepareRunning(gov, 'tc-cancel');
    const cancelRow = state.tables.tool_executions.find(
      (t) => t.tool_call_id === 'tc-cancel',
    );
    cancelRow.status = TOOL_EXECUTION_STATUS.CANCELLED;
    cancelRow.completed_at = '2026-07-18 12:00:00.000';
    await assert.rejects(
      () =>
        gov.recordToolUnknown({
          toolCallId: 'tc-cancel',
          toolName: 'bash',
        }),
      /already terminal as CANCELLED/i,
    );
  });

  it('normal recordToolEnded errors remain FAILED (not UNKNOWN)', async () => {
    const { gov } = makeGov();
    await prepareRunning(gov, 'tc-err');
    const r = await gov.recordToolEnded({
      toolCallId: 'tc-err',
      toolName: 'bash',
      isError: true,
      result: { message: 'exit 1' },
    });
    assert.equal(r.toolExecution.status, TOOL_EXECUTION_STATUS.FAILED);
    assert.notEqual(r.toolExecution.status, TOOL_EXECUTION_STATUS.UNKNOWN);
  });
});
