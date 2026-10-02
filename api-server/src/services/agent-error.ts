/**
 * BFF → Agent 错误映射的唯一实现（C5 A1）。
 *
 * 在此之前 `agent-client.ts` 有 21 处近乎相同的 `if (!resp.ok) { … throw }`，
 * 另 7 个 service 各写一份；且只抄 `code`，agent 错误体里的 `reason_code`
 * 到不了浏览器（review-deferred-items「保存期校验失败的具体错误码在 BFF
 * 被丢弃」）。所有 BFF → Agent 非 2xx 一律走这里。
 *
 * 纪律（与收敛前逐字一致，只是挪了地方）：
 * - `status` 原样透传，不做状态码重映射；
 * - `message`：agent 给了 `error` 字符串就用它，否则按 `parse` 回退；
 *   `parse: 'text'` 的调用点回退消息里保留原文（原来就是这么拼的）；
 * - `code` / `reason_code`：非空字符串才带上；
 * - `details`：agent 错误体自带的 `details` 对象（若有）+ `detailsKeys` 点名的
 *   顶层键（如激活冲突的 `active_version_id`）。BFF 不把 agent 的任意载荷原样
 *   转出去——白名单之外的顶层键一律丢掉。
 */

export interface ThrowAgentErrorOptions {
  /**
   * 回退消息的形状：`'json'` → `` `${fallback} (${status})` ``；
   * `'text'` → `` `${fallback} (${status}): ${text}` ``。默认 `'json'`。
   */
  parse?: 'json' | 'text';
  /**
   * 允许从错误体顶层复制进 `error.details` 的键。`active_version_id` 之类
   * agent 文档化了的指针字段走这里；没点名的不进。
   */
  detailsKeys?: readonly string[];
}

export type AgentServiceError = Error & {
  status: number;
  code?: string;
  reason_code?: string;
  details?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  );
}

export async function throwAgentError(
  resp: Response,
  fallback: string,
  { parse = 'json', detailsKeys = [] }: ThrowAgentErrorOptions = {},
): Promise<never> {
  const status = resp.status;
  const text = await resp.text().catch(() => resp.statusText);
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // 非 JSON 的上游失败（网关 HTML 等）：只留状态与原文，不编造字段。
  }
  const body = isPlainObject(payload) ? payload : null;
  const message =
    body != null && typeof body['error'] === 'string'
      ? (body['error'] as string)
      : parse === 'text'
        ? `${fallback} (${status}): ${text}`
        : `${fallback} (${status})`;
  const error = new Error(message) as AgentServiceError;
  error.status = status;
  if (body != null && typeof body['code'] === 'string' && body['code'] !== '') {
    error.code = body['code'] as string;
  }
  if (
    body != null &&
    typeof body['reason_code'] === 'string' &&
    body['reason_code'] !== ''
  ) {
    error.reason_code = body['reason_code'] as string;
  }
  const details: Record<string, unknown> = {};
  if (body != null && isPlainObject(body['details'])) {
    Object.assign(details, body['details']);
  }
  for (const key of detailsKeys) {
    if (body != null && Object.hasOwn(body, key)) {
      details[key] = (body as Record<string, unknown>)[key] ?? null;
    }
  }
  if (Object.keys(details).length > 0) error.details = details;
  throw error;
}
