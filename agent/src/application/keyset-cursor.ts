/**
 * 列表接口的 keyset 分页游标、`limit` 校验与标题模糊搜索的转义
 * （design ui-polish §2.4）。
 *
 * 为什么抽成一个共享工具：`admin-run-query-service.ts` 与 `review-service.ts`
 * 各自抄了一遍同样的 `encodeCursor`/`decodeCursor`；再加四个接口就是六份。这里只
 * 固化**与业务无关**的那部分——位置编码、边界校验、LIKE 转义。三件容易写错的事：
 *
 * - **游标只是位置，不是身份**：它编码「排序列值 + 主键」，绝不含 org/user。
 *   作用域一律由调用方在查询里先套上（owner/org），跨用户的游标因此只会落在
 *   使用者自己的行集里。仓储层的对照测试守着这条。
 * - **解不出来就 400**：静默「从头发一页」会让翻页无限循环，也会把用户的一个
 *   输入错误伪装成正常空页。
 * - **LIKE 通配符必须转义**：不转义时搜索 `%` 会命中全部——既骗用户也把
 *   `q` 变成了全表扫描的开关。
 */

import { ValidationError } from './errors.js';
import { isUlid } from '../domain/shared/ulid.js';

/** 分页契约的 limit 边界（design ui-polish §2.4）：越界一律 400。 */
export const KEYSET_LIMIT_MIN = 1;
export const KEYSET_LIMIT_MAX = 100;

/** 标题搜索的最大字符数（design ui-polish §2.4）。 */
export const LIST_SEARCH_MAX_LENGTH = 100;

/** 编码里的分隔符。排序列是 ISO 时刻、主键是 ULID，两者都不含 `|`。 */
const CURSOR_SEPARATOR = '|';

/**
 * `limit`：缺省用调用方的默认值，非法（非整数、越界）抛 `ValidationError`。
 *
 * 不 clamp：把 `limit=1000` 悄悄改成 100 会让客户端以为自己拿到了全部数据。
 */
export function parseKeysetLimit(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < KEYSET_LIMIT_MIN || n > KEYSET_LIMIT_MAX) {
    throw new ValidationError(
      `limit must be an integer between ${KEYSET_LIMIT_MIN} and ${KEYSET_LIMIT_MAX}`,
    );
  }
  return n;
}

/** 解出来的位置：排序列的值 + 该行的主键。 */
export interface KeysetPosition {
  readonly sortValue: string;
  readonly key: string;
}

/**
 * 把一行编码成不透明游标（base64url 只是让它看起来不可解析，不是加密）。
 * 排序列或主键缺失时返回 `null`（这一行不能作为「下一页」的起点）。
 */
export function encodeKeysetCursor(
  sortValue: string | null | undefined,
  key: string | null | undefined,
): string | null {
  if (!sortValue || !key) return null;
  return Buffer.from(`${sortValue}${CURSOR_SEPARATOR}${key}`, 'utf8').toString('base64url');
}

/**
 * 解码游标。空值返回 `null`（第一页）；解不出来抛 `ValidationError`（HTTP 400）。
 *
 * 排序列必须是可解析的时刻，主键默认必须是 ULID——两者都只是「形状」检查，
 * 不表示这一行存在、更不表示它属于调用者。存在性与归属由查询本身决定。
 */
export function decodeKeysetCursor(
  cursor: unknown,
  opts: { field?: string; isValidKey?: (key: string) => boolean } = {},
): KeysetPosition | null {
  const text = typeof cursor === 'string' ? cursor.trim() : '';
  if (!text) return null;
  const field = opts.field ?? 'cursor';
  const invalid = () => new ValidationError(`${field} is invalid`);
  // 非 base64url 字符会被 Buffer 忽略，所以这里不靠 try/catch 判非法，
  // 而是靠解出来的结构：缺分隔符、排序列不是时刻、主键形状不对都算非法。
  const decoded = Buffer.from(text, 'base64url').toString('utf8');
  const at = decoded.indexOf(CURSOR_SEPARATOR);
  if (at <= 0) throw invalid();
  const sortValue = decoded.slice(0, at);
  const key = decoded.slice(at + 1);
  if (!key || Number.isNaN(Date.parse(sortValue))) throw invalid();
  const isValidKey = opts.isValidKey ?? isUlid;
  if (!isValidKey(key)) throw invalid();
  return { sortValue, key };
}

/** 排序列值（ISO 时刻串）→ `Date`；解码时已校验，这里只是收窄。 */
export function keysetSortInstant(position: KeysetPosition): Date {
  const ms = Date.parse(position.sortValue);
  if (Number.isNaN(ms)) throw new ValidationError('cursor is invalid');
  return new Date(ms);
}

/**
 * 转义 LIKE 模式里的元字符。MySQL 默认以 `\` 为转义符：`\%` 是字面量 `%`。
 * 顺序必须是先 `\` 再 `%`/`_`，否则会把 `\%` 再转义一次。
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 标题搜索词的归一化：去空白、空串当作「没有搜索」、超长抛 `ValidationError`。
 *
 * 长度按**去掉首尾空白之后**算——用户多打几个空格不该收到 400。
 */
export function normalizeListSearch(
  value: unknown,
  opts: { field?: string; maxLength?: number } = {},
): string | null {
  if (value == null) return null;
  const field = opts.field ?? 'q';
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  if (!text) return null;
  const maxLength = opts.maxLength ?? LIST_SEARCH_MAX_LENGTH;
  if (text.length > maxLength) {
    throw new ValidationError(`${field} exceeds max length ${maxLength}`);
  }
  return text;
}
