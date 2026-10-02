/**
 * 共享 keyset 游标工具的边界（design ui-polish §2.4）。
 *
 * 这里的每条断言都对应一个会静默出错的行为：解不出来的游标当成第一页会让翻页
 * 无限循环；不校验 limit 会让 `limit=1000` 变成「悄悄截断」；不转义 `%` 会让
 * 搜索 `%` 命中全部。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  KEYSET_LIMIT_MAX,
  KEYSET_LIMIT_MIN,
  decodeKeysetCursor,
  encodeKeysetCursor,
  escapeLikePattern,
  keysetSortInstant,
  normalizeListSearch,
  parseKeysetLimit,
} from '../../src/application/keyset-cursor.js';
import { ValidationError } from '../../src/application/errors.js';

const ULID = '01K0G2PAV8FPMVC9QHJG7JPN55';
const OTHER_ULID = '01K0G2PAV8FPMVC9QHJG7JPN57';
const AT = '2026-07-18T06:00:00.000Z';

describe('keyset cursor 编码/解码', () => {
  it('往返保持「排序列 + 主键」，且是不可直接读出的不透明串', () => {
    const cursor = encodeKeysetCursor(AT, ULID);
    assert.equal(typeof cursor, 'string');
    assert.equal(cursor.includes('|'), false);
    assert.deepEqual(decodeKeysetCursor(cursor), { sortValue: AT, key: ULID });
  });

  it('缺排序列或缺主键时不给游标，而不是给一个坏游标', () => {
    assert.equal(encodeKeysetCursor(null, ULID), null);
    assert.equal(encodeKeysetCursor(AT, null), null);
    assert.equal(encodeKeysetCursor('', ULID), null);
  });

  it('空游标 = 第一页', () => {
    assert.equal(decodeKeysetCursor(null), null);
    assert.equal(decodeKeysetCursor(undefined), null);
    assert.equal(decodeKeysetCursor(''), null);
    assert.equal(decodeKeysetCursor('   '), null);
  });

  it('解不出来一律 ValidationError（VALIDATION_ERROR → HTTP 400），绝不静默回到第一页', () => {
    const bad = [
      'not-a-cursor',
      Buffer.from('no-separator', 'utf8').toString('base64url'),
      Buffer.from(`|${ULID}`, 'utf8').toString('base64url'),
      Buffer.from(`${AT}|`, 'utf8').toString('base64url'),
      Buffer.from(`not-an-instant|${ULID}`, 'utf8').toString('base64url'),
      Buffer.from(`${AT}|not-a-ulid`, 'utf8').toString('base64url'),
      Buffer.from(`${AT}|${ULID}|${OTHER_ULID}`, 'utf8').toString('base64url'),
    ];
    for (const cursor of bad) {
      assert.throws(
        () => decodeKeysetCursor(cursor),
        (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
        `cursor should be rejected: ${cursor}`,
      );
    }
  });

  it('主键形状可以按接口覆写，但默认只认 ULID', () => {
    const cursor = encodeKeysetCursor(AT, 'not-a-ulid');
    assert.throws(() => decodeKeysetCursor(cursor), ValidationError);
    assert.deepEqual(
      decodeKeysetCursor(cursor, { isValidKey: (key) => key === 'not-a-ulid' }),
      { sortValue: AT, key: 'not-a-ulid' },
    );
  });

  it('排序列转回 Date 后与原始时刻一致（游标比较用的是这个值）', () => {
    const position = decodeKeysetCursor(encodeKeysetCursor(AT, ULID));
    assert.equal(keysetSortInstant(position).toISOString(), AT);
  });
});

describe('limit 校验', () => {
  it('缺省/空串用默认值', () => {
    assert.equal(parseKeysetLimit(undefined, 30), 30);
    assert.equal(parseKeysetLimit(null, 30), 30);
    assert.equal(parseKeysetLimit('', 30), 30);
  });

  it('接受 1..100 的整数（数字与字符串都收）', () => {
    assert.equal(parseKeysetLimit(1, 30), 1);
    assert.equal(parseKeysetLimit('100', 30), 100);
    assert.equal(KEYSET_LIMIT_MIN, 1);
    assert.equal(KEYSET_LIMIT_MAX, 100);
  });

  it('越界/非整数/非数字一律 400，不做 clamp', () => {
    for (const value of [0, -1, 101, 1000, 1.5, 'abc', 'NaN', {}]) {
      assert.throws(
        () => parseKeysetLimit(value, 30),
        (err) => err instanceof ValidationError,
        `limit should be rejected: ${String(value)}`,
      );
    }
  });
});

describe('标题搜索', () => {
  it('去空白；空串当作没有搜索', () => {
    assert.equal(normalizeListSearch('  周报  '), '周报');
    assert.equal(normalizeListSearch('   '), null);
    assert.equal(normalizeListSearch(null), null);
  });

  it('超过 100 字符 → ValidationError', () => {
    assert.equal(normalizeListSearch('a'.repeat(100)).length, 100);
    assert.throws(() => normalizeListSearch('a'.repeat(101)), ValidationError);
  });

  it('LIKE 元字符被转义：搜索 % 只匹配字面量 %', () => {
    assert.equal(escapeLikePattern('%'), '\\%');
    assert.equal(escapeLikePattern('_'), '\\_');
    assert.equal(escapeLikePattern('\\'), '\\\\');
    assert.equal(escapeLikePattern('50%_off\\'), '50\\%\\_off\\\\');
    assert.equal(escapeLikePattern('周报'), '周报');
  });
});
