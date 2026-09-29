/**
 * Run 终态邮件通知的 outbox 消费者（design T8–T10）。
 *
 * 只认领 `run_notification` 聚合的行（`applyRunTransitionInTxn` 在终态同事务写入），
 * 与 RunEventStream publisher 互不认领、互不阻塞。发不发由账本决定：
 *
 * - 能力关闭（配置缺失）→ 直接结清，不堆积 PENDING 行。
 * - Run 查不到（org/user 与 outbox 记录不符）→ markFailed，不发信。
 * - 子 Run（委派 / 子 Agent）、用户没打开开关、耗时不到阈值 → 结清。
 * - 用户打开了开关但没有邮箱 → 投递账记 skipped，结清。
 * - 其余：占住 (run_id, kind) 再发信；已是 sent/skipped/failed 的直接结清，所以
 *   outbox 至少一次投递下重认领不会再发第二封。
 *
 * 发送错误：永久错误（5xx、信封被拒）→ 投递账 failed + outbox markFailed；
 * 其他按瞬时处理，交给 outbox 的退避重试，重试用尽时投递账同步记 failed。
 */

import { RUN_NOTIFICATION_CLAIM_ELIGIBILITY } from '../outbox/eligibility.js';
import type { EmailNotificationConfig } from './email-config.js';
import { buildRunCompletionEmail } from './run-completion-email.js';
import { DELIVERY_STATUS, recipientHash, type NotificationStore } from './notification-store.js';
import { isPermanentMailError, type Mailer } from './smtp-mailer.js';

export const NOTIFICATION_KIND_RUN_TERMINAL = 'run_terminal';

type Loose = any;

type ClaimedRow = {
  outboxId: string;
  claimToken: string | null;
  aggregateId: string;
  attempts: number;
  payloadJson: Record<string, unknown> | null;
};

export type NotificationOutcome =
  | 'disabled'
  | 'not_found'
  | 'child_run'
  | 'opted_out'
  | 'too_short'
  | 'no_email'
  | 'already_settled'
  | 'sent'
  | 'retry'
  | 'failed';

export class NotificationPublisher {
  outbox: Loose;
  store: NotificationStore;
  mailer: Mailer | null;
  config: EmailNotificationConfig;
  generateId: () => string;
  batchSize: number;
  log: (message: string) => void;

  constructor(deps: {
    outbox: Loose;
    store: NotificationStore;
    mailer: Mailer | null;
    config: EmailNotificationConfig;
    generateId: () => string;
    batchSize?: number;
    log?: (message: string) => void;
  }) {
    if (!deps?.outbox || !deps.store || !deps.config || typeof deps.generateId !== 'function') {
      throw new Error('NotificationPublisher requires outbox, store, config and generateId');
    }
    if (deps.config.enabled && !deps.mailer) {
      throw new Error('NotificationPublisher requires a mailer when email notification is enabled');
    }
    this.outbox = deps.outbox;
    this.store = deps.store;
    this.mailer = deps.mailer;
    this.config = deps.config;
    this.generateId = deps.generateId;
    this.batchSize = deps.batchSize ?? 20;
    this.log = deps.log ?? (() => {});
  }

  async publishOnce(): Promise<{ claimed: number; outcomes: NotificationOutcome[] }> {
    const claimed: ClaimedRow[] = await this.outbox.claimBatch({
      limit: this.batchSize,
      eligibility: RUN_NOTIFICATION_CLAIM_ELIGIBILITY,
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

  async #handle(row: ClaimedRow & { claimToken: string }): Promise<NotificationOutcome> {
    const config = this.config;
    if (!config.enabled) return this.#settle(row, 'disabled');

    const payload = row.payloadJson ?? {};
    const orgId = typeof payload.orgId === 'string' ? payload.orgId : '';
    const userId = typeof payload.userId === 'string' ? payload.userId : '';
    const ctx = orgId && userId
      ? await this.store.loadRunContext(row.aggregateId, { orgId, userId })
      : null;
    if (!ctx) {
      await this.outbox.markFailed(row.outboxId, row.claimToken, new Error('run not found for notification scope'));
      return 'not_found';
    }
    if (ctx.parentRunId) return this.#settle(row, 'child_run');
    if (!ctx.notifyRunComplete) return this.#settle(row, 'opted_out');

    const started = ctx.createdAt ? Date.parse(ctx.createdAt) : NaN;
    const ended = ctx.completedAt ? Date.parse(ctx.completedAt) : NaN;
    const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : NaN;
    if (!Number.isFinite(durationMs) || durationMs < config.minRunDurationMs) {
      return this.#settle(row, 'too_short');
    }

    const base = {
      deliveryId: this.generateId(),
      orgId: ctx.orgId,
      userId: ctx.userId,
      runId: ctx.runId,
      kind: NOTIFICATION_KIND_RUN_TERMINAL,
    };
    if (!ctx.email) {
      await this.store.begin({
        ...base,
        status: DELIVERY_STATUS.SKIPPED,
        recipientHash: null,
        lastError: 'user has no email address',
      });
      return this.#settle(row, 'no_email');
    }

    const { delivery } = await this.store.begin({
      ...base,
      status: DELIVERY_STATUS.SENDING,
      recipientHash: recipientHash(ctx.email),
    });
    if (delivery.status !== DELIVERY_STATUS.SENDING) {
      return this.#settle(row, 'already_settled');
    }

    const message = buildRunCompletionEmail({
      to: ctx.email,
      status: ctx.status,
      title: ctx.conversationTitle,
      displayName: ctx.displayName,
      durationMs,
      conversationUrl: `${config.publicWebBaseUrl}/c/${encodeURIComponent(ctx.conversationId)}`,
    });

    try {
      await this.mailer!.send(message);
    } catch (err) {
      if (isPermanentMailError(err)) {
        await this.store.recordFailure(delivery.deliveryId, err, true);
        await this.outbox.markFailed(row.outboxId, row.claimToken, err);
        this.log(`run ${ctx.runId} notification failed permanently`);
        return 'failed';
      }
      const outcome = await this.outbox.markPendingForRetry(row.outboxId, row.claimToken, err, {
        attempts: row.attempts,
      });
      await this.store.recordFailure(delivery.deliveryId, err, outcome === 'failed');
      if (outcome === 'failed') this.log(`run ${ctx.runId} notification gave up after retries`);
      return outcome === 'failed' ? 'failed' : 'retry';
    }

    await this.store.markSent(delivery.deliveryId);
    return this.#settle(row, 'sent');
  }
}
