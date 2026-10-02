/**
 * 审核结果通知（design `agent-output-review.md` §4 A3）与 §5.4 上下文注入。
 *
 * 通知这边钉的是**聚合类型隔离**：审核通知必须走 `review_notification`，否则会被
 * Run 终态邮件消费者按「Run 结束了」的语义抢走（`outbox-status.ts` 记了这条坑）。
 * 注入这边钉的是**只注入一次**与「文本进提示词、不进消息行」。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY,
  REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY,
  RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
  rowMatchesEligibility,
} from '../../src/infrastructure/outbox/eligibility.js';
import { NotificationDispatcher } from '../../src/infrastructure/notification/notification-dispatcher.js';
import { buildReviewDecisionEmail, safeReviewFeedback } from '../../src/infrastructure/notification/review-notification-email.js';
import { buildReviewContextInjection } from '../../src/application/review-context-injection.js';
import { buildTriggeringPrompt, prependPlatformText } from '../../src/application/run-prompt-build.js';

const TASK = '01K0G2PAV8FPMVC9QHJG7JPN70';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const REQUESTER = '01K0G2PAV8FPMVC9QHJG7JPN50';

describe('审核结果通知', () => {
  it('聚合类型与 Run 终态通知互不认领，分发器两种都认领', () => {
    const row = { aggregate_type: 'review_notification', payload_json: { reviewTaskId: TASK } };
    assert.equal(rowMatchesEligibility(row, REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY), true);
    assert.equal(rowMatchesEligibility(row, RUN_NOTIFICATION_CLAIM_ELIGIBILITY), false);
    assert.equal(
      rowMatchesEligibility({ aggregate_type: 'run_notification' }, REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY),
      false,
    );
    assert.equal(rowMatchesEligibility(row, NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY), true);
    assert.equal(
      rowMatchesEligibility({ aggregate_type: 'run_notification' }, NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY),
      true,
    );
  });

  function harness(options: { status?: string; email?: string | null; notify?: boolean } = {}) {
    const state = {
      sent: [] as any[],
      deliveries: [] as any[],
      published: [] as string[],
      skipped: [] as string[],
    };
    const repos = {
      reviews: {
        async getTaskById() {
          return {
            reviewTaskId: TASK, runId: RUN, orgId: ORG, requesterUserId: REQUESTER,
            status: options.status ?? 'APPROVED', feedback: '数据来源不完整',
            conversationId: 'conv_1',
          };
        },
        async listItems() { return [{ name: '报告.md' }, { name: '数据.csv' }]; },
      },
    };
    const outbox = {
      async claimBatch() { return [{ outboxId: 'ob_1', claimToken: 'ct_1', aggregateId: TASK, eventType: 'notification.review_decided', attempts: 0, payloadJson: { reviewTaskId: TASK, orgId: ORG, requesterUserId: REQUESTER } }]; },
      async markPublished(id: string) { state.published.push(id); },
      async markFailed(id: string) { state.published.push(`failed:${id}`); },
      async markPendingForRetry() { return 'pending'; },
    };
    const store = {
      async loadRunContext() {
        return {
          runId: RUN, orgId: ORG, userId: REQUESTER, parentRunId: null, status: 'SUCCEEDED',
          conversationId: 'conv_1', conversationTitle: '季度分析', createdAt: null, completedAt: null,
          displayName: '发起人',
          email: options.email === undefined ? 'requester@example.com' : options.email,
          notifyRunComplete: options.notify !== false,
          notifyReviewResult: options.notify !== false,
          notifyReviewPending: true,
          notifyRunWaiting: true,
        };
      },
      async loadCronRun() { return null; },
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      async begin(input: any) {
        state.deliveries.push(input);
        return { created: true, delivery: { deliveryId: input.deliveryId, status: input.status, attempts: 0 } };
      },
      async markSent(id: string) { state.deliveries.push({ sent: id }); },
      async recordFailure() {},
    };
    const publisher = new NotificationDispatcher({
      outbox,
      store: store as any,
      createRepositories: (db: unknown) => {
        assert.ok(db, '仓储工厂必须拿到显式执行器');
        return repos;
      },
      db: { isTransaction: false },
      mailer: { async send(message: any) { state.sent.push(message); } } as any,
      config: { enabled: true, minRunDurationMs: 0, publicWebBaseUrl: 'https://web.example.com' } as any,
      generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN99',
    });
    return { publisher, state };
  }

  it('通过 → 发 review_released 邮件，标题与交付物清单进正文', async () => {
    const { publisher, state } = harness();
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(state.deliveries[0].kind, 'review_released');
    assert.equal(state.deliveries[0].runId, RUN);
    assert.match(state.sent[0].subject, /交付物已通过审核/);
    assert.match(state.sent[0].text, /报告\.md/);
    assert.match(state.sent[0].text, /https:\/\/web\.example\.com\/c\/conv_1/);
  });

  it('驳回 → 发 review_rejected 邮件并带审核反馈', async () => {
    const { publisher, state } = harness({ status: 'REJECTED' });
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(state.deliveries[0].kind, 'review_rejected');
    assert.match(state.sent[0].subject, /未通过审核/);
    assert.match(state.sent[0].text, /数据来源不完整/);
  });

  it('用户关掉了审核结果开关 → 结清、不发信（不再读长任务完成开关）', async () => {
    const { publisher, state } = harness({ notify: false });
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['opted_out']);
    assert.equal(state.sent.length, 0);
    assert.deepEqual(state.published, ['ob_1']);
  });

  it('没有邮箱 → 投递账记 skipped，结清', async () => {
    const { publisher, state } = harness({ email: null });
    const { outcomes } = await publisher.publishOnce();
    assert.deepEqual(outcomes, ['no_email']);
    assert.equal(state.deliveries[0].status, 'skipped');
    assert.equal(state.sent.length, 0);
  });

  it('邮件正文压平空白并去掉链接（审核反馈是自由文本）', () => {
    const message = buildReviewDecisionEmail({
      to: 'a@example.com',
      approved: false,
      title: '任务 https://evil.example.com/x',
      displayName: null,
      artifactNames: ['报告.md'],
      feedback: '看这里   https://evil.example.com/y   再改',
      conversationUrl: 'https://web.example.com/c/1',
    });
    assert.equal(message.text.includes('https://evil.example.com'), false);
    assert.match(message.text, /看这里/);
    assert.equal(safeReviewFeedback('   '), '');
  });
});

describe('§5.4 上下文注入', () => {
  function harness(tasks: any[]) {
    const state = { marked: [] as any[] };
    const repos = {
      reviews: {
        async listPendingContextInjection() { return tasks; },
        async markContextInjected(taskId: string, runId: string) {
          if (state.marked.some((entry) => entry.taskId === taskId)) return 0;
          state.marked.push({ taskId, runId });
          return 1;
        },
        async listItems() {
          return [{
            itemNo: 1, name: '报告.md',
            originalArtifactId: 'art_orig', currentArtifactId: 'art_rev',
          }];
        },
      },
    };
    return {
      state,
      deps: {
        transactionManager: { run: async (work: any) => await work({}) },
        createRepositories: () => repos,
        conversationId: 'conv_1',
        orgId: ORG,
        userId: REQUESTER,
        runId: RUN,
        generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN99',
      },
    };
  }

  it('已通过的任务：注入文本说明修订版在 审核版/ 且以它为准', async () => {
    const { deps, state } = harness([{
      reviewTaskId: TASK, status: 'APPROVED', feedback: null,
    }]);
    const text = await buildReviewContextInjection(deps);
    assert.ok(text);
    assert.match(text, /经人工审核后已交付/);
    assert.match(text, /审核版\/报告\.md/);
    assert.deepEqual(state.marked, [{ taskId: TASK, runId: RUN }]);
  });

  it('已驳回的任务：注入反馈，并说明没有交付', async () => {
    const { deps } = harness([{ reviewTaskId: TASK, status: 'REJECTED', feedback: '数据不全' }]);
    const text = await buildReviewContextInjection(deps);
    assert.ok(text);
    assert.match(text, /未通过人工审核/);
    assert.match(text, /数据不全/);
  });

  it('同一任务只注入一次：第二个 Run 拿不到文本（CAS 抢不到）', async () => {
    const { deps, state } = harness([{ reviewTaskId: TASK, status: 'APPROVED', feedback: null }]);
    const first = await buildReviewContextInjection(deps);
    const second = await buildReviewContextInjection(deps);
    assert.ok(first);
    assert.equal(second, null);
    assert.equal(state.marked.length, 1);
  });

  it('没有待注入任务 → null（不产生空提示词前缀）', async () => {
    const { deps } = harness([]);
    assert.equal(await buildReviewContextInjection(deps), null);
  });

  it('注入文本落在触发消息**之前**，数组形状（多模态）也要前置', () => {
    const prompt = prependPlatformText('用户的问题', '## 平台提示');
    assert.equal(prompt, '## 平台提示\n\n用户的问题');
    assert.deepEqual(prependPlatformText([{ type: 'text', text: 'q' }], 'P'), [
      { type: 'text', text: 'P' },
      { type: 'text', text: 'q' },
    ]);
    assert.equal(prependPlatformText('q', null), 'q');

    // 真实触发消息形状（create-run 存的是 content_json.messages）走一遍组装：
    // 注入在最前、用户问题在它之后、附件清单在最后。
    const built = buildTriggeringPrompt({
      triggering: {
        contentJson: {
          text: '把报告改一下',
          messages: [{ role: 'user', content: '把报告改一下' }],
        },
      },
      currentTurnAttachments: [{ attachmentId: 'att_1', filename: '材料.pdf' }],
      imageAttachments: [],
      modelAcceptsImages: true,
      modelId: 'm1',
      reviewContext: '## 平台提示：交付物审核结果\n报告.md 已交付',
    }) as { text: string };
    const text = String(built.text ?? '');
    const injectedAt = text.indexOf('平台提示');
    const userAt = text.indexOf('把报告改一下');
    const attachAt = text.indexOf('attachment_id');
    assert.ok(injectedAt >= 0, '注入文本必须进提示词');
    assert.ok(injectedAt < userAt, '注入必须在触发消息之前');
    assert.ok(attachAt > userAt, '附件清单在用户问题之后');
  });
});
