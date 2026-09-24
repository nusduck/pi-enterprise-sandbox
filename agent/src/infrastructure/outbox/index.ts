/**
 * Durable MySQL Outbox + RunEventStream publisher (PR-03 slice B).
 *
 * MySQL is the authority for undelivered events. Redis Streams are a
 * low-latency projection (plan §7.2, §9.3). At-least-once with stable eventId.
 *
 * Publishers must claim with eligibility so generic domain_outbox rows for
 * other aggregates remain available to their own workers.
 */

export {
  OUTBOX_STATUS,
  OUTBOX_STATUSES,
  isOutboxStatus,
  AGGREGATE_TYPE_RUN,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_STALE_CLAIM_MS,
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_CLAIM_BATCH_SIZE,
  LAST_ERROR_MAX_LEN,
} from './outbox-status.js';

export { generateClaimToken } from './claim-token.js';
export { sanitizeOutboxError } from './sanitize-error.js';
export { computeRetryDelayMs } from './retry-delay.js';
export { mapDomainOutbox } from './map-outbox-row.js';
export {
  RUN_STREAM_CLAIM_ELIGIBILITY,
  normalizeClaimEligibility,
  buildEligibilitySql,
  hasEligibilityFilter,
  rowMatchesEligibility,
} from './eligibility.js';
export {
  OutboxRepository,
  parseRawSelectRows,
  parseAffectedRows,
} from './outbox-repository.js';
export {
  mapOutboxToRunStreamEvent,
  resolveStableEventId,
  resolveRunId,
  resolveSequence,
  resolveEventType,
  resolveCreatedAt,
  parseNonNegativeSafeInteger,
  isUlidLike,
  isIso8601Utc,
  isPermanentMappingError,
  PermanentMappingError,
} from './stream-mapper.js';
export { OutboxPublisher, defaultSleep } from './outbox-publisher.js';
export {
  requirePositiveInteger,
  requirePositiveDurationMs,
  resolveBatchLimit,
} from './options.js';
