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

/**
 * @param {unknown} value
 * @returns {value is keyof typeof OUTBOX_STATUS extends never ? string : string}
 */
export function isOutboxStatus(value) {
  return typeof value === 'string' && OUTBOX_STATUSES.includes(value);
}

/** Aggregate type that maps to run:stream:{runId}. */
export const AGGREGATE_TYPE_RUN = 'run';

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_STALE_CLAIM_MS = 60_000;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 300_000;
export const DEFAULT_CLAIM_BATCH_SIZE = 50;
export const LAST_ERROR_MAX_LEN = 512;
