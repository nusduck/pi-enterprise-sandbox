/**
 * 四个列表接口的服务层分页契约（design ui-polish §2.4）。
 *
 * 用**真仓储 + 真服务 + 内存假 knex**：只有这样才能同时证明三件事——
 * 排序键与游标是同一个值、`limit+1` 的多取一条真的驱动 `next_cursor`、
 * 作用域在游标之前生效（跨用户游标拿不到别人的行）。
 *
 * 错误路径同样重要：解不出来的游标必须 400（`ValidationError`）而不是静默从头发
 * 一页；越界的 `limit` 不 clamp。
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationService } from '../../src/application/conversation-service.js';
import { ApprovalQueryService } from '../../src/application/approval-query-service.js';
import { CronJobService } from '../../src/application/cron-job-service.js';
import { ValidationError } from '../../src/application/errors.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../../src/application/keyset-cursor.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER_A = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER_B = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4X';
const RUN_A = '01K0G2PAV8FPMVC9QHJG7JPN53';
const RUN_B = '01K0G2PAV8FPMVC9QHJG7JPN54';
const NOW = '2026-07-18 09:00:00.000';

const AUTH_A = Object.freeze({ provider: 'bff', externalOrgId: 'org-ext', externalUserId: 'user-a' });
const AUTH_B = Object.freeze({ provider: 'bff', externalOrgId: 'org-ext', externalUserId: 'user-b' });

/** A 的会话：c1/c2/c3，更新时间递增；c2 与 c3 的 id 顺序与时间顺序相反，用来证明双键排序。 */
const CONV_A1 = '01K0G2PAV8FPMVC9QHJG7JPN61';
const CONV_A2 = '01K0G2PAV8FPMVC9QHJG7JPN62';
const CONV_A3 = '01K0G2PAV8FPMVC9QHJG7JPN63';
const CONV_B1 = '01K0G2PAV8FPMVC9QHJG7JPN71';
const CONV_B2 = '01K0G2PAV8FPMVC9QHJG7JPN72';

const T10 = '2026-07-18 10:00:00.000';
const T11 = '2026-07-18 11:00:00.000';
const T12 = '2026-07-18 12:00:00.000';

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

const APPROVAL_A1 = '01K0G2PAV8FPMVC9QHJG7JPN81';
const APPROVAL_A2 = '01K0G2PAV8FPMVC9QHJG7JPN82';
const APPROVAL_A3 = '01K0G2PAV8FPMVC9QHJG7JPN83';
const APPROVAL_B1 = '01K0G2PAV8FPMVC9QHJG7JPN84';

function cronJob(cronJobId, userId, createdAt) {
  return {
    cron_job_id: cronJobId,
    org_id: ORG,
    user_id: userId,
    agent_id: AGENT,
    name: `任务 ${cronJobId.slice(-2)}`,
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

const CRON_A1 = '01K0G2PAV8FPMVC9QHJG7JPN91';
const CRON_A2 = '01K0G2PAV8FPMVC9QHJG7JPN92';
const CRON_A3 = '01K0G2PAV8FPMVC9QHJG7JPN93';
const CRON_B1 = '01K0G2PAV8FPMVC9QHJG7JPN94';

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
    conversation(CONV_B1, USER_B, T11, 'B 的会话 1'),
    conversation(CONV_B2, USER_B, T12, 'B 的会话 2'),
  ];
  state.tables.tbl_agsvc_runs = [
    { run_id: RUN_A, org_id: ORG, user_id: USER_A, conversation_id: CONV_A1 },
    { run_id: RUN_B, org_id: ORG, user_id: USER_B, conversation_id: CONV_B1 },
  ];
  state.tables.tbl_agsvc_approvals = [
    approval(APPROVAL_A1, RUN_A, T10),
    approval(APPROVAL_A2, RUN_A, T11),
    approval(APPROVAL_A3, RUN_A, T11),
    approval(APPROVAL_B1, RUN_B, T12),
  ];
  state.tables.tbl_agsvc_cron_jobs = [
    cronJob(CRON_A1, USER_A, T10),
    cronJob(CRON_A2, USER_A, T11),
    cronJob(CRON_A3, USER_A, T11),
    cronJob(CRON_B1, USER_B, T12),
  ];
}

describe('列表分页的服务层契约', () => {
  let state;
  let knex;
  let conversations;
  let approvals;
  let cronJobs;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    seed(state);
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    const createRepositories = (db) => createRepositoryBundle(db, {
      now: () => new Date('2026-07-18T09:00:00.000Z'),
      generateId,
    });
    conversations = new ConversationService({
      transactionManager: { run: (work) => knex.transaction(work) },
      createRepositories,
      db: knex,
      generateId,
      now: () => new Date('2026-07-18T09:00:00.000Z'),
    });
    approvals = new ApprovalQueryService({ createRepositories, db: knex });
    cronJobs = new CronJobService({
      transactionManager: { run: (work) => knex.transaction(work) },
      createRepositories,
      db: knex,
      createRunService: { execute: async () => ({ runId: RUN_A }) },
      generateId,
      now: () => new Date('2026-07-18T09:00:00.000Z'),
    });
  });

  it('会话列表：多取一条才会给出 next_cursor，末页为 null', async () => {
    const first = await conversations.list(AUTH_A, { limit: '2' });
    assert.deepEqual(first.conversations.map((row) => row.id), [CONV_A3, CONV_A2]);
    assert.equal(typeof first.next_cursor, 'string');
    assert.equal(first.conversations.length, 2);

    const second = await conversations.list(AUTH_A, { limit: '2', cursor: first.next_cursor });
    assert.deepEqual(second.conversations.map((row) => row.id), [CONV_A1]);
    assert.equal(second.next_cursor, null);
  });

  it('会话列表：不给 limit 时默认 30，一页装得下就没有下一页', async () => {
    const page = await conversations.list(AUTH_A);
    assert.equal(page.conversations.length, 3);
    assert.equal(page.next_cursor, null);
  });

  it('会话列表：limit 越界与非法 cursor 都是 ValidationError（HTTP 400）', async () => {
    for (const limit of ['0', '101', 'abc', '-1', '1.5']) {
      await assert.rejects(
        conversations.list(AUTH_A, { limit }),
        (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        `limit=${limit} 应该被拒绝`,
      );
    }
    await assert.rejects(
      conversations.list(AUTH_A, { cursor: 'not-a-cursor' }),
      (err) => err instanceof ValidationError,
    );
    await assert.rejects(
      conversations.list(AUTH_A, { q: 'a'.repeat(101) }),
      (err) => err instanceof ValidationError,
    );
    // 100 是边界内，收。
    const page = await conversations.list(AUTH_A, { limit: '100' });
    assert.equal(page.conversations.length, 3);
  });

  it('会话列表：标题搜索转义 LIKE 元字符，搜 % 不命中全部', async () => {
    const percent = await conversations.list(AUTH_A, { q: '%' });
    assert.deepEqual(percent.conversations.map((row) => row.id), [CONV_A2]);

    const plain = await conversations.list(AUTH_A, { q: '周报' });
    assert.deepEqual(plain.conversations.map((row) => row.id), [CONV_A1]);

    // 搜索也会先套作用域：B 搜 A 的标题什么也拿不到。
    const crossUser = await conversations.list(AUTH_B, { q: '周报' });
    assert.deepEqual(crossUser.conversations, []);
  });

  it('会话列表：跨用户游标只表示位置，拒绝对照与合法对照都在', async () => {
    const aFirst = await conversations.list(AUTH_A, { limit: '2' });
    // 游标编码的就是排序列的值 + 那一行的主键（第二行的 updated_at 与 id）。
    assert.deepEqual(decodeKeysetCursor(aFirst.next_cursor), {
      sortValue: '2026-07-18T11:00:00.000Z',
      key: CONV_A2,
    });

    // 拒绝对照：A 最新一行（T12）的游标交给 B——位置照常生效（B 更旧的会话翻得到），
    // 但结果里只能有 B 自己的行，A 的一条都不出现。
    const foreignCursor = encodeKeysetCursor('2026-07-18T12:00:00.000Z', CONV_A3);
    const bWithACursor = await conversations.list(AUTH_B, { limit: '10', cursor: foreignCursor });
    assert.deepEqual(bWithACursor.conversations.map((row) => row.id), [CONV_B1]);
    assert.equal(
      bWithACursor.conversations.some((row) => [CONV_A1, CONV_A2, CONV_A3].includes(row.id)),
      false,
    );

    // 合法对照：B 用自己的游标正常翻页。
    const bFirst = await conversations.list(AUTH_B, { limit: '1' });
    assert.deepEqual(bFirst.conversations.map((row) => row.id), [CONV_B2]);
    const bSecond = await conversations.list(AUTH_B, { limit: '1', cursor: bFirst.next_cursor });
    assert.deepEqual(bSecond.conversations.map((row) => row.id), [CONV_B1]);
    assert.equal(bSecond.next_cursor, null);
  });

  it('审批列表：{ approvals, next_cursor }，跨用户游标不泄漏', async () => {
    const first = await approvals.list(AUTH_A, { limit: '2' });
    assert.deepEqual(first.approvals.map((row) => row.approval_id), [APPROVAL_A3, APPROVAL_A2]);
    assert.equal(typeof first.next_cursor, 'string');

    const second = await approvals.list(AUTH_A, { limit: '2', cursor: first.next_cursor });
    assert.deepEqual(second.approvals.map((row) => row.approval_id), [APPROVAL_A1]);
    assert.equal(second.next_cursor, null);

    const crossUser = await approvals.list(AUTH_B, { limit: '10', cursor: first.next_cursor });
    assert.deepEqual(crossUser.approvals, []);

    await assert.rejects(
      approvals.list(AUTH_A, { cursor: 'garbage' }),
      (err) => err instanceof ValidationError,
    );
    await assert.rejects(
      approvals.list(AUTH_A, { limit: '999' }),
      (err) => err instanceof ValidationError,
    );
  });

  it('定时任务列表：默认 50、双键翻页、跨用户游标不泄漏', async () => {
    const first = await cronJobs.list(AUTH_A, { limit: '2' });
    assert.deepEqual(first.cron_jobs.map((row) => row.cron_job_id), [CRON_A3, CRON_A2]);
    assert.equal(typeof first.next_cursor, 'string');

    const second = await cronJobs.list(AUTH_A, { limit: '2', cursor: first.next_cursor });
    assert.deepEqual(second.cron_jobs.map((row) => row.cron_job_id), [CRON_A1]);
    assert.equal(second.next_cursor, null);

    const defaults = await cronJobs.list(AUTH_A, {});
    assert.equal(defaults.cron_jobs.length, 3);
    assert.equal(defaults.next_cursor, null);

    const crossUser = await cronJobs.list(AUTH_B, { limit: '10', cursor: first.next_cursor });
    assert.deepEqual(crossUser.cron_jobs, []);

    await assert.rejects(
      cronJobs.list(AUTH_A, { cursor: 'garbage' }),
      (err) => err instanceof ValidationError,
    );
    await assert.rejects(
      cronJobs.list(AUTH_A, { limit: '0' }),
      (err) => err instanceof ValidationError,
    );
  });

  it('没有 provisioned owner 的受信身份拿到空页而不是报错', async () => {
    const stranger = { provider: 'bff', externalOrgId: 'org-ext', externalUserId: 'nobody' };
    assert.deepEqual(await conversations.list(stranger, { limit: '2' }), {
      conversations: [],
      next_cursor: null,
    });
    assert.deepEqual(await approvals.list(stranger, { limit: '2' }), {
      approvals: [],
      next_cursor: null,
    });
    assert.deepEqual(await cronJobs.list(stranger, { limit: '2' }), {
      cron_jobs: [],
      next_cursor: null,
    });
  });
});
