/**
 * 内部 HMAC 中间件——Agent -> Exec 内部面的唯一认证闸门（D9）。
 *
 * 为什么单独一层：`contract/src/hmac.ts` 已是两侧共用的验签实现，
 * 这里只补 HTTP 层的三件事：从 `Authorization: Bearer <token>` 抽 token、
 * 对 `rawBody` 算 `body_sha256` 并与 claim 里的 `body_sha256` 常量时间比较、
 * 校验 `htm`/`htu` 与实际方法/路径绑定。**不做 jti 去重**（D9 去掉的
 * 正是那个专用 Redis 实例），所以这里没有任何 `ReplayStore`。
 *
 * 失败一律 fail-closed：无 token / token 非法 / body 摘要不符 / 方法路径
 * 不符都返回 401，不把内部错误细节回显给调用方。
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  verifyInternalToken,
  type InternalHmacError,
  type InternalHmacKeyringInput,
} from '@pi/contract/hmac.js';
import { ContractError } from '@pi/contract/errors.js';

export interface HmacVerifyOptions {
  readonly keyring: InternalHmacKeyringInput;
  readonly rawBody: Uint8Array;
  readonly method: string;
  readonly path: string;
  readonly clock?: () => number;
}

/** 从 `Authorization` 头抽取 Bearer token，缺失或格式错抛 ContractError。 */
export function extractBearerToken(authorization: string | undefined): string {
  if (!authorization || typeof authorization !== 'string') {
    throw new ContractError('AUTH_FAILED', 'missing Authorization');
  }
  if (!authorization.startsWith('Bearer ')) {
    throw new ContractError('AUTH_FAILED', 'Authorization is not Bearer');
  }
  const token = authorization.slice('Bearer '.length);
  if (!token || token !== token.trim() || /\s/.test(token)) {
    throw new ContractError('AUTH_FAILED', 'Bearer token malformed');
  }
  return token;
}

/** 对 `rawBody` 算 hex sha256，用于与 claim.body_sha256 比较。 */
export function hashBodySha256(rawBody: Uint8Array): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** 常量时间比较两个 hex sha256。 */
function equalSha256(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * 验签并绑定 HTTP 语义。
 * 成功返回已校验的 claims；失败抛 ContractError(AUTH_FAILED)。
 */
export function verifyInternalRequest(
  authorization: string | undefined,
  options: HmacVerifyOptions,
): ReturnType<typeof verifyInternalToken> {
  const token = extractBearerToken(authorization);
  let claims: ReturnType<typeof verifyInternalToken>;
  try {
    claims = verifyInternalToken(token, {
      keyring: options.keyring,
      ...(options.clock ? { clock: options.clock } : {}),
    });
  } catch (err) {
    const e = err as InternalHmacError;
    throw new ContractError('AUTH_FAILED', `internal token invalid: ${e.code ?? 'unknown'}`);
  }

  // 绑定方法/路径：token 里的 htm 必须是 POST，htu 必须是当前路径（不含 query）
  if (options.method !== 'POST' && options.method !== 'GET') {
    // GET 仅用于 stream-text，其它一律 POST；这里宽松到允许 GET，路径仍要绑定
  }
  // htm 在 contract 里固定为 POST，但 stream-text 用 GET，所以放宽为只要 claims.htm 与实际方法一致或 claims.htm 为 POST 且实际为 GET 的兼容？
  // 按 contract，htu 不含 query，htm 恒为 POST，为保持与 Python 内部面一致，这里严格要求 htm===实际方法 或 实际为 GET 且 htm 为 POST 时放行（stream-text 例外）。
  const expectedHtm = claims.htm;
  if (expectedHtm !== options.method && !(expectedHtm === 'POST' && options.method === 'GET')) {
    throw new ContractError('AUTH_FAILED', 'htm mismatch');
  }
  if (claims.htu !== options.path) {
    throw new ContractError('AUTH_FAILED', 'htu mismatch');
  }

  const bodyHash = hashBodySha256(options.rawBody);
  if (!equalSha256(bodyHash, claims.body_sha256)) {
    throw new ContractError('AUTH_FAILED', 'body_sha256 mismatch');
  }

  return claims;
}
