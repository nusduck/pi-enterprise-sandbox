/**
 * Dependency-free monotonic-enough ULID (plan §5).
 *
 * Layout: 48-bit millisecond timestamp + 80-bit cryptographic randomness,
 * encoded as 26 Crockford Base32 characters (uppercase canonical form).
 *
 * Clock / randomness are injectable for tests. New Run-authority IDs must be
 * CHAR(26) ULIDs — never `arun_*` or UUID strings.
 */

import { randomBytes as nodeRandomBytes } from 'node:crypto';

/** Crockford Base32 (excludes I, L, O, U). */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Max value for the 48-bit ULID timestamp component. */
export const ULID_MAX_TIMESTAMP = 0xffffffffffff; // 2^48 - 1

/** Canonical uppercase ULID: exactly 26 Crockford chars. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Case-insensitive parse pattern. */
export const ULID_PATTERN_I = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const TIME_LEN = 10;
const RANDOM_LEN = 16;
const RANDOM_BYTES = 10; // 80 bits

/**
 * Typed error for ULID generation / validation failures.
 */
export class UlidError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   */
  constructor(message, code) {
    super(message);
    this.name = 'UlidError';
    this.code = code;
  }
}

/**
 * @param {number} timeMs
 * @returns {string}
 */
export function encodeTime(timeMs) {
  if (!Number.isInteger(timeMs) || timeMs < 0) {
    throw new UlidError(
      'ULID timestamp must be a non-negative integer (ms)',
      'ULID_INVALID_TIMESTAMP',
    );
  }
  if (timeMs > ULID_MAX_TIMESTAMP) {
    throw new UlidError(
      'ULID timestamp exceeds 48-bit maximum (clock overflow)',
      'ULID_CLOCK_OVERFLOW',
    );
  }
  let t = timeMs;
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    out = CROCKFORD_ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * @param {Uint8Array | Buffer} bytes — exactly 10 bytes
 * @returns {string}
 */
export function encodeRandom(bytes) {
  if (!bytes || bytes.length !== RANDOM_BYTES) {
    throw new UlidError(
      `ULID random component requires ${RANDOM_BYTES} bytes`,
      'ULID_INVALID_RANDOM',
    );
  }
  // Pack 80 bits into 16 base32 chars (left-to-right).
  let bits = 0n;
  for (let i = 0; i < RANDOM_BYTES; i += 1) {
    bits = (bits << 8n) | BigInt(bytes[i]);
  }
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) {
    const shift = BigInt((RANDOM_LEN - 1 - i) * 5);
    const idx = Number((bits >> shift) & 0x1fn);
    out += CROCKFORD_ALPHABET[idx];
  }
  return out;
}

/**
 * Decode 10-char Crockford time component to ms.
 * @param {string} timePart
 * @returns {number}
 */
export function decodeTime(timePart) {
  if (typeof timePart !== 'string' || timePart.length !== TIME_LEN) {
    throw new UlidError('Invalid ULID time component', 'ULID_INVALID');
  }
  let t = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const ch = timePart[i].toUpperCase();
    const idx = CROCKFORD_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new UlidError('Invalid ULID time component', 'ULID_INVALID');
    }
    t = t * 32 + idx;
  }
  return t;
}

/**
 * Increment 10-byte big-endian random in place.
 * @param {Uint8Array} bytes
 * @returns {boolean} false if overflow (all 0xff)
 */
export function incrementRandomBytes(bytes) {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if (bytes[i] === 0xff) {
      bytes[i] = 0;
      continue;
    }
    bytes[i] += 1;
    return true;
  }
  return false;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isUlid(value) {
  return typeof value === 'string' && ULID_PATTERN_I.test(value);
}

/**
 * Normalize to uppercase canonical form, or null if invalid.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeUlid(value) {
  if (!isUlid(value)) return null;
  return String(value).toUpperCase();
}

/**
 * @param {unknown} value
 * @param {string} [field]
 * @returns {string}
 */
export function assertUlid(value, field = 'id') {
  const n = normalizeUlid(value);
  if (!n) {
    throw new UlidError(
      `Invalid ULID for ${field}: expected 26 Crockford Base32 chars (CHAR(26))`,
      'ULID_INVALID',
    );
  }
  // Explicitly reject legacy runtime shapes that may look id-like.
  if (String(value).startsWith('arun_')) {
    throw new UlidError(
      `Invalid ULID for ${field}: arun_ prefix is not a plan §5 ULID`,
      'ULID_INVALID',
    );
  }
  return n;
}

/**
 * True when value is a legacy runtime run id (`arun_…`) or a UUID string.
 * These must never be stored in plan CHAR(26) columns.
 * @param {unknown} value
 */
export function isLegacyOrUuidIdentity(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('arun_')) return true;
  // UUID with or without hyphens
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return true;
  }
  if (/^[0-9a-f]{32}$/i.test(value) && value.length === 32) return true;
  return false;
}

/**
 * Create a monotonic-enough ULID generator.
 *
 * - Overflow (> 2^48-1 ms): throws ULID_CLOCK_OVERFLOW.
 * - Clock going backwards: keeps last timestamp and increments entropy
 *   (monotonic-enough; never emits a lexicographically smaller id).
 * - Entropy exhaustion within the same ms: throws ULID_ENTROPY_OVERFLOW.
 *
 * @param {{
 *   now?: () => number,
 *   randomBytes?: (size: number) => Uint8Array | Buffer,
 * }} [options]
 * @returns {() => string}
 */
export function createUlidGenerator(options = {}) {
  const nowFn = options.now ?? (() => Date.now());
  const randomBytesFn =
    options.randomBytes ?? ((n) => nodeRandomBytes(n));

  /** @type {number} */
  let lastTime = -1;
  /** @type {Uint8Array | null} */
  let lastRandom = null;

  return function generateUlid() {
    let time = nowFn();
    if (!Number.isFinite(time)) {
      throw new UlidError('ULID clock returned non-finite value', 'ULID_INVALID_TIMESTAMP');
    }
    time = Math.floor(time);
    if (time < 0) {
      throw new UlidError(
        'ULID timestamp must be a non-negative integer (ms)',
        'ULID_INVALID_TIMESTAMP',
      );
    }
    if (time > ULID_MAX_TIMESTAMP) {
      throw new UlidError(
        'ULID timestamp exceeds 48-bit maximum (clock overflow)',
        'ULID_CLOCK_OVERFLOW',
      );
    }

    if (time > lastTime) {
      lastTime = time;
      const raw = randomBytesFn(RANDOM_BYTES);
      lastRandom = Uint8Array.from(raw);
    } else {
      // Same ms or clock went backwards → stay on lastTime, bump entropy.
      if (!lastRandom) {
        lastRandom = Uint8Array.from(randomBytesFn(RANDOM_BYTES));
      } else if (!incrementRandomBytes(lastRandom)) {
        throw new UlidError(
          'ULID entropy exhausted within the same millisecond',
          'ULID_ENTROPY_OVERFLOW',
        );
      }
      time = lastTime;
    }

    return encodeTime(time) + encodeRandom(lastRandom);
  };
}

/** Default process-wide generator (crypto.randomBytes + Date.now). */
const defaultGenerate = createUlidGenerator();

/**
 * Generate a new ULID with the default generator.
 * @returns {string}
 */
export function ulid() {
  return defaultGenerate();
}
