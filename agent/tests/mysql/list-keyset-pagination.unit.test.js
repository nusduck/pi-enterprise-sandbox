/**
 * 四个列表接口的 keyset 分页仓储层（design ui-polish §2.4）。
 *
 * 这里守着两件在真机上很难复现、在代码里一眼看不出来的事：
 * 1. **作用域先于游标**：跨用户的游标只能落在使用者自己的行集里。拒绝对照
 *    （A 的游标交给 B）与合法对照（B 自己的游标正常翻页）都要有，否则「全部
 *    拒绝」也会绿。
 * 2. **双键排序**：只按时间排序时，同一毫秒的两行在翻页时会重复或漏掉。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ConversationRepository } from '../../src/infrastructure/mysql/repositories/conversation-repository.js';
import { ApprovalRepository } from '../../src/infrastructure/mysql/repositories/approval-repository.js';
import { CronJobRepository } from '../../src/infrastructure/mysql/repositories/cron-job-repository.js';
import { SkillShareRequestRepository } from '../../src/infrastructure/mysql/repositories/skill-share-request-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const FOREIGN_USER = '01K0G2PAV8FPMVC9QHJG7JPN5F';
const FOREIGN_ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Y';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4X';

const C1 = '01K0G2PAV8FPMVC9QHJG7JPN61';
const C2 = '01K0G2PAV8FPMVC9QHJG7JPN62';
const C3 = '01K0G2PAV8FPMVC9QHJG7JPN63';
const C4 = '01K0G2PAV8FPMVC9QHJG7JPN64';
const C_FOREIGN_USER = '01K0G2PAV8FPMVC9QHJG7JPN65';
const C_FOREIGN_ORG = '01K0G2PAV8FPMVC9QHJG7JPN66';
const C_SUBAGENT = '01K0G2PAV8FPMVC9QHJG7JPN67';
const C_ARCHIVED = '01K0G2PAV8FPMVC9QHJG7JPN68';

const T10 = '2026-07-18 10:00:00.000';
const T11 = '2026-07-18 11:00:00.000';
const T12 = '2026-07-18 12:00:00.000';

function conversation(conversationId, opts = {}) {
  const at = opts.updatedAt || T10;
  return {
    conversation_id: conversationId,
    org_id: opts.orgId || ORG,
    user_id: opts.userId || USER,
    agent_id: AGENT,
    parent_run_id: opts.parentRunId || null,
    title: opts.title || `会话 ${conversationId.slice(-2)}`,
    status: opts.status || 'active',
    current_agent_session_id: null,
    created_at: at,
    updated_at: at,
    archived_at: opts.archivedAt || null,
  };
}

describe('ConversationRepository keyset 分页', () => {
  function conversationState() {
    const state = createFakeState();
    state.tables.tbl_agsvc_conversations = [
      conversation(C1, { updatedAt: T10 }),
      conversation(C2, { updatedAt: T11 }),
      conversation(C3, { updatedAt: T11 }),
      conversation(C4, { updatedAt: T12 }),
      conversation(C_FOREIGN_USER, { userId: FOREIGN_USER, updatedAt: T12 }),
      conversation(C_FOREIGN_ORG, { orgId: FOREIGN_ORG, updatedAt: T12 }),
      conversation(C_SUBAGENT, { parentRunId: '01K0G2PAV8FPMVC9QHJG7JPN53', updatedAt: T12 }),
      conversation(C_ARCHIVED, { archivedAt: T12, status: 'archived', updatedAt: T12 }),
    ];
    return state;
  }

  it('按 updated_at desc, conversation_id desc 翻页且不重不漏', async () => {
    const repo = new ConversationRepository(createFakeKnex(conversationState()));
    const scope = { orgId: ORG, userId: USER };

    const first = await repo.listForOwner(scope, { limit: 2 });
    assert.deepEqual(first.map((row) => row.conversationId), [C4, C3]);

    const cursor = { sortValue: first[1].updatedAt, key: first[1].conversationId };
    const second = await repo.listForOwner(scope, { limit: 2, before: cursor });
    assert.deepEqual(second.map((row) => row.conversationId), [C2, C1]);

    const last = await repo.listForOwner(scope, {
      limit: 2,
      before: { sortValue: second[1].updatedAt, key: second[1].conversationId },
    });
    assert.deepEqual(last, []);
  });

  it('列表隐藏归档、子代理会话与别的作用域，但 cursor 仍只表示位置', async () => {
    const repo = new ConversationRepository(createFakeKnex(conversationState()));
    const visible = await repo.listForOwner({ orgId: ORG, userId: USER }, { limit: 50 });
    assert.deepEqual(
      visible.map((row) => row.conversationId),
      [C4, C3, C2, C1],
    );

    // 拒绝对照：A 的游标交给 B，B 只看到自己的行（这里为空），拿不到 A 的任何会话。
    const cursorFromA = { sortValue: visible[0].updatedAt, key: visible[0].conversationId };
    const foreign = await repo.listForOwner(
      { orgId: ORG, userId: FOREIGN_USER },
      { limit: 50, before: cursorFromA },
    );
    assert.deepEqual(foreign.map((row) => row.conversationId), []);

    // 合法对照：B 自己的游标能正常翻页。
    const bPage = await repo.listForOwner({ orgId: ORG, userId: FOREIGN_USER }, { limit: 50 });
    assert.deepEqual(bPage.map((row) => row.conversationId), [C_FOREIGN_USER]);
    const bNext = await repo.listForOwner(
      { orgId: ORG, userId: FOREIGN_USER },
      { limit: 50, before: { sortValue: bPage[0].updatedAt, key: bPage[0].conversationId } },
    );
    assert.deepEqual(bNext, []);

    // 跨 org 同理：别的 org 的行无论在不在游标之前都不可见。
    const otherOrg = await repo.listForOwner({ orgId: FOREIGN_ORG, userId: USER }, { limit: 50 });
    assert.deepEqual(otherOrg.map((row) => row.conversationId), [C_FOREIGN_ORG]);
  });

  it('标题搜索转义 LIKE 元字符：搜 % 不命中全部', async () => {
    const state = createFakeState();
    state.tables.tbl_agsvc_conversations = [
      conversation(C1, { title: '周报汇总' }),
      conversation(C2, { title: '50% off 活动' }),
      conversation(C3, { title: 'x_y 命名' }),
      conversation(C4, { title: '百分之百' }),
    ];
    const repo = new ConversationRepository(createFakeKnex(state));

    const percent = await repo.listForOwner(
      { orgId: ORG, userId: USER },
      { limit: 50, titleQuery: '%' },
    );
    assert.deepEqual(percent.map((row) => row.conversationId), [C2]);

    const underscore = await repo.listForOwner(
      { orgId: ORG, userId: USER },
      { limit: 50, titleQuery: '_' },
    );
    assert.deepEqual(underscore.map((row) => row.conversationId), [C3]);

    const plain = await repo.listForOwner(
      { orgId: ORG, userId: USER },
      { limit: 50, titleQuery: '周报' },
    );
    assert.deepEqual(plain.map((row) => row.conversationId), [C1]);
  });
});

// ── 审批 ──────────────────────────────────────────────────────────────────

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const A1 = '01K0G2PAV8FPMVC9QHJG7JPN71';
const A2 = '01K0G2PAV8FPMVC9QHJG7JPN72';
const A3 = '01K0G2PAV8FPMVC9QHJG7JPN73';
const A_FOREIGN = '01K0G2PAV8FPMVC9QHJG7JPN74';
const A_FOREIGN_OLD = '01K0G2PAV8FPMVC9QHJG7JPN75';
const FOREIGN_RUN = '01K0G2PAV8FPMVC9QHJG7JPN54';

function approval(approvalId, { createdAt = T10, status = 'PENDING', userId = USER, orgId = ORG, runId = RUN } = {}) {
  return {
    approval_id: approvalId,
    org_id: orgId,
    run_id: runId,
    tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN56',
    requested_by: userId,
    decision_by: null,
    status,
    request_json: JSON.stringify({ toolName: 'bash' }),
    decision_reason: null,
    expires_at: null,
    created_at: createdAt,
    decided_at: null,
  };
}

describe('ApprovalRepository keyset 分页', () => {
  function approvalState() {
    const state = createFakeState();
    state.tables.tbl_agsvc_runs = [
      { run_id: RUN, org_id: ORG, user_id: USER, conversation_id: C1 },
      { run_id: FOREIGN_RUN, org_id: ORG, user_id: FOREIGN_USER, conversation_id: C_FOREIGN_USER },
    ];
    state.tables.tbl_agsvc_approvals = [
      approval(A1, { createdAt: T10 }),
      approval(A2, { createdAt: T11 }),
      approval(A3, { createdAt: T11 }),
      // 同一个 org、同一个 Run 的归属只看 Run 的 user_id，所以这两条是 B 的。
      approval(A_FOREIGN, { createdAt: T12, runId: FOREIGN_RUN, userId: FOREIGN_USER }),
      approval(A_FOREIGN_OLD, { createdAt: T10, runId: FOREIGN_RUN, userId: FOREIGN_USER }),
    ];
    return state;
  }

  it('按 created_at desc, approval_id desc 翻页，别人的行不参与排序也不出现', async () => {
    const repo = new ApprovalRepository(createFakeKnex(approvalState()));
    const scope = { orgId: ORG, userId: USER };

    const first = await repo.listForOwner(scope, { limit: 2 });
    assert.deepEqual(first.map((row) => row.approvalId), [A3, A2]);

    const next = await repo.listForOwner(scope, {
      limit: 2,
      before: { sortValue: first[1].createdAt, key: first[1].approvalId },
    });
    assert.deepEqual(next.map((row) => row.approvalId), [A1]);

    // 拒绝对照：A 的游标交给 B，只落在 B 自己的行集里——B 那条更旧的审批照常
    // 翻得到，A 的三条一条都不出现。
    const crossUser = await repo.listForOwner(
      { orgId: ORG, userId: FOREIGN_USER },
      { limit: 10, before: { sortValue: first[0].createdAt, key: first[0].approvalId } },
    );
    assert.deepEqual(crossUser.map((row) => row.approvalId), [A_FOREIGN_OLD]);

    // 合法对照：B 用自己的游标正常翻页。
    const bFirst = await repo.listForOwner({ orgId: ORG, userId: FOREIGN_USER }, { limit: 1 });
    assert.deepEqual(bFirst.map((row) => row.approvalId), [A_FOREIGN]);
    const bNext = await repo.listForOwner(
      { orgId: ORG, userId: FOREIGN_USER },
      { limit: 1, before: { sortValue: bFirst[0].createdAt, key: bFirst[0].approvalId } },
    );
    assert.deepEqual(bNext.map((row) => row.approvalId), [A_FOREIGN_OLD]);
  });

  it('status 过滤与游标同时生效', async () => {
    const state = approvalState();
    state.tables.tbl_agsvc_approvals.push(approval(A3, { createdAt: T12, status: 'APPROVED' }));
    const repo = new ApprovalRepository(createFakeKnex(state));
    const scope = { orgId: ORG, userId: USER };
    const approved = await repo.listForOwner(scope, { status: 'approved', limit: 10 });
    assert.deepEqual(approved.map((row) => row.approvalId), [A3]);
    const pending = await repo.listForOwner(scope, { status: 'pending', limit: 10 });
    assert.deepEqual(pending.map((row) => row.approvalId), [A3, A2, A1]);
    // 同一游标 + 同一 status 下翻页：过滤条件不会被游标替换掉。
    const paged = await repo.listForOwner(scope, {
      status: 'pending',
      limit: 10,
      before: { sortValue: T11, key: A3 },
    });
    assert.deepEqual(paged.map((row) => row.approvalId), [A2, A1]);
  });
});

// ── 定时任务 ───────────────────────────────────────────────────────────────

const J1 = '01K0G2PAV8FPMVC9QHJG7JPN81';
const J2 = '01K0G2PAV8FPMVC9QHJG7JPN82';
const J3 = '01K0G2PAV8FPMVC9QHJG7JPN83';
const J_DELETED = '01K0G2PAV8FPMVC9QHJG7JPN84';
const J_FOREIGN = '01K0G2PAV8FPMVC9QHJG7JPN85';

function cronJob(cronJobId, opts = {}) {
  return {
    cron_job_id: cronJobId,
    org_id: opts.orgId || ORG,
    user_id: opts.userId || USER,
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
    external_org_id: 'org',
    external_user_id: 'user',
    deleted_at: opts.deletedAt || null,
    created_at: opts.createdAt || T10,
    updated_at: opts.createdAt || T10,
  };
}

describe('CronJobRepository keyset 分页', () => {
  it('按 created_at desc, cron_job_id desc 翻页，软删除的行不出现', async () => {
    const state = createFakeState();
    state.tables.tbl_agsvc_cron_jobs = [
      cronJob(J1, { createdAt: T10 }),
      cronJob(J2, { createdAt: T11 }),
      cronJob(J3, { createdAt: T11 }),
      cronJob(J_DELETED, { createdAt: T12, deletedAt: T12 }),
      cronJob(J_FOREIGN, { createdAt: T12, userId: FOREIGN_USER }),
    ];
    const repo = new CronJobRepository(createFakeKnex(state));
    const scope = { orgId: ORG, userId: USER };

    const first = await repo.listForOwner(scope, { limit: 2 });
    assert.deepEqual(first.map((row) => row.cronJobId), [J3, J2]);

    const next = await repo.listForOwner(scope, {
      limit: 2,
      before: { sortValue: first[1].createdAt, key: first[1].cronJobId },
    });
    assert.deepEqual(next.map((row) => row.cronJobId), [J1]);
  });
});

// ── Skill 共享申请队列 ─────────────────────────────────────────────────────

const R1 = '01K0G2PAV8FPMVC9QHJG7JPN91';
const R2 = '01K0G2PAV8FPMVC9QHJG7JPN92';
const R3 = '01K0G2PAV8FPMVC9QHJG7JPN93';
const R_OTHER_ORG = '01K0G2PAV8FPMVC9QHJG7JPN94';

function shareRequest(requestId, opts = {}) {
  return {
    request_id: requestId,
    org_id: opts.orgId || ORG,
    requester_user_id: opts.requesterUserId || USER,
    skill_name: opts.name || 'sales-weekly',
    content_digest: 'a'.repeat(64),
    note: '',
    status: opts.status || 'pending',
    decided_by_user_id: '',
    decided_at: null,
    decision_note: '',
    created_at: opts.createdAt || T10,
  };
}

describe('SkillShareRequestRepository keyset 分页', () => {
  it('本 org 的队列按 created_at desc, request_id desc 翻页，别的 org 不出现', async () => {
    const state = createFakeState();
    state.tables.tbl_agsvc_skill_share_requests = [
      shareRequest(R1, { createdAt: T10 }),
      shareRequest(R2, { createdAt: T11 }),
      shareRequest(R3, { createdAt: T11 }),
      shareRequest(R_OTHER_ORG, { createdAt: T12, orgId: FOREIGN_ORG }),
    ];
    const repo = new SkillShareRequestRepository(createFakeKnex(state));

    const first = await repo.listForOrg({ orgId: ORG, limit: 2 });
    assert.deepEqual(first.map((row) => row.requestId), [R3, R2]);

    const next = await repo.listForOrg({
      orgId: ORG,
      limit: 2,
      before: { sortValue: first[1].createdAt, key: first[1].requestId },
    });
    assert.deepEqual(next.map((row) => row.requestId), [R1]);

    const otherOrg = await repo.listForOrg({ orgId: FOREIGN_ORG, limit: 10 });
    assert.deepEqual(otherOrg.map((row) => row.requestId), [R_OTHER_ORG]);

    // 拒绝对照：别的 org 的游标拿到本 org 来用，只表示位置——返回的还是本 org
    // 自己那三条（都比游标旧），那条别的 org 的申请一条都不出现。
    const crossOrg = await repo.listForOrg({
      orgId: ORG,
      limit: 10,
      before: { sortValue: otherOrg[0].createdAt, key: otherOrg[0].requestId },
    });
    assert.deepEqual(crossOrg.map((row) => row.requestId), [R3, R2, R1]);
    assert.equal(
      crossOrg.some((row) => row.requestId === R_OTHER_ORG),
      false,
    );
  });

  it('status 过滤与游标同时生效', async () => {
    const state = createFakeState();
    state.tables.tbl_agsvc_skill_share_requests = [
      shareRequest(R1, { createdAt: T10, status: 'approved' }),
      shareRequest(R2, { createdAt: T11, status: 'pending' }),
      shareRequest(R3, { createdAt: T12, status: 'rejected' }),
    ];
    const repo = new SkillShareRequestRepository(createFakeKnex(state));
    const pending = await repo.listForOrg({ orgId: ORG, status: 'pending', limit: 10 });
    assert.deepEqual(pending.map((row) => row.requestId), [R2]);
  });
});
