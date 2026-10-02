/**
 * 通知消费者对账本的读写：按 Run 解析收件上下文，以及 `notification_deliveries` 投递账。
 *
 * 收件人只从这里来：`runs.user_id → users.email`（定时任务走任务所有者），
 * 查询同时带上 outbox 行里记下的 org_id 与 user_id——三者对不上就查不到，
 * 不发信（跨租户错配不泄漏任何东西）。
 */

import { createHash } from 'node:crypto';
import { formatDateTime, toMysqlDateTime } from '../mysql/row-mappers.js';
import { sanitizeOutboxError } from '../outbox/sanitize-error.js';

type Loose = any;

export const DELIVERY_STATUS = Object.freeze({
  SENDING: 'sending',
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

export type RunNotificationContext = {
  runId: string;
  orgId: string;
  userId: string;
  parentRunId: string | null;
  status: string;
  conversationId: string;
  conversationTitle: string | null;
  createdAt: string | null;
  completedAt: string | null;
  displayName: string | null;
  email: string | null;
  notifyRunComplete: boolean;
  notifyReviewResult: boolean;
  notifyReviewPending: boolean;
  notifyRunWaiting: boolean;
};

/**
 * 定时任务触发的 Run：收件人是**任务所有者**（`cron_jobs` 行），不是碰巧与
 * Run 同 user 的那个人——两边按账本对上才发信。
 */
export type CronRunNotificationContext = RunNotificationContext & {
  cronJobId: string;
  jobName: string;
  notifyPolicy: string;
};

/** 待我审核的候选收件人：该 org 的 reviewer（已排除发起人，只含状态有效的成员）。 */
export type ReviewPendingRecipient = {
  userId: string;
  displayName: string | null;
  email: string | null;
  notifyReviewPending: boolean;
};

export type DeliveryRow = {
  deliveryId: string;
  status: string;
  attempts: number;
};

export function recipientHash(email: string) {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function isDuplicateKey(err: unknown) {
  const e = err as { code?: string; errno?: number } | null;
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062;
}

function cleanEmail(value: unknown): string | null {
  if (value == null || String(value).trim() === '') return null;
  return String(value).trim();
}

const USER_PREF_COLUMNS = [
  'u.notify_run_complete',
  'u.notify_review_result',
  'u.notify_review_pending',
  'u.notify_run_waiting',
] as const;

function mapRunContext(row: Loose): RunNotificationContext {
  return {
    runId: String(row.run_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    status: String(row.status),
    conversationId: String(row.conversation_id),
    conversationTitle: row.conversation_title == null ? null : String(row.conversation_title),
    createdAt: formatDateTime(row.created_at),
    completedAt: formatDateTime(row.completed_at),
    displayName: row.display_name == null ? null : String(row.display_name),
    email: cleanEmail(row.email),
    notifyRunComplete: Boolean(Number(row.notify_run_complete ?? 0)),
    notifyReviewResult: Boolean(Number(row.notify_review_result ?? 1)),
    notifyReviewPending: Boolean(Number(row.notify_review_pending ?? 1)),
    notifyRunWaiting: Boolean(Number(row.notify_run_waiting ?? 1)),
  };
}

export class NotificationStore {
  db: Loose;
  now: () => Date;

  constructor(db: Loose, { now = () => new Date() }: { now?: () => Date } = {}) {
    if (!db) throw new Error('NotificationStore requires a knex executor');
    this.db = db;
    this.now = now;
  }

  async loadRunContext(runId: string, scope: { orgId: string; userId: string }): Promise<RunNotificationContext | null> {
    const row = await this.db('tbl_agsvc_runs as r')
      .join('tbl_agsvc_users as u', 'u.user_id', 'r.user_id')
      .leftJoin('tbl_agsvc_conversations as c', function joinConversation(this: Loose) {
        this.on('c.conversation_id', '=', 'r.conversation_id').andOn('c.org_id', '=', 'r.org_id');
      })
      .where({ 'r.run_id': runId, 'r.org_id': scope.orgId, 'r.user_id': scope.userId })
      .first(
        'r.run_id',
        'r.org_id',
        'r.user_id',
        'r.parent_run_id',
        'r.status',
        'r.conversation_id',
        'r.created_at',
        'r.completed_at',
        'c.title as conversation_title',
        'u.display_name',
        'u.email',
        ...USER_PREF_COLUMNS,
      );
    if (!row) return null;
    return mapRunContext(row);
  }

  /**
   * 该 Run 是不是某定时任务触发的：`cron_job_runs.run_id → cron_jobs`。
   * 定时任务表是 owner 作用域的事实——`j.org_id / j.user_id` 必须与 outbox 的
   * scope 对上，否则返回 null（跨租户错配不发信）。
   */
  async loadCronRun(runId: string, scope: { orgId: string; userId: string }): Promise<CronRunNotificationContext | null> {
    const row = await this.db('tbl_agsvc_cron_job_runs as jr')
      .join('tbl_agsvc_cron_jobs as j', 'j.cron_job_id', 'jr.cron_job_id')
      .join('tbl_agsvc_runs as r', 'r.run_id', 'jr.run_id')
      .join('tbl_agsvc_users as u', 'u.user_id', 'j.user_id')
      .leftJoin('tbl_agsvc_conversations as c', function joinConversation(this: Loose) {
        this.on('c.conversation_id', '=', 'r.conversation_id').andOn('c.org_id', '=', 'r.org_id');
      })
      .where({ 'jr.run_id': runId, 'j.org_id': scope.orgId, 'j.user_id': scope.userId })
      .whereNull('j.deleted_at')
      .first(
        'r.run_id',
        'j.org_id as org_id',
        'j.user_id as user_id',
        'r.parent_run_id',
        'r.status',
        'r.conversation_id',
        'r.created_at',
        'r.completed_at',
        'c.title as conversation_title',
        'u.display_name',
        'u.email',
        ...USER_PREF_COLUMNS,
        'j.cron_job_id',
        'j.name as job_name',
        'j.notify_policy',
      );
    if (!row) return null;
    return {
      ...mapRunContext(row),
      cronJobId: String(row.cron_job_id),
      jobName: String(row.job_name),
      // 旧库（迁移前建的任务行）没有这一列时按默认策略处理，不直接炸掉。
      notifyPolicy: row.notify_policy == null ? 'failure' : String(row.notify_policy),
    };
  }

  /**
   * 待我审核的收件候选：持有 `reviewer` 角色、成员关系有效、用户有效、
   * 不是发起人本人的成员（U8 职责分离）。只读账本，不做任何写入。
   */
  async listReviewPendingRecipients(orgId: string, requesterUserId: string): Promise<ReviewPendingRecipient[]> {
    const rows: Loose[] = await this.db('tbl_agsvc_member_roles as mr')
      .join('tbl_agsvc_organization_memberships as m', function joinMembership(this: Loose) {
        this.on('m.org_id', '=', 'mr.org_id').andOn('m.user_id', '=', 'mr.user_id');
      })
      .join('tbl_agsvc_users as u', 'u.user_id', 'mr.user_id')
      .where({ 'mr.org_id': orgId, 'mr.role': 'reviewer' })
      .where({ 'm.status': 'active' })
      .where({ 'u.status': 'active' })
      .whereNot('mr.user_id', requesterUserId)
      .select(
        'mr.user_id as user_id',
        'u.display_name as display_name',
        'u.email as email',
        'u.notify_review_pending as notify_review_pending',
      )
      .orderBy('mr.user_id', 'asc');
    return rows.map((row) => ({
      userId: String(row.user_id),
      displayName: row.display_name == null ? null : String(row.display_name),
      email: cleanEmail(row.email),
      notifyReviewPending: Boolean(Number(row.notify_review_pending ?? 1)),
    }));
  }

  /** 发起人的显示名（待我审核邮件正文用）。查不到返回 null，不发信由调用方决定。 */
  async loadDisplayName(userId: string): Promise<string | null> {
    const row = await this.db('tbl_agsvc_users').where({ user_id: userId }).first('display_name');
    if (!row || row.display_name == null) return null;
    return String(row.display_name);
  }

  /**
    * 按 `dedupe_key` 占住一行。已有行时原样返回（`created: false`），由调用方按状态决定
   * 是结清还是重发——重认领到的 `sending` 行意味着上次发送结果未知。
   */
  async begin(input: {
    deliveryId: string;
    orgId: string;
    userId: string;
    runId: string;
    kind: string;
    dedupeKey: string;
    status: string;
    recipientHash: string | null;
    lastError?: string | null;
  }): Promise<{ created: boolean; delivery: DeliveryRow }> {
    const now = toMysqlDateTime(this.now());
    try {
      await this.db('tbl_agsvc_notification_deliveries').insert({
        delivery_id: input.deliveryId,
        org_id: input.orgId,
        user_id: input.userId,
        run_id: input.runId,
        kind: input.kind,
        dedupe_key: input.dedupeKey,
        status: input.status,
        recipient_hash: input.recipientHash,
        attempts: 0,
        last_error: input.lastError ?? null,
        created_at: now,
        updated_at: now,
        sent_at: null,
      });
      return {
        created: true,
        delivery: { deliveryId: input.deliveryId, status: input.status, attempts: 0 },
      };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const row = await this.db('tbl_agsvc_notification_deliveries')
      .where({ dedupe_key: input.dedupeKey })
      .first('delivery_id', 'status', 'attempts');
    if (!row) throw new Error('notification delivery vanished after duplicate key');
    return {
      created: false,
      delivery: {
        deliveryId: String(row.delivery_id),
        status: String(row.status),
        attempts: Number(row.attempts ?? 0),
      },
    };
  }

  async markSent(deliveryId: string) {
    const now = toMysqlDateTime(this.now());
    await this.db('tbl_agsvc_notification_deliveries')
      .where({ delivery_id: deliveryId })
      .update({
        status: DELIVERY_STATUS.SENT,
        attempts: this.db.raw('attempts + 1'),
        last_error: null,
        sent_at: now,
        updated_at: now,
      });
  }

  /** 一次发送失败。`final` 为真时标记 failed，否则留在 sending 等 outbox 重试。 */
  async recordFailure(deliveryId: string, error: unknown, final: boolean) {
    await this.db('tbl_agsvc_notification_deliveries')
      .where({ delivery_id: deliveryId })
      .update({
        ...(final ? { status: DELIVERY_STATUS.FAILED } : {}),
        attempts: this.db.raw('attempts + 1'),
        last_error: sanitizeOutboxError(error),
        updated_at: toMysqlDateTime(this.now()),
      });
  }
}
