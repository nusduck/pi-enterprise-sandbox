/**
 * 审核服务的**语义**测试（design `agent-output-review.md` §5.2 / §6.1 / §7）。
 *
 * 路由测试证明形状（`tests/http/review-http.unit.test.ts`），这里证明「谁能审、
 * 什么时候拒绝、通过之后写了什么」：每条拒绝都配一条合法操作的成功对照
 * （AGENTS.md §3：避免「全部拒绝」假通过）。
 *
 * 用内存替身而不是 fake-knex：这里要钉的是**判定顺序与事务里写了哪几行**，不是
 * SQL 形状（那是仓储与集成测试的事）。跨服务调用（exec）用记录调用的替身。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReviewService, ReviewError } from '../../src/application/review-service.js';
import { toMysqlDateTime } from '../../src/infrastructure/mysql/row-mappers.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const REQUESTER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const REVIEWER = '01K0G2PAV8FPMVC9QHJG7JPN51';
const OTHER_REVIEWER = '01K0G2PAV8FPMVC9QHJG7JPN52';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN70';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const ARTIFACT = 'art_0123456789abcdef';
const REVISED = 'art_fedcba9876543210';

const ACTOR = { provider: 'bff', externalOrgId: 'ext-org', externalUserId: 'ext-user', requestId: null, callerType: 'web', role: 'reviewer' };

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    reviewTaskId: TASK,
    orgId: ORG,
    requesterUserId: REQUESTER,
    conversationId: CONV,
    agentSessionId: SESSION,
    runId: RUN,
    agentId: '01K0G2PAV8FPMVC9QHJG7JPN5A',
    agentVersionId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
    runStatus: 'SUCCEEDED',
    status: 'IN_REVIEW',
    assigneeUserId: REVIEWER,
    claimedAt: '2026-10-01 10:00:00.000',
    revision: 3,
    feedback: null,
    decidedBy: null,
    decidedAt: null,
    contextInjectedRunId: null,
    createdAt: '2026-10-01 09:00:00.000',
    updatedAt: '2026-10-01 10:00:00.000',
    ...overrides,
  };
}

function harness(options: { task?: any; items?: any[]; events?: any[]; questions?: any[]; rows?: any[]; claim?: number; decide?: number; transport?: any } = {}) {
  const state = {
    task: options.task ?? taskRow(),
    items: options.items ?? [{
      itemNo: 1,
      originalArtifactId: ARTIFACT,
      currentArtifactId: ARTIFACT,
      name: '报告.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
    }],
    events: options.events ?? [],
    insertedOutbox: [] as any[],
    appendedEvents: [] as any[],
    appendedMessages: [] as any[],
    appendedRunEvents: [] as any[],
    decided: [] as any[],
    listQueries: [] as any[],
  };

  const reviews = {
    async getTask(id: string, orgId: string) {
      if (options.rows) {
        return options.rows.find((row: any) => row.reviewTaskId === id && row.orgId === orgId) ?? null;
      }
      return state.task && id === state.task.reviewTaskId && orgId === state.task.orgId ? state.task : null;
    },
    async listItems() { return state.items; },
    async listEvents() { return state.events; },
    async listMaterials() { return []; },
    async getMaterial() { return null; },
    async listUserQuestionsUpToRun() { return options.questions ?? []; },
    async listTasks(input: any) {
      state.listQueries.push(input);
      if (!options.rows) return [state.task];
      // 模仿仓储：状态过滤 + keyset 游标 + 倒序，游标值按 MySQL DATETIME 字面量比较。
      let out = options.rows.slice();
      if (input.statuses) out = out.filter((row: any) => input.statuses.includes(row.status));
      if (input.cursor) {
        out = out.filter((row: any) => {
          const at = toMysqlDateTime(row.createdAt);
          return (
            at < input.cursor.createdAt ||
            (at === input.cursor.createdAt && row.reviewTaskId < input.cursor.reviewTaskId)
          );
        });
      }
      out.sort((a: any, b: any) =>
        a.createdAt === b.createdAt
          ? (a.reviewTaskId < b.reviewTaskId ? 1 : -1)
          : (a.createdAt < b.createdAt ? 1 : -1));
      return out.slice(0, input.limit);
    },
    async claim() { return options.claim ?? 1; },
    async releaseClaim() { return 1; },
    async decide(input: any) {
      state.decided.push(input);
      return options.decide ?? 1;
    },
    async appendEvent(input: any) { state.appendedEvents.push(input); return undefined; },
    async updateItemCurrentArtifact() { return 1; },
    async getItem(_id: string, no: number) { return state.items.find((item: any) => item.itemNo === no) ?? null; },
  };

  const repos = {
    reviews,
    organizations: { async getUser() { return { userId: REQUESTER, displayName: '发起人' }; } },
    sessions: { async getById() { return { workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN5G', sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F' }; } },
    runs: { async getById() { return { runId: RUN, orgId: ORG, userId: REQUESTER, conversationId: CONV, agentSessionId: SESSION, agentVersionId: '01K0G2PAV8FPMVC9QHJG7JPN5E', triggeringMessageId: '01K0G2PAV8FPMVC9QHJG7JPN5J', traceId: 'b'.repeat(32) }; } },
    catalog: {
      async getVersionById() { return { versionNo: 2 }; },
      async getDefinitionById() { return { agentId: '01K0G2PAV8FPMVC9QHJG7JPN5A', name: '分析智能体' }; },
    },
    messages: { async append(input: any) { state.appendedMessages.push(input); return input; } },
    runEvents: { async append(input: any) { state.appendedRunEvents.push(input); return { eventId: input.eventId, sequenceNo: 11 }; } },
    outbox: { async insert(row: any) { state.insertedOutbox.push(row); return row; } },
  };

  let n = 0;
  const service = new ReviewService({
    db: {},
    createRepositories: () => repos,
    transactionManager: { run: async (work: any) => await work({}) },
    generateId: () => `01K0G2PAV8FPMVC9QHJG7JPN${String(60 + n++).padStart(2, '0')}`,
    now: () => new Date('2026-10-01T12:00:00.000Z'),
    reviewTransport: options.transport ?? null,
    resolveOwner: async (actor: any) => {
      if (!String(actor?.externalOrgId ?? '').trim()) throw new Error('no org');
      if (actor.externalUserId === 'requester') return { orgId: ORG, userId: REQUESTER };
      if (actor.externalUserId === 'other') return { orgId: ORG, userId: OTHER_REVIEWER };
      return { orgId: ORG, userId: REVIEWER };
    },
  });

  return { service, state };
}

async function expectCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof ReviewError, `expected ReviewError, got ${String(err)}`);
    assert.equal((err as ReviewError).code, code);
    return true;
  });
}

describe('审核服务：角色与作用域', () => {
  it('非 reviewer → 403 REVIEWER_REQUIRED，且不碰仓储', async () => {
    const { service } = harness();
    await expectCode(
      () => service.getTaskDetail({ ...ACTOR, role: 'user' }, TASK),
      'REVIEWER_REQUIRED',
    );
    await expectCode(() => service.listTasks({ ...ACTOR, role: null }, {}), 'REVIEWER_REQUIRED');
  });

  it('reviewer → 列表与详情成功（合法对照）', async () => {
    const { service } = harness();
    const list = await service.listTasks(ACTOR, {}) as any;
    assert.equal(list.tasks.length, 1);
    const detail = await service.getTaskDetail(ACTOR, TASK) as any;
    assert.equal(detail.review_task_id, TASK);
    assert.equal(detail.revision, 3);
    assert.equal(detail.items[0].current_artifact_id, ARTIFACT);
  });

  it('跨 org / 不存在的任务 → 404（与「存在但属于别人」同码）', async () => {
    const { service } = harness();
    await expectCode(() => service.getTaskDetail(ACTOR, '01K0G2PAV8FPMVC9QHJG7JPN99'), 'NOT_FOUND');
  });
});

describe('审核服务：列表状态筛选（T5）', () => {
  it('逗号分隔的多状态：白名单内的值全部下推到仓储（历史页签只列已通过/已驳回）', async () => {
    const { service, state } = harness();
    await service.listTasks(ACTOR, { status: 'APPROVED,REJECTED' });
    assert.deepEqual(state.listQueries[0].statuses, ['APPROVED', 'REJECTED']);
  });

  it('大小写、空白与重复值都被规范化，顺序按输入', async () => {
    const { service, state } = harness();
    await service.listTasks(ACTOR, { status: ' approved , REJECTED ,approved,' });
    assert.deepEqual(state.listQueries[0].statuses, ['APPROVED', 'REJECTED']);
  });

  it('单值筛选行为不变（待领取页签）', async () => {
    const { service, state } = harness();
    await service.listTasks(ACTOR, { status: 'PENDING' });
    assert.deepEqual(state.listQueries[0].statuses, ['PENDING']);
  });

  it('空值 = 不筛选', async () => {
    const { service, state } = harness();
    await service.listTasks(ACTOR, { status: '  ' });
    assert.equal(state.listQueries[0].statuses, null);
  });

  it('列表里只要有一个未知状态值 → 422 REVIEW_INPUT_INVALID，不静默忽略', async () => {
    const { service, state } = harness();
    await expectCode(() => service.listTasks(ACTOR, { status: 'APPROVED,PENDINGX' }), 'REVIEW_INPUT_INVALID');
    assert.equal(state.listQueries.length, 0, '非法输入不该打到仓储');
  });
});

describe('审核列表翻页（R1：游标格式改动后仍与库里的值可比）', () => {
  function pagedRows() {
    return [0, 1, 2, 3, 4].map((index) =>
      taskRow({
        reviewTaskId: `01K0G2PAV8FPMVC9QHJG7JPN6${index}`,
        // 映射后的形状：带 Z 的 ISO（仓储读路径用 formatDateTime）。
        createdAt: `2026-10-01T0${index}:00:00.000Z`,
      }),
    );
  }

  it('两页拿全、不重不漏；第二页的游标与库里的 DATETIME 可比', async () => {
    const { service, state } = harness({ rows: pagedRows() });
    const page1 = (await service.listTasks(ACTOR, { limit: 3 })) as any;
    assert.equal(page1.tasks.length, 3);
    assert.ok(page1.next_cursor, '还有下一页');

    // 游标交给仓储的必须是 MySQL 字面量，不是 ISO——否则同一行会再出现一次。
    const page2 = (await service.listTasks(ACTOR, { limit: 3, cursor: page1.next_cursor })) as any;
    assert.equal(state.listQueries[1].cursor.createdAt, '2026-10-01 02:00:00.000');
    assert.equal(page2.tasks.length, 2);
    assert.equal(page2.next_cursor, null, '最后一页');

    const ids = [...page1.tasks, ...page2.tasks].map((task: any) => task.review_task_id);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5, '不重');
    assert.deepEqual(
      ids,
      ['01K0G2PAV8FPMVC9QHJG7JPN64', '01K0G2PAV8FPMVC9QHJG7JPN63', '01K0G2PAV8FPMVC9QHJG7JPN62',
       '01K0G2PAV8FPMVC9QHJG7JPN61', '01K0G2PAV8FPMVC9QHJG7JPN60'],
      '按时间倒序、不漏',
    );
  });

  it('伪造/失效的游标 → 422，不从头发一页', async () => {
    const { service } = harness({ rows: pagedRows() });
    const bad = Buffer.from('nonsense|01K0G2PAV8FPMVC9QHJG7JPN99', 'utf8').toString('base64url');
    await expectCode(() => service.listTasks(ACTOR, { cursor: bad }), 'REVIEW_INPUT_INVALID');
  });
});

describe('审核工作台的信息投影（§3.2）', () => {
  it('列表带首件交付物名与智能体名（同一发起人的十几行才分得清）', async () => {
    const { service } = harness();
    const list = await service.listTasks(ACTOR, {}) as any;
    assert.equal(list.tasks[0].first_item_name, '报告.md');
    assert.equal(list.tasks[0].agent_name, '分析智能体');
    assert.equal(list.tasks[0].item_count, 1);
  });

  it('没有交付物的任务 first_item_name 是 null，不是空串', async () => {
    const { service } = harness({ items: [] });
    const list = await service.listTasks(ACTOR, {}) as any;
    assert.equal(list.tasks[0].first_item_name, null);
    assert.equal(list.tasks[0].item_count, 0);
  });

  it('详情元信息带智能体名称，提问标出触发本次任务的那一条', async () => {
    const { service } = harness({
      questions: [
        { messageId: '01K0G2PAV8FPMVC9QHJG7JPN5K', sequenceNo: 1, text: '上一轮的提问', createdAt: null, attachments: [] },
        { messageId: '01K0G2PAV8FPMVC9QHJG7JPN5J', sequenceNo: 2, text: '本次的提问', createdAt: null, attachments: [] },
      ],
    });
    const detail = await service.getTaskDetail(ACTOR, TASK) as any;
    assert.equal(detail.agent.name, '分析智能体');
    assert.equal(detail.agent.version_no, 2);
    assert.equal(detail.questions[0].triggering, false);
    assert.equal(detail.questions[1].triggering, true);
  });

  it('版本链：原件是智能体、修订是审核员显示名，时间来自审计事件', async () => {
    const { service } = harness({
      items: [{
        itemNo: 1,
        originalArtifactId: ARTIFACT,
        currentArtifactId: REVISED,
        name: '报告.md',
        mimeType: 'text/markdown',
        sizeBytes: 20,
        sha256: 'a'.repeat(64),
      }],
      events: [{
        eventId: '01K0G2PAV8FPMVC9QHJG7JPN80',
        eventType: 'revised',
        actorUserId: REVIEWER,
        itemNo: 1,
        fromArtifactId: ARTIFACT,
        toArtifactId: REVISED,
        detail: null,
        createdAt: '2026-10-01 11:00:00.000',
      }],
    });
    const detail = await service.getTaskDetail(ACTOR, TASK) as any;
    const versions = detail.items[0].versions;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].uploaded_by_kind, 'agent');
    assert.equal(versions[0].current, false);
    assert.equal(versions[1].uploaded_by_kind, 'reviewer');
    assert.equal(versions[1].uploaded_by_user_id, REVIEWER);
    assert.equal(versions[1].uploaded_by_display_name, '发起人');
    assert.equal(versions[1].created_at, '2026-10-01 11:00:00.000');
    assert.equal(versions[1].size, 20, '当前版本的大小是账本里跟着 current 的那个');
  });

  it('非当前版本的大小从 exec 元数据补；补不上就留 null（界面显示「—」）', async () => {
    const transport = {
      async readArtifactMeta({ artifactIds }: any) {
        return artifactIds.map((id: string) => ({
          artifactId: id,
          name: '报告.md',
          mimeType: 'text/markdown',
          size: id === ARTIFACT ? 44 : 20,
          sha256: '',
          visibility: 'held',
          revisionOf: null,
          createdByKind: id === ARTIFACT ? 'agent' : 'reviewer',
          createdAt: '2026-10-01T10:00:00.000Z',
        }));
      },
    };
    const items = [{
      itemNo: 1,
      originalArtifactId: ARTIFACT,
      currentArtifactId: REVISED,
      name: '报告.md',
      mimeType: 'text/markdown',
      sizeBytes: 20,
      sha256: 'a'.repeat(64),
    }];
    const events = [{
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN80',
      eventType: 'revised',
      actorUserId: REVIEWER,
      itemNo: 1,
      fromArtifactId: ARTIFACT,
      toArtifactId: REVISED,
      detail: null,
      createdAt: '2026-10-01 11:00:00.000',
    }];

    const enriched = await harness({ transport, items, events }).service.getTaskDetail(ACTOR, TASK) as any;
    assert.equal(enriched.items[0].versions[0].size, 44, '被替换的原件大小来自 exec');

    const failing = {
      async readArtifactMeta() { throw new Error('review plane down'); },
    };
    const degraded = await harness({ transport: failing, items, events }).service.getTaskDetail(ACTOR, TASK) as any;
    assert.equal(degraded.items[0].versions[0].size, null, '取不到就是 null，不猜');
    assert.equal(degraded.items[0].versions[1].size, 20);
  });
});

describe('审核服务：领取与职责分离', () => {
  it('发起人本人（即使有 reviewer）领取自己的任务 → 403 REVIEW_SELF_FORBIDDEN', async () => {
    const { service } = harness();
    await expectCode(
      () => service.claim({ ...ACTOR, externalUserId: 'requester' }, TASK),
      'REVIEW_SELF_FORBIDDEN',
    );
  });

  it('别的 reviewer 领取 → 成功并写 claimed 审计', async () => {
    const { service, state } = harness({ task: taskRow({ status: 'PENDING', assigneeUserId: null }) });
    const detail = await service.claim(ACTOR, TASK) as any;
    assert.equal(detail.review_task_id, TASK);
    assert.equal(state.appendedEvents.length, 1);
    assert.equal(state.appendedEvents[0].eventType, 'claimed');
    assert.equal(state.appendedEvents[0].actorUserId, REVIEWER);
  });

  it('已被领取 → 409 REVIEW_ALREADY_CLAIMED（条件更新影响 0 行）', async () => {
    const { service } = harness({ claim: 0 });
    await expectCode(() => service.claim(ACTOR, TASK), 'REVIEW_ALREADY_CLAIMED');
  });

  it('已决任务不能领取 → 409 REVIEW_ALREADY_DECIDED', async () => {
    const { service } = harness({ task: taskRow({ status: 'APPROVED' }) });
    await expectCode(() => service.claim(ACTOR, TASK), 'REVIEW_ALREADY_DECIDED');
  });

  it('非领取人不能释放；领取人可以（合法对照）', async () => {
    const { service } = harness();
    await expectCode(
      () => service.releaseClaim({ ...ACTOR, role: 'reviewer', externalUserId: 'other' }, TASK),
      'REVIEW_NOT_ASSIGNEE',
    );
  });
});

describe('审核服务：通过', () => {
  it('版本不符 → 409 REVIEW_VERSION_CONFLICT，带 current_revision', async () => {
    const { service } = harness();
    await assert.rejects(
      () => service.approve(ACTOR, TASK, { baseRevision: 1 }),
      (err: unknown) => {
        assert.equal((err as ReviewError).code, 'REVIEW_VERSION_CONFLICT');
        assert.deepEqual((err as ReviewError).details, { current_revision: 3 });
        return true;
      },
    );
  });

  it('非领取人不能决定 → 403 REVIEW_NOT_ASSIGNEE', async () => {
    const { service } = harness();
    await expectCode(
      () => service.approve({ ...ACTOR, externalUserId: 'other' }, TASK, { baseRevision: 3 }),
      'REVIEW_NOT_ASSIGNEE',
    );
  });

  it('通过：任务转 APPROVED、写审计/事件/消息/两行 outbox', async () => {
    const { service, state } = harness();
    await service.approve(ACTOR, TASK, { baseRevision: 3, note: '可以' });

    assert.equal(state.decided.length, 1);
    assert.equal(state.decided[0].status, 'APPROVED');
    assert.equal(state.decided[0].expectedRevision, 3);
    assert.equal(state.appendedEvents[0].eventType, 'approved');
    assert.equal(state.appendedEvents[0].detail, '可以');

    // 原 Run 上挂 artifact.released（前端重放靠它刷新卡片）。
    assert.equal(state.appendedRunEvents.length, 1);
    assert.equal(state.appendedRunEvents[0].eventType, 'artifact.released');
    assert.equal(state.appendedRunEvents[0].payloadJson.data.reviewTaskId, TASK);

    // 会话消息：assistant/text，kind=review_released（plan §8.7 冻结枚举内）。
    assert.equal(state.appendedMessages.length, 1);
    assert.equal(state.appendedMessages[0].role, 'assistant');
    assert.equal(state.appendedMessages[0].messageType, 'text');
    assert.equal(state.appendedMessages[0].contentJson.kind, 'review_released');

    // 两行 outbox：放行工作项 + 通知。工作项里当前版本 released、其余 withdrawn。
    const reviewRow = state.insertedOutbox.find((row) => row.aggregateType === 'review');
    const notifyRow = state.insertedOutbox.find((row) => row.aggregateType === 'review_notification');
    assert.ok(reviewRow);
    assert.ok(notifyRow);
    assert.deepEqual(reviewRow.payloadJson.updates, [{ artifactId: ARTIFACT, visibility: 'released' }]);
    assert.deepEqual(reviewRow.payloadJson.imports, []);
    // payload 里不能有 runId 键：RunEventStream 的 eligibility 会抢走它。
    assert.equal(Object.hasOwn(reviewRow.payloadJson, 'runId'), false);
    assert.equal(Object.hasOwn(notifyRow.payloadJson, 'runId'), false);
  });

  it('有修订时：当前版本放行、原件撤回，并把修订版导入 审核版/', async () => {
    const { service, state } = harness({
      items: [{
        itemNo: 1,
        originalArtifactId: ARTIFACT,
        currentArtifactId: REVISED,
        name: '报告.md',
        mimeType: 'text/markdown',
        sizeBytes: 20,
        sha256: 'c'.repeat(64),
      }],
      events: [{ eventType: 'revised', itemNo: 1, fromArtifactId: ARTIFACT, toArtifactId: REVISED }],
    });
    await service.approve(ACTOR, TASK, { baseRevision: 3 });

    const reviewRow = state.insertedOutbox.find((row) => row.aggregateType === 'review');
    assert.deepEqual(reviewRow.payloadJson.updates, [
      { artifactId: REVISED, visibility: 'released' },
      { artifactId: ARTIFACT, visibility: 'withdrawn' },
    ]);
    assert.deepEqual(reviewRow.payloadJson.imports, [
      { artifactId: REVISED, targetPath: '审核版/报告.md' },
    ]);
    const released = state.appendedRunEvents[0].payloadJson.data.artifacts;
    assert.equal(released[0].revised, true);
    // 前端靠原件 id 把聊天里那张「已提交审核」卡片对上修订版（2026-10-01 浏览器实测：缺它卡片永远停在待审）。
    assert.equal(released[0].artifactId, REVISED);
    assert.equal(released[0].originalArtifactId, ARTIFACT);
  });

  it('有修订时驳回：review.rejected 的每一项同样带原件 id', async () => {
    const { service, state } = harness({
      items: [{
        itemNo: 1,
        originalArtifactId: ARTIFACT,
        currentArtifactId: REVISED,
        name: '报告.md',
        mimeType: 'text/markdown',
        sizeBytes: 20,
        sha256: 'c'.repeat(64),
      }],
      events: [{ eventType: 'revised', itemNo: 1, fromArtifactId: ARTIFACT, toArtifactId: REVISED }],
    });
    await service.reject(ACTOR, TASK, { baseRevision: 3, feedback: '数据来源不完整' });
    const rejected = state.appendedRunEvents[0].payloadJson.data.artifacts;
    assert.equal(rejected[0].originalArtifactId, ARTIFACT);
  });
});

describe('审核服务：驳回', () => {
  it('反馈缺失 → 422 REVIEW_FEEDBACK_REQUIRED', async () => {
    const { service } = harness();
    await expectCode(() => service.reject(ACTOR, TASK, { baseRevision: 3, feedback: '   ' }), 'REVIEW_FEEDBACK_REQUIRED');
  });

  it('驳回：任务转 REJECTED、全部版本撤回、写 system/status 消息与 review.rejected', async () => {
    const { service, state } = harness();
    await service.reject(ACTOR, TASK, { baseRevision: 3, feedback: '数据来源不完整' });

    assert.equal(state.decided[0].status, 'REJECTED');
    assert.equal(state.appendedRunEvents[0].eventType, 'review.rejected');
    assert.equal(state.appendedRunEvents[0].payloadJson.data.feedback, '数据来源不完整');
    assert.equal(state.appendedMessages[0].role, 'system');
    assert.equal(state.appendedMessages[0].messageType, 'status');
    assert.equal(state.appendedMessages[0].contentJson.kind, 'review_rejected');

    const reviewRow = state.insertedOutbox.find((row) => row.aggregateType === 'review');
    assert.deepEqual(reviewRow.payloadJson.updates, [{ artifactId: ARTIFACT, visibility: 'withdrawn' }]);
    assert.deepEqual(reviewRow.payloadJson.imports, []);
  });
});

describe('审核服务：修订上传的大小上限', () => {
  it('超过 REVIEW_TRANSFER_MAX_BYTES（100 MiB）→ REVIEW_FILE_INVALID，且不调用 exec', async () => {
    const { REVIEW_TRANSFER_MAX_BYTES } = await import('@dsh/contract/delivery-policy.js');
    const { service } = harness();
    await expectCode(
      () => service.uploadRevision(ACTOR, TASK, 1, {
        baseRevision: 3,
        bytes: Buffer.alloc(REVIEW_TRANSFER_MAX_BYTES + 1),
      }),
      'REVIEW_FILE_INVALID',
    );
  });
});

describe('审核服务：下载超过审核传输上限', () => {
  it('exec 报 review_transfer_too_large → 413 REVIEW_FILE_TOO_LARGE（不是 500）', async () => {
    const { InternalReviewError } = await import('../../src/infrastructure/sandbox/internal-review-http.js');
    const transport = {
      async getArtifact() {
        throw new InternalReviewError('review_transfer_too_large', 'Sandbox review request failed (413)', { httpStatus: 413 });
      },
    };
    const { service } = harness({ transport });
    await expectCode(() => service.readArtifact(ACTOR, TASK, ARTIFACT), 'REVIEW_FILE_TOO_LARGE');
  });
});
