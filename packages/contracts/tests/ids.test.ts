import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIso8601Utc,
  assertUlid,
  isIso8601Utc,
  isUlid,
  normalizeUlid,
} from '../src/ids.ts';

describe('ULID contract (§5)', () => {
  it('accepts 26-char Crockford Base32', () => {
    const id = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
    assert.equal(isUlid(id), true);
    assert.equal(normalizeUlid(id.toLowerCase()), id);
  });

  it('rejects wrong length and invalid alphabet', () => {
    assert.equal(isUlid('short'), false);
    assert.equal(isUlid('01K0G2PAV8FPMVC9QHJG7JPN4'), false); // 25
    assert.equal(isUlid('01K0G2PAV8FPMVC9QHJG7JPN4ZI'), false); // 27
    assert.equal(isUlid('01K0G2PAV8FPMVC9QHJG7JPN4U'), false); // U not in Crockford
    assert.equal(isUlid(null), false);
  });

  it('assertUlid uppercases and throws on invalid', () => {
    assert.equal(assertUlid('01k0g2pav8fpmvc9qhjg7jpn4z'), '01K0G2PAV8FPMVC9QHJG7JPN4Z');
    assert.throws(() => assertUlid('nope'), /Invalid ULID/);
  });
});

describe('ISO 8601 UTC contract (§5)', () => {
  it('accepts Z-suffixed timestamps', () => {
    assert.equal(isIso8601Utc('2026-07-18T04:31:22.417Z'), true);
    assert.equal(isIso8601Utc('2026-07-18T04:31:22Z'), true);
    assert.equal(assertIso8601Utc('2026-07-18T04:31:22.417Z'), '2026-07-18T04:31:22.417Z');
  });

  it('rejects local offsets and bare dates', () => {
    assert.equal(isIso8601Utc('2026-07-18T04:31:22+08:00'), false);
    assert.equal(isIso8601Utc('2026-07-18'), false);
    assert.equal(isIso8601Utc('2026-07-18 04:31:22'), false);
    assert.throws(() => assertIso8601Utc('not-a-date'), /ISO 8601/);
  });
});
