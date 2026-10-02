/**
 * 通知分发器的新场景（design `notification-scenarios.md` §7 验收）：
 * 定时任务完成（策略 × 终态）、定时任务等待处理、待我审核、审核结果新开关。
 *
 * 每个权限/过滤分支都有「不发」与「发」的对照；收件人一律来自账本替身，
 * 跨 org 错配必须查不到、不发信。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NotificationDispatcher } from '../../src/infrastructure/notification/notification-dispatcher.js';

const ORG = '01S1ORG0000000000000000000';
const OTHER_ORG = '01S1OTHER00000000000000000';
const USER = '01S1USER000000000000000000';
const REVIEWER_A = '01S1REVA000000000000000000';
const REVIEWER_B = '01S1REVB000000000000000000';
const RUN = '01S1RUN0000000000000000000';
const ROOT = '01S1ROOT000000000000000000';
const TASK = '01S1TASK000000000000000000';

const ENABLED = {
  enabled: true as const,
  smtp: { host: 'smtp.test', port: 587, secure: false, auth: null },
  from: 'noreply@example.com',
  timeoutMs: 5_000,
  minRunDurationMs: 60_000,
  publicWebBaseUrl: 'https://agent.example.com',
};

function runCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN,
    orgId: ORG,
    userId: USER,
    parentRunId: null,
    status: 'SUCCEEDED',
    conversationId: '01S1CONV000000000000000000',
    conversationTitle: '夜间报表',
    createdAt: '2026-10-03T01:00:00.000Z',
    completedAt: '2026-10-03T01:10:00.000Z',
    displayName: '多拉',
    email: 'owner@example.com',
    notifyRunComplete: false,
    notifyReviewResult: true,
    notifyReviewPending: true,
    notifyRunWaiting: true,
    ...overrides,
  };
}

function cronCtx(overrides: Record<string, unknown> = {}) {
  return {
    ...runCtx(),
    cronJobId: '01S1JOB0000000000000000000',
    jobName: '区域销售周报',
    notifyPolicy: 'failure',
    ...overrides,
  };
}

function harness(opts: {
  runs?: Map<string, any>;
  cronByRun?: Map<string, any>;
  reviewers?: any[];
  task?: any;
  items?: any[];
  mailError?: unknown;
  retryOutcome?: 'retry' | 'failed';
  beginStatuses?: Map<string, string>;
} = {}) {
  const state = {
    mail: [] as any[],
    begin: [] as any[],
    sent: [] as string[],
    published: [] as string[],
    failed: [] as string[],
    retried: 0,
  };
  const runs = opts.runs ?? new Map([[RUN, runCtx()]]);
  const cronByRun = opts.cronByRun ?? new Map();
  const store: any = {
    async loadRunContext(runId: string, scope: any) {
      const row = runs.get(runId);
      if (!row || row.orgId !== scope.orgId || row.userId !== scope.userId) return null;
      return row;
    },
    async loadCronRun(runId: string, scope: any) {
      const row = cronByRun.get(runId);
      if (!row || row.orgId !== scope.orgId || row.userId !== scope.userId) return null;
      return row;
    },
    async listReviewPendingRecipients(orgId: string, requesterUserId: string) {
      assert.equal(orgId, ORG);
      return (opts.reviewers ?? []).filter((r) => r.userId !== requesterUserId);
    },
    now: () => new Date('2026-10-03T02:00:00.000Z'),
    async begin(input: any) {
      state.begin.push(input);
      const existing = opts.beginStatuses?.get(input.dedupeKey);
      if (existing) {
        return { created: false, delivery: { deliveryId: 'D0', status: existing, attempts: 1 } };
      }
      return { created: true, delivery: { deliveryId: input.deliveryId, status: input.status, attempts: 0 } };
    },
    async markSent(id: string) { state.sent.push(id); },
    async recordFailure() {},
  };
  const task = opts.task ?? {
    reviewTaskId: TASK, runId: RUN, orgId: ORG, requesterUserId: USER,
    status: 'PENDING', feedback: null, createdAt: '2026-10-03T01:30:00.000Z',
  };
  const repos = {
    reviews: {
      async getTaskById(id: string) { return id === TASK ? task : null; },
      async listItems() { return opts.items ?? [{ name: '报告.md' }, { name: '数据.csv' }]; },
    },
  };
  async function runOne(eventType: string, aggregateId: string, payload: Record<string, unknown>) {
    const outbox: any = {
      async claimBatch() {
        return [{ outboxId: 'OB1', claimToken: 'TOK', aggregateId, eventType, attempts: 1, payloadJson: payload }];
      },
      async markPublished(id: string) { state.published.push(id); return true; },
      async markFailed(id: string) { state.failed.push(id); return true; },
      async markPendingForRetry() { state.retried += 1; return opts.retryOutcome ?? 'retry'; },
    };
    const dispatcher = new NotificationDispatcher({
      outbox,
      store,
      createRepositories: () => repos,
      db: {},
      mailer: {
        async send(message: any) {
          state.mail.push(message);
          if (opts.mailError) throw opts.mailError;
        },
      } as any,
      config: ENABLED,
      generateId: (() => { let n = 0; return () => `01S1DLV${String(n++).padStart(19, '0')}`; })(),
    });
    return dispatcher.publishOnce();
  }
  return { state, runOne };
}

const TERMINAL = 'notification.run_terminal';

describe('定时任务完成（runTerminal + cron）', () => {
  function cronHarness(status: string, policy: string, overrides: Record<string, unknown> = {}) {
    const runs = new Map([[RUN, runCtx({ status })]]);
    const cronByRun = new Map([[RUN, cronCtx({ status, notifyPolicy: policy, ...overrides })]]);
    return harness({ runs, cronByRun });
  }

  for (const status of ['FAILED', 'CANCELLED']) {
    it(`policy=failure × ${status} → 发给任务所有者（不受运行完成开关影响）`, async () => {
      const h = cronHarness(status, 'failure');
      const { outcomes } = await h.runOne(TERMINAL, RUN, { status, orgId: ORG, userId: USER });
      assert.deepEqual(outcomes, ['sent']);
      assert.equal(h.state.mail.length, 1);
      assert.equal(h.state.mail[0].to, 'owner@example.com');
      assert.match(h.state.mail[0].subject, /【定时任务】.*(运行失败|已取消)/);
      assert.match(h.state.mail[0].text, /区域销售周报/);
      assert.equal(h.state.begin[0].kind, 'cron_terminal');
      assert.equal(h.state.begin[0].dedupeKey, `cron_terminal:${RUN}`);
    });
  }

  it('policy=failure × SUCCEEDED → 结清、不发（成功对照需要 always）', async () => {
    const skipped = cronHarness('SUCCEEDED', 'failure');
    assert.deepEqual((await skipped.runOne(TERMINAL, RUN, { status: 'SUCCEEDED', orgId: ORG, userId: USER })).outcomes, ['policy_skipped']);
    assert.equal(skipped.state.mail.length, 0);

    const sent = cronHarness('SUCCEEDED', 'always');
    assert.deepEqual((await sent.runOne(TERMINAL, RUN, { status: 'SUCCEEDED', orgId: ORG, userId: USER })).outcomes, ['sent']);
    assert.equal(sent.state.mail.length, 1);
    assert.match(sent.state.mail[0].subject, /运行成功/);
  });

  it('policy=never → 终态失败也不发', async () => {
    const h = cronHarness('FAILED', 'never');
    assert.deepEqual((await h.runOne(TERMINAL, RUN, { status: 'FAILED', orgId: ORG, userId: USER })).outcomes, ['policy_skipped']);
    assert.equal(h.state.mail.length, 0);
    assert.equal(h.state.begin.length, 0);
  });

  it('非定时任务 Run 保持旧口径：开关有关就不发', async () => {
    const h = harness();
    assert.deepEqual((await h.runOne(TERMINAL, RUN, { status: 'SUCCEEDED', orgId: ORG, userId: USER })).outcomes, ['opted_out']);
    assert.equal(h.state.mail.length, 0);
  });

  it('跨 org 错配：cron 行属于别的 org → 按普通 Run 口径处理，不泄漏任务名', async () => {
    const runs = new Map([[RUN, runCtx()]]);
    // cron 行的 org 与 outbox scope 对不上 → loadCronRun 返回 null。
    const cronByRun = new Map([[RUN, cronCtx({ orgId: OTHER_ORG })]]);
    const h = harness({ runs, cronByRun });
    assert.deepEqual((await h.runOne(TERMINAL, RUN, { status: 'SUCCEEDED', orgId: ORG, userId: USER })).outcomes, ['opted_out']);
    assert.equal(h.state.mail.length, 0);
  });
});

describe('定时任务等待处理（runWaiting）', () => {
  const WAITING = 'run.waiting.notification';
  function waitingHarness(status = 'WAITING_APPROVAL', runOverrides: Record<string, unknown> = {}) {
    const runs = new Map([[RUN, runCtx({ status, ...runOverrides })]]);
    const cronByRun = new Map([[RUN, cronCtx()]]);
    return harness({ runs, cronByRun });
  }

  it('停在审批 → 发给所有者，同 waitId 重认领不重发、不同 waitId 各一封', async () => {
    const h = waitingHarness();
    const payload = (waitId: string) => ({ status: 'WAITING_APPROVAL', orgId: ORG, userId: USER, waitKind: 'approval', waitId });
    assert.deepEqual((await h.runOne(WAITING, RUN, payload('ap_1'))).outcomes, ['sent']);
    assert.equal(h.state.mail.length, 1);
    assert.match(h.state.mail[0].subject, /等待你审批/);
    assert.equal(h.state.begin[0].dedupeKey, `run_waiting:${RUN}:ap_1`);

    const redelivered = harness({
      runs: new Map([[RUN, runCtx({ status: 'WAITING_APPROVAL' })]]),
      cronByRun: new Map([[RUN, cronCtx()]]),
      beginStatuses: new Map([[`run_waiting:${RUN}:ap_1`, 'sent']]),
    });
    assert.deepEqual((await redelivered.runOne(WAITING, RUN, payload('ap_1'))).outcomes, ['already_settled']);
    assert.equal(redelivered.state.mail.length, 0);

    const second = waitingHarness();
    assert.deepEqual((await second.runOne(WAITING, RUN, payload('ap_2'))).outcomes, ['sent']);
    assert.equal(second.state.mail.length, 1);
  });

  it('交互式 Run（非定时）不发：用户就在界面前', async () => {
    const h = harness({ runs: new Map([[RUN, runCtx({ status: 'WAITING_INPUT' })]]) });
    const { outcomes } = await h.runOne(WAITING, RUN, { status: 'WAITING_INPUT', orgId: ORG, userId: USER, waitKind: 'input', waitId: 'in_1' });
    assert.deepEqual(outcomes, ['not_cron']);
    assert.equal(h.state.mail.length, 0);
  });

  it('处理时已离开 WAITING → stale，不补发', async () => {
    const h = waitingHarness('RUNNING');
    const { outcomes } = await h.runOne(WAITING, RUN, { status: 'WAITING_APPROVAL', orgId: ORG, userId: USER, waitKind: 'approval', waitId: 'ap_1' });
    assert.deepEqual(outcomes, ['stale']);
    assert.equal(h.state.mail.length, 0);
  });

  it('所有者关掉等待通知开关 → opted_out', async () => {
    const h = waitingHarness('WAITING_APPROVAL', { notifyRunWaiting: false });
    const { outcomes } = await h.runOne(WAITING, RUN, { status: 'WAITING_APPROVAL', orgId: ORG, userId: USER, waitKind: 'approval', waitId: 'ap_1' });
    assert.deepEqual(outcomes, ['opted_out']);
    assert.equal(h.state.mail.length, 0);
  });

  it('委派子 Run 按根 Run 判定：根是定时任务就发', async () => {
    const runs = new Map([
      [ROOT, runCtx({ runId: ROOT, status: 'RUNNING', parentRunId: null })],
      [RUN, runCtx({ status: 'WAITING_APPROVAL', parentRunId: ROOT })],
    ]);
    const cronByRun = new Map([[ROOT, cronCtx({ runId: ROOT })]]);
    const h = harness({ runs, cronByRun });
    const { outcomes } = await h.runOne(WAITING, RUN, { status: 'WAITING_APPROVAL', orgId: ORG, userId: USER, waitKind: 'approval', waitId: 'ap_9' });
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(h.state.mail.length, 1);
  });

  it('跨 org 错配 → not_found，不发信', async () => {
    const h = waitingHarness();
    const { outcomes } = await h.runOne(WAITING, RUN, { status: 'WAITING_APPROVAL', orgId: OTHER_ORG, userId: USER, waitKind: 'approval', waitId: 'ap_1' });
    assert.deepEqual(outcomes, ['not_found']);
    assert.equal(h.state.mail.length, 0);
    assert.deepEqual(h.state.failed, ['OB1']);
  });
});

describe('待我审核（reviewPending）', () => {
  const PENDING = 'review.pending.notification';
  const payload = { reviewTaskId: TASK, orgId: ORG, requesterUserId: USER };
  function reviewer(userId: string, overrides: Record<string, unknown> = {}) {
    return {
      userId, displayName: `审核员${userId.slice(-2)}`, email: `${userId}@example.com`, notifyReviewPending: true,
      ...overrides,
    };
  }

  it('多审核员各收一封；发起人本人不收（U8）', async () => {
    const h = harness({ reviewers: [reviewer(REVIEWER_A), reviewer(USER), reviewer(REVIEWER_B)] });
    const { outcomes } = await h.runOne(PENDING, TASK, payload);
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(h.state.mail.length, 2);
    assert.deepEqual(h.state.mail.map((m) => m.to).sort(), [`${REVIEWER_A}@example.com`, `${REVIEWER_B}@example.com`].sort());
    assert.match(h.state.mail[0].subject, /【待审核】/);
    assert.match(h.state.mail[0].text, /\/reviews/);
    assert.deepEqual(
      h.state.begin.map((b) => b.dedupeKey).sort(),
      [`review_pending:${TASK}:${REVIEWER_A}`, `review_pending:${TASK}:${REVIEWER_B}`].sort(),
    );
  });

  it('关掉偏好的审核员跳过、无邮箱的记 skipped，其他人照常收到', async () => {
    const h = harness({
      reviewers: [
        reviewer(REVIEWER_A, { notifyReviewPending: false }),
        reviewer(REVIEWER_B),
        reviewer('01S1REVC000000000000000000', { email: null }),
      ],
    });
    const { outcomes } = await h.runOne(PENDING, TASK, payload);
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(h.state.mail.length, 1);
    assert.equal(h.state.mail[0].to, `${REVIEWER_B}@example.com`);
    assert.equal(h.state.begin[0].status, 'sending');
    assert.equal(h.state.begin[1].status, 'skipped');
  });

  it('只有无邮箱的审核员 → no_email，投递账记 skipped', async () => {
    const h = harness({ reviewers: [reviewer(REVIEWER_A, { email: null })] });
    const { outcomes } = await h.runOne(PENDING, TASK, payload);
    assert.deepEqual(outcomes, ['no_email']);
    assert.equal(h.state.mail.length, 0);
    assert.equal(h.state.begin[0].status, 'skipped');
  });

  it('都没打开偏好 → opted_out，一封也不发', async () => {
    const h = harness({
      reviewers: [
        reviewer(REVIEWER_A, { notifyReviewPending: false }),
        reviewer(REVIEWER_B, { notifyReviewPending: false }),
      ],
    });
    const { outcomes } = await h.runOne(PENDING, TASK, payload);
    assert.deepEqual(outcomes, ['opted_out']);
    assert.equal(h.state.mail.length, 0);
    assert.equal(h.state.begin.length, 0);
  });

  it('任务不存在或 org/发起人对不上 → not_found，不发信', async () => {
    const missing = harness({ reviewers: [reviewer(REVIEWER_A)] });
    assert.deepEqual((await missing.runOne(PENDING, '01S1NOPE000000000000000000', payload)).outcomes, ['not_found']);

    const mismatch = harness({ reviewers: [reviewer(REVIEWER_A)] });
    assert.deepEqual(
      (await mismatch.runOne(PENDING, TASK, { ...payload, orgId: OTHER_ORG })).outcomes,
      ['not_found'],
    );
    for (const h of [missing, mismatch]) {
      assert.equal(h.state.mail.length, 0);
      assert.deepEqual(h.state.failed, ['OB1']);
    }
  });

  it('任一收件人瞬时失败 → 整行重试；已发出的不重发', async () => {
    const reviewers = [reviewer(REVIEWER_A), reviewer(REVIEWER_B)];
    let sends = 0;
    const store: any = {
      async loadRunContext() { return runCtx(); },
      async loadCronRun() { return null; },
      async listReviewPendingRecipients() { return reviewers; },
      now: () => new Date('2026-10-03T02:00:00.000Z'),
      async begin(input: any) {
        if (input.dedupeKey === `review_pending:${TASK}:${REVIEWER_A}` && sends > 0) {
          return { created: false, delivery: { deliveryId: 'D0', status: 'sent', attempts: 1 } };
        }
        return { created: true, delivery: { deliveryId: input.deliveryId, status: input.status, attempts: 0 } };
      },
      async markSent() {},
      async recordFailure() {},
    };
    const repos = {
      reviews: {
        async getTaskById() {
          return { reviewTaskId: TASK, runId: RUN, orgId: ORG, requesterUserId: USER, status: 'PENDING', feedback: null, createdAt: null };
        },
        async listItems() { return [{ name: '报告.md' }]; },
      },
    };
    const sentTo: string[] = [];
    let retried = 0;
    const outbox: any = {
      async claimBatch() {
        return [{ outboxId: 'OB1', claimToken: 'TOK', aggregateId: TASK, eventType: PENDING, attempts: 1, payloadJson: payload }];
      },
      async markPublished() { return true; },
      async markFailed() { return true; },
      async markPendingForRetry() { retried += 1; return 'retry'; },
    };
    const dispatcher = new NotificationDispatcher({
      outbox,
      store,
      createRepositories: () => repos,
      db: {},
      mailer: {
        async send(message: any) {
          sends += 1;
          sentTo.push(message.to);
          // 第二位收件人第一次发送时瞬时失败。
          if (message.to === `${REVIEWER_B}@example.com` && sends === 2) throw new Error('SMTP timeout');
        },
      } as any,
      config: ENABLED,
      generateId: (() => { let n = 0; return () => `01S1DLV${String(n++).padStart(19, '0')}`; })(),
    });
    assert.deepEqual((await dispatcher.publishOnce()).outcomes, ['retry']);
    assert.equal(retried, 1);
    // 重试：第一位已 sent（占行直接跳过），第二位补发成功。
    assert.deepEqual((await dispatcher.publishOnce()).outcomes, ['sent']);
    assert.deepEqual(sentTo, [
      `${REVIEWER_A}@example.com`,
      `${REVIEWER_B}@example.com`,
      `${REVIEWER_B}@example.com`,
    ]);
  });
});

describe('审核结果（reviewDecided）改走独立偏好', () => {
  const DECIDED = 'notification.review_decided';
  const payload = { reviewTaskId: TASK, orgId: ORG, requesterUserId: USER, decision: 'APPROVED' };

  it('新开关开着 → 发 review_released；旧开关已关也不影响', async () => {
    const runs = new Map([[RUN, runCtx({ notifyRunComplete: false, notifyReviewResult: true })]]);
    const task = {
      reviewTaskId: TASK, runId: RUN, orgId: ORG, requesterUserId: USER,
      status: 'APPROVED', feedback: null, createdAt: '2026-10-03T01:30:00.000Z',
    };
    const h = harness({ runs, task });
    const { outcomes } = await h.runOne(DECIDED, TASK, payload);
    assert.deepEqual(outcomes, ['sent']);
    assert.equal(h.state.mail.length, 1);
    assert.equal(h.state.begin[0].kind, 'review_released');
    assert.equal(h.state.begin[0].dedupeKey, `review_released:${RUN}`);
  });

  it('新开关关掉 → opted_out（旧开关开着也拦不住，因为不再读它）', async () => {
    const runs = new Map([[RUN, runCtx({ notifyRunComplete: true, notifyReviewResult: false })]]);
    const h = harness({ runs });
    const { outcomes } = await h.runOne(DECIDED, TASK, payload);
    assert.deepEqual(outcomes, ['opted_out']);
    assert.equal(h.state.mail.length, 0);
  });
});
