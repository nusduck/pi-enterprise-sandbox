/**
 * ULID generator/validator unit tests (plan §5, PR-04 T1).
 * Offline, dependency-free beyond Node 22 crypto.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROCKFORD_ALPHABET,
  ULID_MAX_TIMESTAMP,
  ULID_PATTERN,
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
} from '../../src/domain/shared/ulid.js';

describe('ULID shape (plan §5 CHAR(26))', () => {
  it('default ulid() is 26 Crockford uppercase chars', () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, ULID_PATTERN);
    assert.equal(id, id.toUpperCase());
    assert.equal(isUlid(id), true);
  });

  it('rejects arun_ prefix and UUID shapes as domain ids', () => {
    assert.equal(isLegacyOrUuidIdentity('arun_abc123'), true);
    assert.equal(
      isLegacyOrUuidIdentity('550e8400-e29b-41d4-a716-446655440000'),
      true,
    );
    assert.equal(
      isLegacyOrUuidIdentity('550e8400e29b41d4a716446655440000'),
      true,
    );
    assert.equal(isUlid('arun_abc123'), false);
    assert.equal(isUlid('550e8400-e29b-41d4-a716-446655440000'), false);
    assert.throws(() => assertUlid('arun_x'), UlidError);
    assert.throws(() => assertUlid('not-a-ulid'), UlidError);
  });

  it('normalizeUlid uppercases valid ids', () => {
    const lower = '01k0g2pav8fpmvc9qhjg7jpn4z';
    assert.equal(normalizeUlid(lower), '01K0G2PAV8FPMVC9QHJG7JPN4Z');
    assert.equal(normalizeUlid('nope'), null);
  });

  it('encodeTime / decodeTime round-trip and reject overflow', () => {
    const t = Date.parse('2026-07-18T04:31:22.417Z');
    const enc = encodeTime(t);
    assert.equal(enc.length, 10);
    assert.equal(decodeTime(enc), t);
    assert.throws(() => encodeTime(ULID_MAX_TIMESTAMP + 1), (err) => {
      assert.ok(err instanceof UlidError);
      assert.equal(err.code, 'ULID_CLOCK_OVERFLOW');
      return true;
    });
    assert.throws(() => encodeTime(-1), UlidError);
  });

  it('encodeRandom requires 10 bytes and uses Crockford alphabet only', () => {
    const bytes = new Uint8Array(10);
    for (let i = 0; i < 10; i += 1) bytes[i] = i * 17;
    const r = encodeRandom(bytes);
    assert.equal(r.length, 16);
    for (const ch of r) {
      assert.ok(CROCKFORD_ALPHABET.includes(ch));
    }
    assert.throws(() => encodeRandom(new Uint8Array(9)), UlidError);
  });
});

describe('ULID generator clock / monotonicity', () => {
  it('is monotonic within the same millisecond (entropy bump)', () => {
    let n = 0;
    const fixed = Date.parse('2026-07-18T04:31:22.000Z');
    const gen = createUlidGenerator({
      now: () => fixed,
      randomBytes: (size) => {
        n += 1;
        const b = new Uint8Array(size);
        b[size - 1] = n; // distinct seeds; generator increments after first
        return b;
      },
    });
    const a = gen();
    const b = gen();
    assert.equal(a.length, 26);
    assert.equal(b.length, 26);
    assert.ok(a < b, `expected ${a} < ${b}`);
    // Same time component
    assert.equal(a.slice(0, 10), b.slice(0, 10));
  });

  it('clock going backwards does not emit a smaller id (monotonic-enough)', () => {
    const times = [
      Date.parse('2026-07-18T04:31:22.100Z'),
      Date.parse('2026-07-18T04:31:22.050Z'), // backwards
    ];
    let i = 0;
    let seed = 1;
    const gen = createUlidGenerator({
      now: () => times[Math.min(i++, times.length - 1)],
      randomBytes: (size) => {
        const b = new Uint8Array(size);
        b[size - 1] = seed;
        seed += 1;
        return b;
      },
    });
    const first = gen();
    const second = gen();
    assert.ok(first <= second, `monotonic: ${first} vs ${second}`);
    assert.equal(first.slice(0, 10), second.slice(0, 10));
  });

  it('rejects clock overflow from injectable now()', () => {
    const gen = createUlidGenerator({
      now: () => ULID_MAX_TIMESTAMP + 1,
      randomBytes: (size) => new Uint8Array(size),
    });
    assert.throws(() => gen(), (err) => {
      assert.ok(err instanceof UlidError);
      assert.equal(err.code, 'ULID_CLOCK_OVERFLOW');
      return true;
    });
  });

  it('rejects entropy exhaustion within the same ms', () => {
    const fixed = 1_000_000;
    const gen = createUlidGenerator({
      now: () => fixed,
      randomBytes: (size) => new Uint8Array(size).fill(0xff),
    });
    gen(); // lastRandom = all 0xff
    assert.throws(() => gen(), (err) => {
      assert.ok(err instanceof UlidError);
      assert.equal(err.code, 'ULID_ENTROPY_OVERFLOW');
      return true;
    });
  });

  it('incrementRandomBytes carries and reports overflow', () => {
    const b = new Uint8Array([0x00, 0xff]);
    assert.equal(incrementRandomBytes(b), true);
    assert.deepEqual([...b], [0x01, 0x00]);
    const full = new Uint8Array([0xff, 0xff]);
    assert.equal(incrementRandomBytes(full), false);
  });
});
