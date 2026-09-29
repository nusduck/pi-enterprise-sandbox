/**
 * 通知消费者对账本的读写：按 Run 解析收件上下文，以及 `notification_deliveries` 投递账。
 *
 * 收件人只从这里来：`runs.user_id → users.email`，查询同时带上 outbox 行里记下的
 * org_id 与 user_id——三者对不上就查不到，不发信（跨租户错配不泄漏任何东西）。
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
        'u.notify_run_complete',
      );
    if (!row) return null;
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
      email: row.email == null || String(row.email).trim() === '' ? null : String(row.email).trim(),
      notifyRunComplete: Boolean(Number(row.notify_run_complete)),
    };
  }

  /**
   * 占住 (run_id, kind)。已有行时原样返回（`created: false`），由调用方按状态决定
   * 是结清还是重发——重认领到的 `sending` 行意味着上次发送结果未知。
   */
  async begin(input: {
    deliveryId: string;
    orgId: string;
    userId: string;
    runId: string;
    kind: string;
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
      .where({ run_id: input.runId, kind: input.kind })
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
