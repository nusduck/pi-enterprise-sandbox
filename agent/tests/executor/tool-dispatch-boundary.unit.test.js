/**
 * DSH 工具派发边界（2026-09-17，STATUS G2）。
 *
 * DSH 的顺序是 `tools/pre-execute`（策略判定）→ `tools/execute`（`recordToolStarted`
 * → 派发）。Pi 时代反过来，所以 `recordToolStarted` 在没有策略指纹时刻意留一行
 * PROPOSED 占位等策略来接管；DSH 下没人接管，命令执行期间账本一直是 PROPOSED，
 * `request_hash` / `execution_fence_token` 也从未绑定（真实 DSH gate 场景 3 观测）。
 *
 * 这里钉的是：`recordToolStarted` 返回之前，账本已经是 RUNNING；sandbox 工具还在
 * 同一事务里绑定了请求指纹与当前 fence。离线，fake knex。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedToolGovernanceRecorder } from '../../src/application/fenced-tool-governance-recorder.js';
import { computeSandboxToolRequestHash } from '../../src/application/sandbox-request-binder.js';
import { TOOL_EXECUTION_STATUS } from '../../src/domain/tool/tool-execution-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const TRACE = 'c'.repeat(32);
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN5G';
const FENCE = 7;

function seedWorld(state, { sessionFence = FENCE, sandboxSessionId = SBX } = {}) {
  state.tables.tbl_agsvc_runs = [
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
      queue_name: 'agent-runs',
      attempt: 1,
      trace_id: TRACE,
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      started_at: '2026-09-17 00:00:00.000',
      completed_at: null,
      created_at: '2026-09-17 00:00:00.000',
      updated_at: '2026-09-17 00:00:00.000',
    },
  ];
  state.tables.tbl_agsvc_agent_sessions = [
    {
      agent_session_id: SESS,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_version_id: VER,
      sandbox_session_id: sandboxSessionId,
      workspace_id: WSP,
      status: 'ACTIVE',
      pi_session_version: 0,
      last_run_id: RUN,
      execution_fence_token: sessionFence,
      recovery_reason_code: null,
      created_at: '2026-09-17 00:00:00.000',
      updated_at: '2026-09-17 00:00:00.000',
      closed_at: null,
    },
  ];
  state.tables.tbl_agsvc_tool_executions = [];
  state.tables.tbl_agsvc_approvals = [];
  state.tables.tbl_agsvc_sandbox_audit_events = [];
  state.tables.tbl_agsvc_run_events = [];
  state.tables.tbl_agsvc_domain_outbox = [];
}

function makeRecorder(knex, nextId, { sandboxSessionId = SBX } = {}) {
  const emitted = [];
  const recorder = new FencedToolGovernanceRecorder({
    transactionManager: { run: (fn) => knex.transaction(fn) },
    createRepositories: (db) =>
      createRepositoryBundle(db, { now: () => new Date(), generateId: nextId }),
    generateId: nextId,
    context: {
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: SESS,
      runId: RUN,
      sandboxSessionId,
      traceId: TRACE,
      executionFenceToken: FENCE,
    },
    executionFenceToken: FENCE,
    now: () => new Date('2026-09-17T12:00:00.000Z'),
    emit: async (envelope) => {
      emitted.push(envelope);
    },
  });
  return { recorder, emitted };
}

describe('DSH dispatch boundary: recordToolStarted', () => {
  let state;
  let knex;
  let nextId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    nextId = createUlidGenerator({ now: () => 1_789_000_000_000 });
  });

  it('moves a sandbox tool to RUNNING and binds request hash + fence before returning', async () => {
    const { recorder, emitted } = makeRecorder(knex, nextId);
    const args = { command: 'printf hi > out.txt', description: 'write', timeoutMs: 1000 };

    const started = await recorder.recordToolStarted({
      toolCallId: 'call-bash-1',
      toolName: 'bash',
      args,
    });

    assert.equal(started.statusChanged, true);
    const row = state.tables.tbl_agsvc_tool_executions.find((r) => r.tool_call_id === 'call-bash-1');
    assert.equal(row.status, TOOL_EXECUTION_STATUS.RUNNING);
    assert.ok(row.started_at, 'started_at is set at the dispatch boundary');
    const expected = computeSandboxToolRequestHash({ toolName: 'bash', args });
    assert.equal(row.request_hash, expected.requestHash);
    assert.equal(Number(row.request_hash_version), expected.requestHashVersion);
    assert.equal(Number(row.execution_fence_token), FENCE);
    assert.equal(
      emitted.filter((e) => e.type === 'tool.execution.started').length,
      1,
    );
  });

  it('is idempotent for the same call and rejects different bytes for the same toolCallId', async () => {
    const { recorder } = makeRecorder(knex, nextId);
    const args = { command: 'ls', description: 'list' };
    await recorder.recordToolStarted({ toolCallId: 'call-bash-2', toolName: 'bash', args });
    const again = await recorder.recordToolStarted({ toolCallId: 'call-bash-2', toolName: 'bash', args });
    assert.equal(again.statusChanged, false);
    assert.equal(
      state.tables.tbl_agsvc_run_events.filter((e) => e.event_type === 'tool.execution.started').length,
      1,
    );
    await assert.rejects(() =>
      recorder.recordToolStarted({
        toolCallId: 'call-bash-2',
        toolName: 'bash',
        args: { command: 'rm -rf data', description: 'list' },
      }),
    );
  });

  it('moves a non-sandbox tool to RUNNING without a sandbox request binding', async () => {
    const { recorder } = makeRecorder(knex, nextId);
    await recorder.recordToolStarted({
      toolCallId: 'call-ask-1',
      toolName: 'ask_user_question',
      args: { questions: [] },
    });
    const row = state.tables.tbl_agsvc_tool_executions.find((r) => r.tool_call_id === 'call-ask-1');
    assert.equal(row.status, TOOL_EXECUTION_STATUS.RUNNING);
    assert.equal(row.request_hash, null);
    assert.equal(row.execution_fence_token, null);
  });

  it('fails closed on a stale fence: nothing is recorded as started', async () => {
    seedWorld(state, { sessionFence: FENCE + 1 });
    const { recorder } = makeRecorder(knex, nextId);
    await assert.rejects(() =>
      recorder.recordToolStarted({
        toolCallId: 'call-bash-stale',
        toolName: 'bash',
        args: { command: 'ls', description: 'list' },
      }),
    );
    assert.equal(
      state.tables.tbl_agsvc_tool_executions.some((r) => r.status === TOOL_EXECUTION_STATUS.RUNNING),
      false,
    );
  });

  it('still reaches RUNNING when the session has no sandbox session id (binding needs one)', async () => {
    seedWorld(state, { sandboxSessionId: null });
    const { recorder } = makeRecorder(knex, nextId, { sandboxSessionId: null });
    await recorder.recordToolStarted({
      toolCallId: 'call-bash-nosbx',
      toolName: 'bash',
      args: { command: 'ls', description: 'list' },
    });
    const row = state.tables.tbl_agsvc_tool_executions.find((r) => r.tool_call_id === 'call-bash-nosbx');
    assert.equal(row.status, TOOL_EXECUTION_STATUS.RUNNING);
    assert.equal(row.request_hash, null);
  });
});
