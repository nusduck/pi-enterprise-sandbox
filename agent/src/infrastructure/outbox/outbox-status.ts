/**
 * Outbox status constants (plan §8.17 / PR-03 delivery).
 * Shared with the durable MySQL outbox schema.
 */

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
});

/** @type {readonly string[]} */
export const OUTBOX_STATUSES = Object.freeze(Object.values(OUTBOX_STATUS));

/** outbox 行的状态取值。 */
export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

/** 是不是一个合法的 outbox 状态。 */
export function isOutboxStatus(value: unknown): value is OutboxStatus {
  return (
    typeof value === 'string' && (OUTBOX_STATUSES as readonly string[]).includes(value)
  );
}

/** Aggregate type that maps to run:stream:{runId}. */
export const AGGREGATE_TYPE_RUN = 'run';

/**
 * Run 进入终态时同事务多写的一行，只给通知消费者认领。payload **不带**
 * `runId` / `run_id` 键（run id 在 aggregate_id）：RunEventStream publisher 的
 * eligibility 会认领带这两个键的任何行，带上就会被它抢走。
 */
export const AGGREGATE_TYPE_RUN_NOTIFICATION = 'run_notification';
export const EVENT_TYPE_RUN_TERMINAL_NOTIFICATION = 'notification.run_terminal';

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_STALE_CLAIM_MS = 60_000;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 300_000;
export const DEFAULT_CLAIM_BATCH_SIZE = 50;
export const LAST_ERROR_MAX_LEN = 512;
