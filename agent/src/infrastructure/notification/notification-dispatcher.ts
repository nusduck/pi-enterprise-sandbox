/**
 * 合并后的通知分发器（design `notification-scenarios.md` §4）。
 *
 * 原 `NotificationPublisher`（`run_notification`）与 `ReviewNotificationPublisher`
 *（`review_notification`）结构几乎相同：认领 → 解析上下文 → 占投递行 → 发信 →
 * 记账。这里只起一个循环，两类聚合都认领，再按 `event_type` 路由到四个处理器：
 *
 * - `runTerminal`（`notification.run_terminal`）：Run 终态。定时任务触发的 Run 按
 *   任务的 `notify_policy` 发给任务所有者（`kind=cron_terminal`）；其余保持现状
 *   （`notify_run_complete` + 时长阈值，`kind=run_terminal`）。
 * - `runWaiting`（`run.waiting.notification`）：定时任务触发的 Run（含委派子 Run，
 *   按根 Run 判定）停在 WAITING_* 时发给所有者（`kind=run_waiting`）。
 * - `reviewPending`（`review.pending.notification`）：审核任务建立时发给该 org 的
 *   reviewer（排除发起人），每人一封（`kind=review_pending`）。
 * - `reviewDecided`（`notification.review_decided`）：审核结果，发给发起人，
 *   开关改为 `notify_review_result`（`kind=review_released/review_rejected`）。
 *
 * 处理器只负责「解析收件人列表 + 渲染邮件」，共享的投递流程按 `dedupe_key`
 * 占行 → 已是 sent/skipped/failed 直接跳过 → 发信 → 记账。一个 outbox 行对应
 * 多个收件人时，任一收件人瞬时失败 → 整行交给 outbox 退避重试；已发出的收件人
 * 因 `dedupe_key` 不会重发。
 *
 * 对外行为（已有两类通知）不变：`dedupe_key` 回填即 `CONCAT(kind, ':', run_id)`，
 * 历史投递行继续去重。
 */

import { NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY } from '../outbox/eligibility.js';
import {
  EVENT_TYPE_REVIEW_DECIDED_NOTIFICATION,
  EVENT_TYPE_REVIEW_PENDING_NOTIFICATION,
  EVENT_TYPE_RUN_TERMINAL_NOTIFICATION,
  EVENT_TYPE_RUN_WAITING_NOTIFICATION,
} from '../outbox/outbox-status.js';
import type { EmailNotificationConfig } from './email-config.js';
import { buildRunCompletionEmail } from './run-completion-email.js';
import {
  NOTIFICATION_KIND_CRON_TERMINAL,
  NOTIFICATION_KIND_RUN_WAITING,
  buildCronTerminalEmail,
  buildCronWaitingEmail,
} from './cron-notification-email.js';
import {
  NOTIFICATION_KIND_REVIEW_PENDING,
  buildReviewPendingEmail,
} from './review-pending-email.js';
import {
  REVIEW_NOTIFICATION_KIND_REJECTED,
  REVIEW_NOTIFICATION_KIND_RELEASED,
  buildReviewDecisionEmail,
} from './review-notification-email.js';
import { DELIVERY_STATUS, recipientHash, type CronRunNotificationContext, type NotificationStore } from './notification-store.js';
import { isPermanentMailError, type Mailer } from './smtp-mailer.js';
import type { OutboxRepository } from '../outbox/outbox-repository.js';
import type { ReviewItemRecord } from '../mysql/repositories/review-repository.js';
import type { createRepositoryBundle } from '../../bootstrap/container-env.js';

export const NOTIFICATION_KIND_RUN_TERMINAL = 'run_terminal';

/** 仓储容器：复用 ServiceContainer 实际返回的 bundle 类型。 */
type Repositories = ReturnType<typeof createRepositoryBundle>;
/** knex 执行器：与 OutboxRepository / createRepositoryBundle 的入参一致。 */
type DbExecutor = import('knex').Knex | import('knex').Knex.Transaction;

type ClaimedRow = {
  outboxId: string;
  claimToken: string | null;
  aggregateId: string;
  eventType?: string;
  event_type?: string;
  attempts: number;
  payloadJson: Record<string, unknown> | null;
};

export type NotificationOutcome =
  | 'disabled'
  | 'not_found'
  | 'child_run'
  | 'opted_out'
  | 'too_short'
  | 'policy_skipped'
  | 'not_cron'
  | 'stale'
  | 'no_email'
  | 'already_settled'
  | 'sent'
  | 'retry'
  | 'failed';

type PreparedRecipient = {
  orgId: string;
  userId: string;
  runId: string;
  email: string | null;
  kind: string;
  dedupeKey: string;
  subject: string;
  text: string;
};

type HandlerResult =
  | { settle: NotificationOutcome; fail: boolean; error?: string }
  | { recipients: PreparedRecipient[] }
  /** outbox 已在处理器内结算（markFailed），分发器直接返回该结果。 */
  | { done: NotificationOutcome };

const WAITING_STATUSES = Object.freeze(['WAITING_APPROVAL', 'WAITING_INPUT']);
/** 子 Run 链最多向上追这么多层找根 Run；账本正常时只有一两层。 */
const MAX_ROOT_WALK = 12;

function payloadOf(row: ClaimedRow): Record<string, unknown> {
  return row.payloadJson ?? {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export class NotificationDispatcher {
  outbox: OutboxRepository;
  store: NotificationStore;
  createRepositories: (db: DbExecutor) => Repositories;
  db: DbExecutor;
  mailer: Mailer | null;
  config: EmailNotificationConfig;
  generateId: () => string;
  batchSize: number;
  log: (message: string) => void;

  constructor(deps: {
    outbox: OutboxRepository;
    store: NotificationStore;
    createRepositories: (db: DbExecutor) => Repositories;
    db: DbExecutor;
    mailer: Mailer | null;
    config: EmailNotificationConfig;
    generateId: () => string;
    batchSize?: number;
    log?: (message: string) => void;
  }) {
    if (!deps?.outbox || !deps.store || !deps.config || typeof deps.generateId !== 'function') {
      throw new Error('NotificationDispatcher requires outbox, store, config and generateId');
    }
    if (deps.config.enabled && !deps.mailer) {
      throw new Error('NotificationDispatcher requires a mailer when email notification is enabled');
    }
    if (!deps.db) throw new Error('NotificationDispatcher requires the knex executor');
    this.outbox = deps.outbox;
    this.store = deps.store;
    this.createRepositories = deps.createRepositories;
    this.db = deps.db;
    this.mailer = deps.mailer;
    this.config = deps.config;
    this.generateId = deps.generateId;
    this.batchSize = deps.batchSize ?? 20;
    this.log = deps.log ?? (() => {});
  }

  async publishOnce(): Promise<{ claimed: number; outcomes: NotificationOutcome[] }> {
    const claimed: ClaimedRow[] = await this.outbox.claimBatch({
      limit: this.batchSize,
      eligibility: NOTIFICATION_DISPATCH_CLAIM_ELIGIBILITY,
    });
    const outcomes: NotificationOutcome[] = [];
    for (const row of claimed) {
      if (!row.outboxId || !row.claimToken) continue;
      outcomes.push(await this.#handle(row as ClaimedRow & { claimToken: string }));
    }
    return { claimed: claimed.length, outcomes };
  }

  async #settle(row: { outboxId: string; claimToken: string }, outcome: NotificationOutcome) {
    await this.outbox.markPublished(row.outboxId, row.claimToken);
    return outcome;
  }

  /**
   * 可用状态的部署配置。`#handle` 已在能力关闭时直接结清，处理器里再看到
   * disabled 只可能是竞态——抛错而不是按可用配置继续（fail-closed）。
   */
  #liveConfig(): Extract<EmailNotificationConfig, { enabled: true }> {
    const config = this.config;
    if (!config.enabled) throw new Error('email notification capability is disabled');
    return config;
  }

  async #fail(row: { outboxId: string; claimToken: string }, error: string): Promise<NotificationOutcome> {
    await this.outbox.markFailed(row.outboxId, row.claimToken, new Error(error));
    return 'not_found';
  }

  async #handle(row: ClaimedRow & { claimToken: string }): Promise<NotificationOutcome> {
    if (!this.config.enabled) return this.#settle(row, 'disabled');
    // outbox 行的 event_type 列是路由依据；有的调用方只给 payload，这里兜底读 payload。
    const routed = (typeof row.eventType === 'string' && row.eventType)
      || (typeof row.event_type === 'string' && row.event_type)
      || textOf(payloadOf(row).eventType);
    switch (routed) {
      case EVENT_TYPE_RUN_TERMINAL_NOTIFICATION:
        return this.#dispatch(row, await this.#runTerminal(row));
      case EVENT_TYPE_RUN_WAITING_NOTIFICATION:
        return this.#dispatch(row, await this.#runWaiting(row));
      case EVENT_TYPE_REVIEW_PENDING_NOTIFICATION:
        return this.#dispatch(row, await this.#reviewPending(row));
      case EVENT_TYPE_REVIEW_DECIDED_NOTIFICATION:
        return this.#dispatch(row, await this.#reviewDecided(row));
      default:
        await this.outbox.markFailed(row.outboxId, row.claimToken, new Error(`unknown notification event: ${routed || '(missing)'}`));
        return 'failed';
    }
  }
  /**
   * 共享投递流程：逐个收件人占行 → 发信 → 记账，最后按整行结算 outbox。
   *
   * - 任一收件人瞬时失败 → 整行退避重试（已发出的因 `dedupe_key` 不会重发）。
   * - 永久失败只记该收件人，不牵连其他人；全部永久失败才整行 markFailed。
   */
  async #dispatch(
    row: ClaimedRow & { claimToken: string },
    result: HandlerResult,
  ): Promise<NotificationOutcome> {
    if ('done' in result) return result.done;
    if ('settle' in result) {
      if (result.fail) return this.#fail(row, result.error ?? 'notification scope not found');
      return this.#settle(row, result.settle);
    }
    const recipients = result.recipients;
    if (recipients.length === 0) return this.#settle(row, 'opted_out');

    let sent = 0;
    let permanentFailed = 0;
    let settledKind: NotificationOutcome | null = null;
    let transientError: unknown = null;
    const pendingDeliveries: string[] = [];

    for (const recipient of recipients) {
      if (!recipient.email) {
        await this.store.begin({
          deliveryId: this.generateId(),
          orgId: recipient.orgId,
          userId: recipient.userId,
          runId: recipient.runId,
          kind: recipient.kind,
          dedupeKey: recipient.dedupeKey,
          status: DELIVERY_STATUS.SKIPPED,
          recipientHash: null,
          lastError: 'user has no email address',
        });
        settledKind ??= 'no_email';
        continue;
      }
      const { delivery } = await this.store.begin({
        deliveryId: this.generateId(),
        orgId: recipient.orgId,
        userId: recipient.userId,
        runId: recipient.runId,
        kind: recipient.kind,
        dedupeKey: recipient.dedupeKey,
        status: DELIVERY_STATUS.SENDING,
        recipientHash: recipientHash(recipient.email),
      });
      if (delivery.status !== DELIVERY_STATUS.SENDING) {
        settledKind ??= 'already_settled';
        continue;
      }
      try {
        await this.mailer!.send({ to: recipient.email, subject: recipient.subject, text: recipient.text });
      } catch (err) {
        if (isPermanentMailError(err)) {
          await this.store.recordFailure(delivery.deliveryId, err, true);
          permanentFailed += 1;
          this.log(`notification ${recipient.dedupeKey} failed permanently`);
          continue;
        }
        // 瞬时失败先不记账：等整行的退避结论出来再一次记（final 与否那时才知道），
        // 与合并前的两个消费者同一语义。
        transientError ??= err;
        pendingDeliveries.push(delivery.deliveryId);
        continue;
      }
      await this.store.markSent(delivery.deliveryId);
      sent += 1;
    }

    if (transientError !== null) {
      const outcome = await this.outbox.markPendingForRetry(row.outboxId, row.claimToken, transientError, {
        attempts: row.attempts,
      });
      const gaveUp = outcome === 'failed';
      for (const deliveryId of pendingDeliveries) {
        await this.store.recordFailure(deliveryId, transientError, gaveUp);
      }
      if (gaveUp) {
        this.log(`notification ${row.aggregateId} gave up after retries`);
        return 'failed';
      }
      return 'retry';
    }
    if (sent > 0) return this.#settle(row, 'sent');
    if (permanentFailed > 0) {
      await this.outbox.markFailed(row.outboxId, row.claimToken, new Error('all recipients failed permanently'));
      return 'failed';
    }
    return this.#settle(row, settledKind ?? 'already_settled');
  }
  // ── 处理器：只解析收件人 + 渲染邮件 ────────────────────────────────

  async #runTerminal(row: ClaimedRow): Promise<HandlerResult> {
    const payload = payloadOf(row);
    const orgId = textOf(payload.orgId);
    const userId = textOf(payload.userId);
    const runId = row.aggregateId;
    const ctx = orgId && userId ? await this.store.loadRunContext(runId, { orgId, userId }) : null;
    if (!ctx) return { settle: 'not_found', fail: true, error: 'run not found for notification scope' };
    if (ctx.parentRunId) return { settle: 'child_run', fail: false };

    const cron = await this.store.loadCronRun(runId, { orgId, userId });
    if (cron) return this.#cronTerminalRecipient(cron);

    if (!ctx.notifyRunComplete) return { settle: 'opted_out', fail: false };
    const started = ctx.createdAt ? Date.parse(ctx.createdAt) : NaN;
    const ended = ctx.completedAt ? Date.parse(ctx.completedAt) : NaN;
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : NaN;
    if (!Number.isFinite(durationMs) || durationMs < this.#liveConfig().minRunDurationMs) {
      return { settle: 'too_short', fail: false };
    }
    const message = buildRunCompletionEmail({
      to: ctx.email ?? '',
      status: ctx.status,
      title: ctx.conversationTitle,
      displayName: ctx.displayName,
      durationMs,
      conversationUrl: `${this.#liveConfig().publicWebBaseUrl}/c/${encodeURIComponent(ctx.conversationId)}`,
    });
    return {
      recipients: [{
        orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId, email: ctx.email,
        kind: NOTIFICATION_KIND_RUN_TERMINAL, dedupeKey: `run_terminal:${ctx.runId}`,
        subject: message.subject, text: message.text,
      }],
    };
  }

  async #cronTerminalRecipient(cron: CronRunNotificationContext): Promise<HandlerResult> {
    const policy = String(cron.notifyPolicy ?? 'failure');
    // D2：failure 指终态为 FAILED 或 CANCELLED；never 直接结清；未知值 fail-closed 结清。
    if (policy === 'never') return { settle: 'policy_skipped', fail: false };
    if (policy !== 'always' && cron.status !== 'FAILED' && cron.status !== 'CANCELLED') {
      return { settle: 'policy_skipped', fail: false };
    }
    const started = cron.createdAt ? Date.parse(cron.createdAt) : NaN;
    const ended = cron.completedAt ? Date.parse(cron.completedAt) : NaN;
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : null;
    const message = buildCronTerminalEmail({
      to: cron.email ?? '',
      jobName: cron.jobName,
      status: cron.status,
      startedAt: cron.createdAt,
      endedAt: cron.completedAt,
      durationMs,
      conversationUrl: `${this.#liveConfig().publicWebBaseUrl}/c/${encodeURIComponent(cron.conversationId)}`,
    });
    return {
      recipients: [{
        orgId: cron.orgId, userId: cron.userId, runId: cron.runId, email: cron.email,
        kind: NOTIFICATION_KIND_CRON_TERMINAL, dedupeKey: `cron_terminal:${cron.runId}`,
        subject: message.subject, text: message.text,
      }],
    };
  }

  async #runWaiting(row: ClaimedRow): Promise<HandlerResult> {
    const payload = payloadOf(row);
    const orgId = textOf(payload.orgId);
    const userId = textOf(payload.userId);
    const waitKind = textOf(payload.waitKind);
    const waitId = textOf(payload.waitId);
    if (!orgId || !userId || (waitKind !== 'approval' && waitKind !== 'input') || !waitId) {
      await this.outbox.markFailed(row.outboxId, row.claimToken, new Error('invalid run.waiting payload'));
      return { done: 'failed' };
    }
    const scope = { orgId, userId };
    const ctx = await this.store.loadRunContext(row.aggregateId, scope);
    if (!ctx) return { settle: 'not_found', fail: true, error: 'run not found for notification scope' };

    // 委派子 Run 按根 Run 判定是不是定时任务（D6）。
    let root = ctx;
    for (let depth = 0; depth < MAX_ROOT_WALK && root.parentRunId; depth += 1) {
      const parent = await this.store.loadRunContext(root.parentRunId, scope);
      if (!parent) return { settle: 'not_found', fail: true, error: 'run not found for notification scope' };
      root = parent;
    }
    const cron = await this.store.loadCronRun(root.runId, scope);
    // 交互式 Run（非定时）不发：用户就在界面前（D3）。
    if (!cron) return { settle: 'not_cron', fail: false };

    // 写行时在等、处理时已离开 → 过期，不补发。
    if (!WAITING_STATUSES.includes(ctx.status)) return { settle: 'stale', fail: false };
    if (!ctx.notifyRunWaiting) return { settle: 'opted_out', fail: false };

    const message = buildCronWaitingEmail({
      to: cron.email ?? '',
      jobName: cron.jobName,
      waitKind,
      waitingAt: this.store.now().toISOString(),
      conversationUrl: `${this.#liveConfig().publicWebBaseUrl}/c/${encodeURIComponent(ctx.conversationId)}`,
    });
    return {
      recipients: [{
        orgId: cron.orgId, userId: cron.userId, runId: ctx.runId, email: cron.email,
        kind: NOTIFICATION_KIND_RUN_WAITING, dedupeKey: `run_waiting:${ctx.runId}:${waitId}`,
        subject: message.subject, text: message.text,
      }],
    };
  }
  async #reviewPending(row: ClaimedRow): Promise<HandlerResult> {
    const payload = payloadOf(row);
    const orgId = textOf(payload.orgId);
    const requesterUserId = textOf(payload.requesterUserId);
    if (!orgId || !requesterUserId) {
      await this.outbox.markFailed(row.outboxId, row.claimToken, new Error('invalid review.pending payload'));
      return { done: 'failed' };
    }
    const repos = this.createRepositories(this.db);
    const task = await repos.reviews.getTaskById(row.aggregateId);
    // 任务行与 outbox 记录的 org/发起人对不上 → 查不到、不发信（跨租户不泄漏）。
    if (!task || String(task.orgId) !== orgId || String(task.requesterUserId) !== requesterUserId) {
      return { settle: 'not_found', fail: true, error: 'review task not found' };
    }
    const runCtx = await this.store.loadRunContext(task.runId, { orgId, userId: requesterUserId });
    if (!runCtx) return { settle: 'not_found', fail: true, error: 'run not found for review notification scope' };

    const items: ReviewItemRecord[] = await repos.reviews.listItems(task.reviewTaskId);
    const messageBase = {
      title: runCtx.conversationTitle,
      requesterDisplayName: runCtx.displayName,
      itemCount: items.length,
      taskCreatedAt: task.createdAt ?? null,
      reviewsUrl: `${this.#liveConfig().publicWebBaseUrl}/reviews`,
    };
    // D1：该 org 的 reviewer、排除发起人；个人偏好关闭的跳过、无邮箱的记 skipped。
    const candidates = await this.store.listReviewPendingRecipients(orgId, requesterUserId);
    const recipients: PreparedRecipient[] = [];
    for (const candidate of candidates) {
      if (!candidate.notifyReviewPending) continue;
      const message = buildReviewPendingEmail({ ...messageBase, to: candidate.email ?? '' });
      recipients.push({
        orgId, userId: candidate.userId, runId: task.runId, email: candidate.email,
        kind: NOTIFICATION_KIND_REVIEW_PENDING,
        dedupeKey: `review_pending:${task.reviewTaskId}:${candidate.userId}`,
        subject: message.subject, text: message.text,
      });
    }
    return { recipients };
  }

  async #reviewDecided(row: ClaimedRow): Promise<HandlerResult> {
    const payload = payloadOf(row);
    const orgId = textOf(payload.orgId);
    const requesterUserId = textOf(payload.requesterUserId);
    const repos = this.createRepositories(this.db);
    const task = await repos.reviews.getTaskById(row.aggregateId);
    if (!task) return { settle: 'not_found', fail: true, error: 'review task not found' };

    const ctx = orgId && requesterUserId
      ? await this.store.loadRunContext(task.runId, { orgId, userId: requesterUserId })
      : null;
    if (!ctx) {
      return { settle: 'not_found', fail: true, error: 'run not found for review notification scope' };
    }
    // D5：审核结果改由独立偏好控制（迁移时沿用旧开关的值）。
    if (!ctx.notifyReviewResult) return { settle: 'opted_out', fail: false };

    const approved = task.status === 'APPROVED';
    const kind = approved ? REVIEW_NOTIFICATION_KIND_RELEASED : REVIEW_NOTIFICATION_KIND_REJECTED;
    const items = await repos.reviews.listItems(task.reviewTaskId);
    const message = buildReviewDecisionEmail({
      to: ctx.email ?? '',
      approved,
      title: ctx.conversationTitle,
      displayName: ctx.displayName,
      artifactNames: items.map((item: ReviewItemRecord) => String(item.name)),
      feedback: task.feedback,
      conversationUrl: `${this.#liveConfig().publicWebBaseUrl}/c/${encodeURIComponent(ctx.conversationId)}`,
    });
    return {
      recipients: [{
        orgId: ctx.orgId, userId: ctx.userId, runId: ctx.runId, email: ctx.email,
        kind, dedupeKey: `${kind}:${ctx.runId}`,
        subject: message.subject, text: message.text,
      }],
    };
  }
}
