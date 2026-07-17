/**
 * ID and timestamp conventions (plan §5).
 *
 * - Domain IDs: ULID, 26 Crockford Base32 characters.
 * - Timestamps: UTC in storage; ISO 8601 UTC (`...Z`) on the wire.
 */

/** Crockford Base32 alphabet used by ULID (excludes I, L, O, U). */
const ULID_CHAR = '[0-9A-HJKMNP-TV-Z]';

/** Canonical ULID pattern: exactly 26 characters, case-insensitive parse. */
export const ULID_PATTERN = new RegExp(`^${ULID_CHAR}{26}$`, 'i');

/** ISO 8601 UTC with mandatory `Z` suffix (millisecond precision optional). */
export const ISO8601_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export type Ulid = string;
export type Iso8601Utc = string;

export function isUlid(value: unknown): value is Ulid {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

export function assertUlid(value: unknown, field = 'id'): Ulid {
  if (!isUlid(value)) {
    throw new Error(`Invalid ULID for ${field}: expected 26 Crockford Base32 chars`);
  }
  return value.toUpperCase();
}

export function isIso8601Utc(value: unknown): value is Iso8601Utc {
  if (typeof value !== 'string' || !ISO8601_UTC_PATTERN.test(value)) {
    return false;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function assertIso8601Utc(value: unknown, field = 'timestamp'): Iso8601Utc {
  if (!isIso8601Utc(value)) {
    throw new Error(`Invalid ISO 8601 UTC for ${field}: expected e.g. 2026-07-18T04:31:22.417Z`);
  }
  return value;
}

/** Normalize ULID to uppercase canonical form when valid. */
export function normalizeUlid(value: string): Ulid | null {
  if (!isUlid(value)) return null;
  return value.toUpperCase();
}
