/**
 * 列表分页的 HTTP 面（design ui-polish §2.4）。
 *
 * 走**真实的 HTTP 服务器 + 真服务 + 真仓储（内存假 knex）**，因为要证明的正是
 * 「服务层的 ValidationError 在路由上变成 400 VALIDATION_ERROR」以及响应键名——
 * 这一层是 BFF 与浏览器唯一看得到的东西。用假服务替身就只证明了替身。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { ConversationService } from '../../src/application/conversation-service.js';
import { ApprovalQueryService } from '../../src/application/approval-query-service.js';
import { CronJobService } from '../../src/application/cron-job-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER_A = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER_B = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4X';
const RUN_A = '01K0G2PAV8FPMVC9QHJG7JPN53';
const RUN_B = '01K0G2PAV8FPMVC9QHJG7JPN54';
const NOW = '2026-07-18 09:00:00.000';
const T10 = '2026-07-18 10:00:00.000';
const T11 = '2026-07-18 11:00:00.000';
const T12 = '2026-07-18 12:00:00.000';

const CONV_A1 = '01K0G2PAV8FPMVC9QHJG7JPN61';
const CONV_A2 = '01K0G2PAV8FPMVC9QHJG7JPN62';
const CONV_A3 = '01K0G2PAV8FPMVC9QHJG7JPN63';
const CONV_B1 = '01K0G2PAV8FPMVC9QHJG7JPN71';
const APPROVAL_A1 = '01K0G2PAV8FPMVC9QHJG7JPN81';
const APPROVAL_A2 = '01K0G2PAV8FPMVC9QHJG7JPN82';
const APPROVAL_A3 = '01K0G2PAV8FPMVC9QHJG7JPN83';
const CRON_A1 = '01K0G2PAV8FPMVC9QHJG7JPN91';
const CRON_A2 = '01K0G2PAV8FPMVC9QHJG7JPN92';
const CRON_A3 = '01K0G2PAV8FPMVC9QHJG7JPN93';

function conversation(conversationId, userId, updatedAt, title) {
  return {
    conversation_id: conversationId,
    org_id: ORG,
    user_id: userId,
    agent_id: AGENT,
    parent_run_id: null,
    title,
    status: 'active',
    current_agent_session_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
    archived_at: null,
  };
}

function approval(approvalId, runId, createdAt) {
  return {
    approval_id: approvalId,
    org_id: ORG,
    run_id: runId,
    tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN56',
    requested_by: USER_A,
    decision_by: null,
    status: 'PENDING',
    request_json: JSON.stringify({ toolName: 'bash' }),
    decision_reason: null,
    expires_at: null,
    created_at: createdAt,
    decided_at: null,
  };
}

function cronJob(cronJobId, createdAt) {
  return {
    cron_job_id: cronJobId,
    org_id: ORG,
    user_id: USER_A,
    agent_id: AGENT,
    name: 'daily',
    prompt: 'p',
    schedule_type: 'cron',
    cron_expression: '0 9 * * *',
    run_at: null,
    timezone: 'UTC',
    enabled: true,
    next_run_at: null,
    last_run_at: null,
    misfire_policy: 'fire_once',
    concurrency_policy: 'forbid',
    auth_provider: 'bff',
    external_org_id: 'org-ext',
    external_user_id: 'user-a',
    deleted_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function seed(state) {
  state.tables.tbl_agsvc_organizations = [
    { org_id: ORG, name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW },
  ];
  state.tables.tbl_agsvc_organization_external_refs = [
    { provider: 'bff', external_subject: 'org-ext', org_id: ORG, created_at: NOW },
  ];
  state.tables.tbl_agsvc_users = [
    { user_id: USER_A, external_subject: 'bff:user-a', display_name: 'A', email: null, status: 'active', created_at: NOW, updated_at: NOW },
    { user_id: USER_B, external_subject: 'bff:user-b', display_name: 'B', email: null, status: 'active', created_at: NOW, updated_at: NOW },
  ];
  state.tables.tbl_agsvc_organization_memberships = [
    { org_id: ORG, user_id: USER_A, role: 'owner', status: 'active', created_at: NOW },
    { org_id: ORG, user_id: USER_B, role: 'member', status: 'active', created_at: NOW },
  ];
  state.tables.tbl_agsvc_conversations = [
    conversation(CONV_A1, USER_A, T10, '周报汇总'),
    conversation(CONV_A2, USER_A, T11, '50% off 活动'),
    conversation(CONV_A3, USER_A, T12, '普通会话'),
    // B 的会话刻意比 A 的第一页游标更旧：跨用户游标必须能定位到它（位置生效），
    // 但绝不能带出 A 的任何一行。
    conversation(CONV_B1, USER_B, T10, 'B 的会话'),
  ];
  state.tables.tbl_agsvc_runs = [
    { run_id: RUN_A, org_id: ORG, user_id: USER_A, conversation_id: CONV_A1 },
    { run_id: RUN_B, org_id: ORG, user_id: USER_B, conversation_id: CONV_B1 },
  ];
  state.tables.tbl_agsvc_approvals = [
    approval(APPROVAL_A1, RUN_A, T10),
    approval(APPROVAL_A2, RUN_A, T11),
    approval(APPROVAL_A3, RUN_A, T11),
  ];
  state.tables.tbl_agsvc_cron_jobs = [
    cronJob(CRON_A1, T10),
    cronJob(CRON_A2, T11),
    cronJob(CRON_A3, T11),
  ];
}

describe('列表分页的 HTTP 路由', () => {
  let server;
  let port;

  before(async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    seed(state);
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    const createRepositories = (db) => createRepositoryBundle(db, {
      now: () => new Date('2026-07-18T09:00:00.000Z'),
      generateId,
    });
    const conversationService = new ConversationService({
      transactionManager: { run: (work) => knex.transaction(work) },
      createRepositories,
      db: knex,
      generateId,
      now: () => new Date('2026-07-18T09:00:00.000Z'),
    });
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      conversationService,
      approvalQueryService: new ApprovalQueryService({ createRepositories, db: knex }),
      cronJobService: new CronJobService({
        transactionManager: { run: (work) => knex.transaction(work) },
        createRepositories,
        db: knex,
        createRunService: { execute: async () => ({ runId: RUN_A }) },
        generateId,
        now: () => new Date('2026-07-18T09:00:00.000Z'),
      }),
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function get(path, { user = 'user-a' } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: {
        'x-acting-user-id': user,
        'x-acting-organization-id': 'org-ext',
        'x-acting-role': 'user',
      },
    });
    return { status: response.status, body: await response.json() };
  }

  it('GET /internal/conversations 返回 { conversations, next_cursor } 并支持翻页', async () => {
    const first = await get('/internal/conversations?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['conversations', 'next_cursor']);
    assert.deepEqual(first.body.conversations.map((row) => row.id), [CONV_A3, CONV_A2]);
    assert.equal(typeof first.body.next_cursor, 'string');

    const second = await get(
      `/internal/conversations?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    assert.deepEqual(second.body.conversations.map((row) => row.id), [CONV_A1]);
    assert.equal(second.body.next_cursor, null);
  });

  it('GET /internal/conversations 的 q 走服务端搜索（转义后的 LIKE）', async () => {
    const percent = await get('/internal/conversations?q=%25');
    assert.deepEqual(percent.body.conversations.map((row) => row.id), [CONV_A2]);
    const plain = await get(`/internal/conversations?q=${encodeURIComponent('周报')}`);
    assert.deepEqual(plain.body.conversations.map((row) => row.id), [CONV_A1]);
  });

  it('会话列表：非法 cursor / limit 越界 → 400 VALIDATION_ERROR（不再是静默 clamp）', async () => {
    for (const path of [
      '/internal/conversations?cursor=not-a-cursor',
      '/internal/conversations?limit=101',
      '/internal/conversations?limit=0',
      '/internal/conversations?limit=abc',
    ]) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.code, 'VALIDATION_ERROR', path);
    }
  });

  it('会话列表：别人的游标只落在自己的行集里（拒绝对照 + 合法对照）', async () => {
    const aFirst = await get('/internal/conversations?limit=2');
    const foreign = await get(
      `/internal/conversations?limit=10&cursor=${encodeURIComponent(aFirst.body.next_cursor)}`,
      { user: 'user-b' },
    );
    assert.deepEqual(foreign.body.conversations.map((row) => row.id), [CONV_B1]);

    const bOwn = await get('/internal/conversations?limit=1', { user: 'user-b' });
    assert.deepEqual(bOwn.body.conversations.map((row) => row.id), [CONV_B1]);
    assert.equal(bOwn.body.next_cursor, null);
  });

  it('GET /internal/approvals 返回 { approvals, next_cursor }，不再重复给 items', async () => {
    const first = await get('/internal/approvals?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['approvals', 'next_cursor']);
    assert.deepEqual(first.body.approvals.map((row) => row.approval_id), [APPROVAL_A3, APPROVAL_A2]);

    const second = await get(
      `/internal/approvals?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    assert.deepEqual(second.body.approvals.map((row) => row.approval_id), [APPROVAL_A1]);
    assert.equal(second.body.next_cursor, null);

    const bad = await get('/internal/approvals?cursor=garbage');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_ERROR');
  });

  it('GET /internal/cron-jobs 返回 { cron_jobs, next_cursor } 并支持翻页', async () => {
    const first = await get('/internal/cron-jobs?limit=2');
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ['cron_jobs', 'next_cursor']);
    assert.deepEqual(first.body.cron_jobs.map((row) => row.cron_job_id), [CRON_A3, CRON_A2]);

    const second = await get(
      `/internal/cron-jobs?limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    assert.deepEqual(second.body.cron_jobs.map((row) => row.cron_job_id), [CRON_A1]);
    assert.equal(second.body.next_cursor, null);

    for (const path of ['/internal/cron-jobs?cursor=garbage', '/internal/cron-jobs?limit=101']) {
      const { status, body } = await get(path);
      assert.equal(status, 400, path);
      assert.equal(body.code, 'VALIDATION_ERROR', path);
    }
  });
});
