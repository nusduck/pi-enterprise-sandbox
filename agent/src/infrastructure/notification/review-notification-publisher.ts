/**
 * 审核结果通知的 outbox 消费者（design `agent-output-review.md` §4 A3）。
 *
 * **必须用独立的聚合类型**（`review_notification`）而不是复用 `run_notification`：
 * 那个消费者只按 `aggregate_type` 过滤，整段逻辑是 Run 终态专用的（`notifyRunComplete`
 * 开关、`minRunDurationMs` 门槛、`run_terminal` 的 kind）。把审核结果塞进同一聚合
 * 会被它按「Run 结束了」的语义处理掉（`outbox-status.ts` 里记了这条坑）。
 *
 * 投递账本照旧复用：`kind` 取 `review_released` / `review_rejected`，
 * `UNIQUE(run_id, kind)` 天然去重（一个 Run 至多一条审核任务，语义自洽）。
 *
 * 收件人与开关都按既有口径：`runs.user_id → users.email`，并且尊重用户自己的
 * 「长任务完成邮件通知」开关——审核结果也是这个开关覆盖的通知，不额外开一个。
 */

import { REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY } from '../outbox/eligibility.js';
import { DELIVERY_STATUS, recipientHash, type NotificationStore } from './notification-store.js';
import {
  REVIEW_NOTIFICATION_KIND_REJECTED,
  REVIEW_NOTIFICATION_KIND_RELEASED,
  buildReviewDecisionEmail,
} from './review-notification-email.js';
import type { EmailNotificationConfig } from './email-config.js';
import { isPermanentMailError, type Mailer } from './smtp-mailer.js';

type Loose = any;

export type ReviewNotificationOutcome =
  | 'disabled'
  | 'not_found'
  | 'opted_out'
  | 'no_email'
  | 'already_settled'
  | 'sent'
  | 'retry'
  | 'failed';

export interface ReviewNotificationPublisherDeps {
  readonly outbox: Loose;
  readonly store: NotificationStore;
  /** 仓储工厂；与 `ReviewPublisher` 同理，**必须同时给 `db`**。 */
  readonly createRepositories: (db: Loose) => Loose;
  readonly db: Loose;
  readonly mailer: Mailer | null;
  readonly config: EmailNotificationConfig;
  readonly generateId: () => string;
  readonly batchSize?: number;
  readonly log?: (message: string) => void;
}

export class ReviewNotificationPublisher {
  readonly #outbox: Loose;
  readonly #store: NotificationStore;
  readonly #createRepositories: (db: Loose) => Loose;
  readonly #db: Loose;
  readonly #mailer: Mailer | null;
  readonly #config: EmailNotificationConfig;
  readonly #generateId: () => string;
  readonly #batchSize: number;
  readonly #log: (message: string) => void;

  constructor(deps: ReviewNotificationPublisherDeps) {
    if (!deps?.outbox || !deps.store || !deps.config || typeof deps.generateId !== 'function') {
      throw new Error('ReviewNotificationPublisher requires outbox, store, config and generateId');
    }
    if (deps.config.enabled && !deps.mailer) {
      throw new Error('ReviewNotificationPublisher requires a mailer when email notification is enabled');
    }
    if (!deps.db) throw new Error('ReviewNotificationPublisher requires the knex executor');
    this.#outbox = deps.outbox;
    this.#store = deps.store;
    this.#createRepositories = deps.createRepositories;
    this.#db = deps.db;
    this.#mailer = deps.mailer;
    this.#config = deps.config;
    this.#generateId = deps.generateId;
    this.#batchSize = deps.batchSize ?? 10;
    this.#log = deps.log ?? (() => {});
  }

  async publishOnce(): Promise<{ claimed: number; outcomes: ReviewNotificationOutcome[] }> {
    const claimed: Loose[] = await this.#outbox.claimBatch({
      limit: this.#batchSize,
      eligibility: REVIEW_NOTIFICATION_CLAIM_ELIGIBILITY,
    });
    const outcomes: ReviewNotificationOutcome[] = [];
    for (const row of claimed) {
      if (!row?.outboxId || !row?.claimToken) continue;
      outcomes.push(await this.#handle(row));
    }
    return { claimed: claimed.length, outcomes };
  }

  async #settle(row: Loose, outcome: ReviewNotificationOutcome): Promise<ReviewNotificationOutcome> {
    await this.#outbox.markPublished(row.outboxId, row.claimToken);
    return outcome;
  }

  async #handle(row: Loose): Promise<ReviewNotificationOutcome> {
    if (!this.#config.enabled) return await this.#settle(row, 'disabled');

    const payload = (row.payloadJson ?? {}) as Record<string, unknown>;
    const orgId = typeof payload['orgId'] === 'string' ? payload['orgId'] : '';
    const requesterUserId = typeof payload['requesterUserId'] === 'string' ? payload['requesterUserId'] : '';
    const repos = this.#createRepositories(this.#db);
    const task = await repos.reviews.getTaskById(row.aggregateId);
    if (!task) {
      await this.#outbox.markFailed(row.outboxId, row.claimToken, new Error('review task not found'));
      return 'not_found';
    }

    const ctx = orgId && requesterUserId
      ? await this.#store.loadRunContext(task.runId, { orgId, userId: requesterUserId })
      : null;
    if (!ctx) {
      await this.#outbox.markFailed(row.outboxId, row.claimToken, new Error('run not found for review notification scope'));
      return 'not_found';
    }
    if (!ctx.notifyRunComplete) return await this.#settle(row, 'opted_out');

    const approved = task.status === 'APPROVED';
    const kind = approved ? REVIEW_NOTIFICATION_KIND_RELEASED : REVIEW_NOTIFICATION_KIND_REJECTED;
    if (!ctx.email) {
      await this.#store.begin({
        deliveryId: this.#generateId(),
        orgId: ctx.orgId,
        userId: ctx.userId,
        runId: ctx.runId,
        kind,
        status: DELIVERY_STATUS.SKIPPED,
        recipientHash: null,
        lastError: 'user has no email address',
      });
      return await this.#settle(row, 'no_email');
    }

    const { delivery } = await this.#store.begin({
      deliveryId: this.#generateId(),
      orgId: ctx.orgId,
      userId: ctx.userId,
      runId: ctx.runId,
      kind,
      status: DELIVERY_STATUS.SENDING,
      recipientHash: recipientHash(ctx.email),
    });
    if (delivery.status !== DELIVERY_STATUS.SENDING) return await this.#settle(row, 'already_settled');

    const items = await repos.reviews.listItems(task.reviewTaskId);
    const message = buildReviewDecisionEmail({
      to: ctx.email,
      approved,
      title: ctx.conversationTitle,
      displayName: ctx.displayName,
      artifactNames: items.map((item: Loose) => String(item.name)),
      feedback: task.feedback,
      conversationUrl: `${this.#config.publicWebBaseUrl}/c/${encodeURIComponent(ctx.conversationId)}`,
    });

    try {
      await this.#mailer!.send(message);
    } catch (err) {
      if (isPermanentMailError(err)) {
        await this.#store.recordFailure(delivery.deliveryId, err, true);
        await this.#outbox.markFailed(row.outboxId, row.claimToken, err);
        this.#log(`review ${task.reviewTaskId} notification failed permanently`);
        return 'failed';
      }
      const outcome = await this.#outbox.markPendingForRetry(row.outboxId, row.claimToken, err, {
        attempts: row.attempts,
      });
      await this.#store.recordFailure(delivery.deliveryId, err, outcome === 'failed');
      return outcome === 'failed' ? 'failed' : 'retry';
    }

    await this.#store.markSent(delivery.deliveryId);
    return await this.#settle(row, 'sent');
  }
}
