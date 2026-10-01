/**
 * A1（design `agent-output-review.md` §4）：review 会话的 `artifact.ready`
 * 负载多一个 `review_status: "pending"`，direct 会话的事件形状**不变**。
 *
 * 这个字段是前端「已提交审核」卡片与「Run 终态建审核任务」的共同判据，所以两条
 * 都要钉住：多写了会让 direct 会话凭空出现审核卡片；少写了 review 会话的交付物
 * 会直接当成交付——两个方向都错。
 *
 * 离线跑（fake knex），不需要 MySQL。
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { FencedToolGovernanceRecorder } from '../../src/application/fenced-tool-governance-recorder.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const TRACE = 'b'.repeat(32);
const ARTIFACT = '01K0G2PAV8FPMVC9QHJG7JPN5K';
const SHA256 = 'a'.repeat(64);

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
  state.tables.tbl_agsvc_runs = [{
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
    started_at: '2026-10-01 00:00:00.000',
    completed_at: null,
    created_at: '2026-10-01 00:00:00.000',
    updated_at: '2026-10-01 00:00:00.000',
  }];
  state.tables.tbl_agsvc_agent_sessions = [{
    agent_session_id: SESS,
    org_id: ORG,
    user_id: USER,
    conversation_id: CONV,
    agent_version_id: VER,
    sandbox_session_id: SBX,
    workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
    status: 'ACTIVE',
    session_version: 0,
    last_run_id: RUN,
    execution_fence_token: 3,
    recovery_reason_code: null,
    created_at: '2026-10-01 00:00:00.000',
    updated_at: '2026-10-01 00:00:00.000',
    closed_at: null,
  }];
  state.tables.tbl_agsvc_tool_executions = [];
  state.tables.tbl_agsvc_approvals = [];
  state.tables.tbl_agsvc_sandbox_audit_events = [];
  state.tables.tbl_agsvc_run_events = [];
  state.tables.tbl_agsvc_domain_outbox = [];
}

function makeRecorder(knex, nextId, deliveryMode) {
  return new FencedToolGovernanceRecorder({
    transactionManager: { run: (fn) => knex.transaction(fn) },
    createRepositories: (db) =>
      createRepositoryBundle(db, { now: () => new Date(), generateId: nextId }),
    generateId: nextId,
    context: RUN_CTX,
    executionFenceToken: 3,
    now: () => new Date('2026-10-01T12:00:00.000Z'),
    deliveryMode,
  });
}

async function runSubmitArtifact(recorder) {
  const call = { toolCallId: 'tc-artifact-1', toolName: 'submit_artifact', args: { path: 'report.md' } };
  await recorder.recordToolStarted(call);
  await recorder.recordToolEnded({
    ...call,
    isError: false,
    result: {
      artifactId: ARTIFACT,
      name: 'report.md',
      mimeType: 'text/markdown',
      size: 42,
      sha256: SHA256,
    },
  });
}

describe('A1: artifact.ready 的 review_status', () => {
  let state;
  let knex;
  let nextId;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seedWorld(state);
    nextId = createUlidGenerator({ now: () => 1_790_000_000_000 });
  });

  it('review 会话：负载带 review_status=pending，并同事务写进 run_events', async () => {
    const recorder = makeRecorder(knex, nextId, 'review');
    await runSubmitArtifact(recorder);

    const row = state.tables.tbl_agsvc_run_events.find((r) => r.event_type === 'artifact.ready');
    assert.ok(row, 'artifact.ready must be recorded');
    const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    assert.equal(payload.data.artifactId, ARTIFACT);
    assert.equal(payload.data.review_status, 'pending');
    // 归属仍取事件上下文，不是负载里的任意字段。
    assert.equal(payload.context.orgId, ORG);
    assert.equal(payload.context.runId, RUN);
  });

  it('direct 会话：事件形状与以前一致，没有 review_status 键', async () => {
    const recorder = makeRecorder(knex, nextId, 'direct');
    await runSubmitArtifact(recorder);

    const row = state.tables.tbl_agsvc_run_events.find((r) => r.event_type === 'artifact.ready');
    assert.ok(row);
    const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    assert.equal(Object.hasOwn(payload.data, 'review_status'), false);
  });

  it('缺省（未传 deliveryMode）按 direct 处理，不会凭空打开审核', async () => {
    const recorder = makeRecorder(knex, nextId, undefined);
    await runSubmitArtifact(recorder);
    const row = state.tables.tbl_agsvc_run_events.find((r) => r.event_type === 'artifact.ready');
    const payload = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
    assert.equal(Object.hasOwn(payload.data, 'review_status'), false);
  });
});
