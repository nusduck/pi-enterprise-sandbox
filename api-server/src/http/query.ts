/**
 * 按白名单复制 query 键的唯一实现（C5 A4）。
 *
 * 在此之前 `agent-client.ts`（`pickListQuery`，返回 `?...` 后缀字符串）与
 * `agent-admin-client.ts` / `agent-member-role-client.ts` /
 * `agent-review-client.ts`（各一份 `pick`，返回 `URLSearchParams`）写了 4 份。
 * 纪律统一：未知键丢弃、空值（`null` / `''`）丢弃；需要字符串时再调
 * `toQuerySuffix`（无幸存键时是 `''`，不是 `'?'`）。
 */

export function pickQuery(
  source: URLSearchParams | null | undefined,
  keys: readonly string[],
): URLSearchParams {
  const out = new URLSearchParams();
  if (!source) return out;
  for (const key of keys) {
    const value = source.get(key);
    if (value != null && value !== '') out.set(key, value);
  }
  return out;
}

/** 白名单过滤后的 `?a=b` 后缀；无幸存键时是 `''`。 */
export function toQuerySuffix(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** `pickQuery` + `toQuerySuffix` 一步到位（`agent-client.ts` 原 `pickListQuery` 语义）。 */
export function pickListQuery(
  source: URLSearchParams | null | undefined,
  keys: readonly string[],
): string {
  return toQuerySuffix(pickQuery(source, keys));
}
