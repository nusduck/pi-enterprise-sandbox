/**
 * Shared domain primitives (plan §5 ID/time conventions).
 */

export {
  CROCKFORD_ALPHABET,
  ULID_MAX_TIMESTAMP,
  ULID_PATTERN,
  ULID_PATTERN_I,
  UlidError,
  encodeTime,
  encodeRandom,
  decodeTime,
  incrementRandomBytes,
  isUlid,
  normalizeUlid,
  assertUlid,
  isLegacyOrUuidIdentity,
  createUlidGenerator,
  ulid,
} from './ulid.js';
