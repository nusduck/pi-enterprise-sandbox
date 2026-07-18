/**
 * Map durable outbox rows to Redis Run Stream fields (plan §9.3).
 *
 * Stream key: run:stream:{runId}
 * Fields: { eventId, sequence, type, payload, createdAt }
 *
 * Mapping failures are permanent (bad durable payload) — not Redis/transient.
 * Missing or invalid sequence must not be coerced to 0.
 *
 * eventId is stable (payload.eventId or outbox_id) so at-least-once
 * republish produces the same logical event id for consumers.
 */

import { AGGREGATE_TYPE_RUN } from './outbox-status.js';

/** Crockford ULID: exactly 26 chars (plan §5). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** ISO 8601 UTC with mandatory Z (matches contracts ids). */
const ISO8601_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Platform event type: non-empty, bounded, no control chars. */
const EVENT_TYPE_RE = /^[\w.-]{1,128}$/;

/**
 * Permanent mapping / validation failure for run-stream projection.
 * Publisher must markFailed once — never schedule Redis-style retries.
 */
export class PermanentMappingError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = 'PermanentMappingError';
    /** @type {true} */
    this.permanent = true;
  }
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isUlidLike(value) {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isIso8601Utc(value) {
  if (typeof value !== 'string' || !ISO8601_UTC_RE.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/**
 * Nonnegative safe integer only. Rejects negatives, fractions, NaN, unsafe ints,
 * and numeric strings that are not exact decimal integers.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parseNonNegativeSafeInteger(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return value;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!/^(0|[1-9]\d*)$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    return n;
  }
  return null;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isPermanentMappingError(err) {
  return (
    err instanceof PermanentMappingError ||
    (Boolean(err) &&
      typeof err === 'object' &&
      /** @type {{ permanent?: unknown }} */ (err).permanent === true)
  );
}

/**
 * Stable stream event id: prefer payload.eventId when ULID, else outbox_id.
 * Throws PermanentMappingError when neither is a valid ULID.
 *
 * @param {{ outboxId: string, payloadJson?: Record<string, unknown> }} row
 * @returns {string}
 */
export function resolveStableEventId(row) {
  const payload =
    row.payloadJson && typeof row.payloadJson === 'object' ? row.payloadJson : {};
  const fromPayload = payload.eventId ?? payload.event_id;
  if (isUlidLike(fromPayload)) {
    return String(fromPayload).toUpperCase();
  }
  if (isUlidLike(row.outboxId)) {
    return String(row.outboxId).toUpperCase();
  }
  throw new PermanentMappingError(
    'eventId must be a ULID (payload.eventId or outbox_id)',
  );
}

/**
 * runId from aggregate when aggregate_type=run, else validated payload.runId.
 * Throws when a run-scoped claim cannot resolve a ULID runId (malformed).
 *
 * @param {{
 *   aggregateType: string,
 *   aggregateId: string,
 *   payloadJson?: Record<string, unknown>,
 * }} row
 * @returns {string}
 */
export function resolveRunId(row) {
  if (String(row.aggregateType).toLowerCase() === AGGREGATE_TYPE_RUN) {
    if (isUlidLike(row.aggregateId)) {
      return String(row.aggregateId).toUpperCase();
    }
    throw new PermanentMappingError(
      'aggregate_type=run requires ULID aggregate_id as runId',
    );
  }
  const payload =
    row.payloadJson && typeof row.payloadJson === 'object' ? row.payloadJson : {};
  const fromPayload = payload.runId ?? payload.run_id;
  if (isUlidLike(fromPayload)) {
    return String(fromPayload).toUpperCase();
  }
  throw new PermanentMappingError(
    'run stream event requires ULID runId (aggregate run or payload.runId)',
  );
}

/**
 * Sequence for stream field (string form of nonnegative safe integer).
 * Missing / invalid → permanent error (never coerce to 0).
 *
 * @param {{ payloadJson?: Record<string, unknown> }} row
 * @returns {string}
 */
export function resolveSequence(row) {
  const payload =
    row.payloadJson && typeof row.payloadJson === 'object' ? row.payloadJson : {};
  const hasKey =
    Object.prototype.hasOwnProperty.call(payload, 'sequence') ||
    Object.prototype.hasOwnProperty.call(payload, 'sequenceNo') ||
    Object.prototype.hasOwnProperty.call(payload, 'sequence_no');
  if (!hasKey) {
    throw new PermanentMappingError(
      'run stream event requires payload.sequence (nonnegative safe integer)',
    );
  }
  const seq =
    payload.sequence ?? payload.sequenceNo ?? payload.sequence_no;
  const n = parseNonNegativeSafeInteger(seq);
  if (n == null) {
    throw new PermanentMappingError(
      'payload.sequence must be a nonnegative safe integer',
    );
  }
  return String(n);
}

/**
 * @param {unknown} eventType
 * @returns {string}
 */
export function resolveEventType(eventType) {
  if (typeof eventType !== 'string' || !EVENT_TYPE_RE.test(eventType)) {
    throw new PermanentMappingError(
      'eventType must be a non-empty string matching [\\w.-]{1,128}',
    );
  }
  return eventType;
}

/**
 * @param {unknown} createdAt
 * @returns {string}
 */
export function resolveCreatedAt(createdAt) {
  if (isIso8601Utc(createdAt)) return /** @type {string} */ (createdAt);
  // Accept already-normalized ISO from mapDomainOutbox / formatDateTime.
  if (typeof createdAt === 'string' && createdAt) {
    const d = new Date(createdAt);
    if (Number.isFinite(d.getTime())) {
      const iso = d.toISOString();
      if (isIso8601Utc(iso)) return iso;
    }
  }
  throw new PermanentMappingError(
    'createdAt must be ISO 8601 UTC (…Z) for run stream fields',
  );
}

/**
 * Map a claimed outbox row to run stream append args.
 * Throws PermanentMappingError on durable payload defects.
 *
 * @param {{
 *   outboxId: string,
 *   aggregateType: string,
 *   aggregateId: string,
 *   eventType: string,
 *   payloadJson?: Record<string, unknown>,
 *   createdAt?: string | null,
 * }} row
 * @returns {{
 *   runId: string,
 *   fields: {
 *     eventId: string,
 *     sequence: string,
 *     type: string,
 *     payload: string,
 *     createdAt: string,
 *   },
 * }}
 */
export function mapOutboxToRunStreamEvent(row) {
  const runId = resolveRunId(row);
  const eventId = resolveStableEventId(row);
  const sequence = resolveSequence(row);
  const type = resolveEventType(row.eventType);
  const createdAt = resolveCreatedAt(row.createdAt);
  const payloadObj =
    row.payloadJson && typeof row.payloadJson === 'object' ? row.payloadJson : {};

  return {
    runId,
    fields: {
      eventId,
      sequence,
      type,
      payload: JSON.stringify(payloadObj),
      createdAt,
    },
  };
}
