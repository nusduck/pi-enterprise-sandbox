/**
 * 恢复扫描收尾「有取消意图、没有活租约」的 RUNNING Run 时，工具账本也要收尾。
 *
 * 2026-10-02 查库发现：Worker 强杀后，恢复扫描因账本里有 RUNNING 的工具行（副作用未知）
 * 不重放、转人工；随后用户取消，恢复扫描把 Run 推到 CANCELLED，但工具行一直停在 RUNNING。
 * RUNNING 行收尾为 UNKNOWN（结果不明的 fail-closed 终态），未开始的行收尾为 CANCELLED。
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { RunRecoveryService } from '../../src/application/run-recovery-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import { applyRunTransitionInTxn } from '../../src/application/run-transition.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL_RUNNING = '01K0G2PAV8FPMVC9QHJG7JPN56';
const TOOL_PROPOSED = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TOOL_DONE = '01K0G2PAV8FPMVC9QHJG7JPN58';
const TRACE = 'c'.repeat(32);
const NOW = '2026-10-02 01:02:03.004';

function tool(id, callId, name, status) {
  return {
    tool_execution_id: id,
    run_id: RUN,
    agent_session_id: SESSION,
    tool_call_id: callId,
    tool_name: name,
    tool_source: 'internal',
    risk_level: 'low',
    arguments_json: JSON.stringify({}),
    result_json: status === 'SUCCEEDED' ? JSON.stringify({ ok: true }) : null,
    status,
    error_code: null,
    trace_id: TRACE,
    request_hash: null,
    request_hash_version: null,
    execution_fence_token: null,
    started_at: NOW,
    completed_at: status === 'SUCCEEDED' ? NOW : null,
    created_at: NOW,
  };
}

function seed(state, { cancelIntent }) {
  state.tables.tbl_agsvc_runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONVERSATION,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status: RUN_STATUS.RUNNING,
      status_reason: null,
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      trace_state: null,
      next_event_sequence: 0,
      cancel_requested_at: cancelIntent ? NOW : null,
      cancel_reason: cancelIntent ? 'user cancelled' : null,
      cancel_requested_by: cancelIntent ? USER : null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.tbl_agsvc_tool_executions = [
    tool(TOOL_DONE, 'call-done', 'read_file', 'SUCCEEDED'),
    tool(TOOL_RUNNING, 'call-running', 'bash', 'RUNNING'),
    tool(TOOL_PROPOSED, 'call-proposed', 'write_file', 'PROPOSED'),
  ];
  state.tables.tbl_agsvc_run_interactions = [];
  state.tables.tbl_agsvc_run_events = [];
  state.tables.tbl_agsvc_domain_outbox = [];
  state.tables.tbl_agsvc_trace_spans = [];
  state.tables.tbl_agsvc_agent_sessions = [
    {
      agent_session_id: SESSION,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONVERSATION,
      agent_version_id: VERSION,
      workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
      status: 'ACTIVE',
      execution_fence_token: 1,
      session_version: 0,
      last_run_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

function toolStatus(state, id) {
  return state.tables.tbl_agsvc_tool_executions.find((t) => t.tool_execution_id === id);
}

describe('RunRecoveryService: cancel intent closes open tool ledger rows', () => {
  let state;
  let knex;
  let enqueued;
  let recovery;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    enqueued = [];
    const generateId = createUlidGenerator({ now: () => 1_759_366_923_004 });
    recovery = new RunRecoveryService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      runQueue: {
        async enqueue(ref, options) {
          enqueued.push({ ref, options });
        },
      },
      generateId,
      leaseManager: {
        async getOwner() {
          return null;
        },
      },
    });
  });

  it('cancelled run leaves no RUNNING / PROPOSED tool rows behind', async () => {
    seed(state, { cancelIntent: true });

    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });

    assert.equal(state.tables.tbl_agsvc_runs[0].status, RUN_STATUS.CANCELLED, JSON.stringify(action));
    const running = toolStatus(state, TOOL_RUNNING);
    assert.equal(running.status, 'UNKNOWN', 'side effects of an interrupted tool are unknown');
    assert.equal(running.error_code, 'RUN_CANCELLED_OUTCOME_UNKNOWN');
    assert.ok(running.completed_at, 'closed rows carry completed_at');
    const proposed = toolStatus(state, TOOL_PROPOSED);
    assert.equal(proposed.status, 'CANCELLED');
    assert.equal(proposed.error_code, 'RUN_CANCELLED');
    assert.equal(toolStatus(state, TOOL_DONE).status, 'SUCCEEDED', 'terminal rows are untouched');

    const failed = state.tables.tbl_agsvc_run_events.filter((e) => e.event_type === 'tool.execution.failed');
    assert.equal(failed.length, 2, 'one tool event per closed row');
    const events = state.tables.tbl_agsvc_run_events.map((e) => e.event_type);
    assert.ok(events.includes('run.cancelled'), JSON.stringify(events));
    assert.equal(enqueued.length, 0, 'a cancelled run must not be re-enqueued');
  });

  it('without cancel intent the open RUNNING tool still blocks replay and stays RUNNING', async () => {
    seed(state, { cancelIntent: false });

    await recovery.recoverOneRef({ runId: RUN, orgId: ORG });

    assert.equal(state.tables.tbl_agsvc_runs[0].status, RUN_STATUS.RUNNING);
    assert.equal(toolStatus(state, TOOL_RUNNING).status, 'RUNNING');
    assert.equal(toolStatus(state, TOOL_PROPOSED).status, 'PROPOSED');
    assert.equal(enqueued.length, 0, 'unresolved tool outcome requires manual recovery');
  });
});

// 用户在 Worker 已死时点取消：取消服务先把 Run 推到 CANCELLING，随后由执行服务的
// #finishCancelled 做 CANCELLING→CANCELLED。两条路径都经 applyRunTransitionInTxn。
describe('applyRunTransitionInTxn: CANCELLED closes open tool rows; other terminals do not', () => {
  for (const [to, expectRunning] of [
    [RUN_STATUS.CANCELLED, 'UNKNOWN'],
    [RUN_STATUS.FAILED, 'RUNNING'],
  ]) {
    it(`CANCELLING/RUNNING → ${to}`, async () => {
      const state = createFakeState();
      const knex = createFakeKnex(state);
      seed(state, { cancelIntent: true });
      const from = to === RUN_STATUS.CANCELLED ? RUN_STATUS.CANCELLING : RUN_STATUS.RUNNING;
      state.tables.tbl_agsvc_runs[0].status = from;
      const generateId = createUlidGenerator({ now: () => 1_759_366_923_004 });
      await knex.transaction(async (trx) => {
        const repos = createRepositoryBundle(trx, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        });
        const result = await applyRunTransitionInTxn({
          repos,
          runId: RUN,
          scope: { orgId: ORG, userId: USER },
          from,
          to,
          traceId: TRACE,
          generateId,
          completedAt: new Date(),
        });
        assert.equal(result.ok, true);
      });
      assert.equal(state.tables.tbl_agsvc_runs[0].status, to);
      assert.equal(toolStatus(state, TOOL_RUNNING).status, expectRunning);
      assert.equal(toolStatus(state, TOOL_DONE).status, 'SUCCEEDED');
    });
  }
});
