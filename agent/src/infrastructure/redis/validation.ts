/**
 * Local Redis-boundary validators (plan ID contracts).
 *
 * Intentionally self-contained — does not import TypeScript contracts packages at runtime.
 * Domain IDs: 26-char Crockford ULID. Trace: 32-hex W3C (not all-zero).
 */

import { RedisValidationError } from './errors.js';

/** Crockford Base32 alphabet used by ULID (excludes I, L, O, U). */
const ULID_CHAR = '[0-9A-HJKMNP-TV-Z]';

/** Canonical ULID: exactly 26 Crockford chars (case-insensitive). */
export const ULID_PATTERN = new RegExp(`^${ULID_CHAR}{26}$`, 'i');

/** W3C trace-id: 32 hex chars; case-insensitive parse, not all-zero. */
export const TRACE_ID_PATTERN = /^[0-9a-fA-F]{32}$/;

/** ISO 8601 UTC with mandatory Z (fractional seconds optional, up to 9 digits). */
export const ISO8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** Max UTF-8 bytes for owner / worker lease token. */
export const OWNER_TOKEN_MAX_LEN = 255;

/** Max characters for stream event type (e.g. tool.execution.started). */
export const EVENT_TYPE_MAX_LEN = 128;

/**
 * Max UTF-8 bytes for serialized stream payload.
 * Streams are low-latency fan-out; large blobs belong in MySQL / workspace, not Redis.
 */
export const RUN_STREAM_PAYLOAD_MAX_BYTES = 65_536;

/**
 * @param value
 * @returns {value is string}
 */
export function isUlid(value: unknown) {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/**
 * @param value
 * @param [field]
 * @returns {string} uppercase canonical ULID
 */
export function assertUlid(value: unknown, field: string = 'id') {
  if (!isUlid(value)) {
    throw new RedisValidationError(
      `${field} must be a 26-character Crockford ULID`,
      { field },
    );
  }
  return (value as string).toUpperCase();
}

/**
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertRunId(value: unknown, field: string = 'runId') {
  return assertUlid(value, field);
}

/**
 * Agent session id (same ULID shape; distinct field name for lock/session APIs).
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertAgentSessionId(value: unknown, field: string = 'agentSessionId') {
  return assertUlid(value, field);
}

/**
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertOrgId(value: unknown, field: string = 'orgId') {
  return assertUlid(value, field);
}

/**
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertEventId(value: unknown, field: string = 'eventId') {
  return assertUlid(value, field);
}

/**
 * @param value
 * @returns {boolean}
 */
export function isTraceId(value: unknown) {
  if (typeof value !== 'string' || !TRACE_ID_PATTERN.test(value)) {
    return false;
  }
  return value.toLowerCase() !== '0'.repeat(32);
}

/**
 * @param value
 * @param [field]
 * @returns {string} lowercase canonical trace id
 */
export function assertTraceId(value: unknown, field: string = 'traceId') {
  if (!isTraceId(value)) {
    throw new RedisValidationError(
      `${field} must be a 32-character hex W3C trace-id (not all-zero)`,
      { field },
    );
  }
  return (value as string).toLowerCase();
}

/**
 * Worker lease ownership token: nonempty, no control chars, length ≤ OWNER_TOKEN_MAX_LEN.
 *
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertOwnerToken(value: unknown, field: string = 'ownerToken') {
  if (value == null || typeof value !== 'string') {
    throw new RedisValidationError(`${field} is required and must be a non-empty string`, {
      field,
    });
  }
  if (value.length === 0) {
    throw new RedisValidationError(`${field} is required and must be a non-empty string`, {
      field,
    });
  }
  if (value.length > OWNER_TOKEN_MAX_LEN) {
    throw new RedisValidationError(
      `${field} must be at most ${OWNER_TOKEN_MAX_LEN} characters`,
      { field },
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new RedisValidationError(`${field} must not contain control characters`, { field });
  }
  return value;
}

/**
 * Nonnegative safe integer (number or decimal digit string without leading zeros except "0").
 *
 * @param value
 * @param [field]
 * @returns {string} decimal string form
 */
export function assertSequence(value: unknown, field: string = 'sequence') {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RedisValidationError(
        `${field} must be a nonnegative safe integer`,
        { field },
      );
    }
    return String(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RedisValidationError(
        `${field} must be a nonnegative safe integer`,
        { field },
      );
    }
    return value;
  }
  throw new RedisValidationError(
    `${field} must be a nonnegative safe integer`,
    { field },
  );
}

/**
 * Bounded nonempty event type string.
 *
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertEventType(value: unknown, field: string = 'type') {
  if (value == null || typeof value !== 'string' || value.trim() === '') {
    throw new RedisValidationError(`${field} is required and must be a non-empty string`, {
      field,
    });
  }
  if (value.length > EVENT_TYPE_MAX_LEN) {
    throw new RedisValidationError(
      `${field} must be at most ${EVENT_TYPE_MAX_LEN} characters`,
      { field },
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new RedisValidationError(`${field} must not contain control characters`, { field });
  }
  return value;
}

/**
 * @param value
 * @returns {boolean}
 */
export function isIso8601Utc(value: unknown) {
  if (typeof value !== 'string' || !ISO8601_UTC_PATTERN.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/**
 * @param value
 * @param [field]
 * @returns {string}
 */
export function assertCreatedAtUtc(value: unknown, field: string = 'createdAt') {
  if (!isIso8601Utc(value)) {
    throw new RedisValidationError(
      `${field} must be a valid UTC ISO 8601 timestamp ending in Z`,
      { field },
    );
  }
  return (value as string);
}

/**
 * Serialize and bound stream payload (string or JSON object).
 *
 * @param payload
 * @param [field]
 * @returns {string}
 */
export function assertStreamPayload(payload: unknown, field: string = 'payload') {
  if (payload === undefined || payload === null) {
    throw new RedisValidationError(`${field} is required`, { field });
  }

  let serialized;
  if (typeof payload === 'string') {
    serialized = payload;
  } else if (typeof payload === 'object') {
    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw new RedisValidationError(`${field} object is not JSON-serializable`, { field });
    }
  } else {
    throw new RedisValidationError(`${field} must be a string or object`, { field });
  }

  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > RUN_STREAM_PAYLOAD_MAX_BYTES) {
    throw new RedisValidationError(
      `${field} exceeds max serialized size of ${RUN_STREAM_PAYLOAD_MAX_BYTES} bytes (got ${bytes})`,
      { field },
    );
  }
  return serialized;
}
