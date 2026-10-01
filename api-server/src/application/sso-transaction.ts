/**
 * 公司 SSO 登录事务：一次「跳去 IdP → 回调」之间需要记住的 PKCE verifier、state、
 * nonce 与登录后回到哪里（design docs/design/sso-oidc-dev.md §4.1）。
 *
 * 存法：**加密**的短期 HttpOnly Cookie（JWE `dir` + `A256GCM`，jose 实现），
 * 不是进程内 Map（多副本回调会落到别的副本），也不新增 Redis 依赖（BFF 没有存储权威）。
 *
 * - 浏览器拿到的是密文：verifier / nonce 不可读、不可改（GCM 认证）。
 * - Cookie 名带 state 前缀：多个标签页各自的登录事务互不覆盖。
 * - `Path=/api/auth/sso`：只在回调时回传；TTL 默认 10 分钟（JWE `exp` 与 Max-Age 双重）。
 * - 回调一律清掉这枚 Cookie；code 由 IdP 保证一次性，重放旧 Cookie 换不到新票。
 */

import { hkdfSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { readCookie } from '../http/cookies.js';

const COOKIE_PREFIX = 'dsh_sso_';
const COOKIE_PATH = '/api/auth/sso';
const STATE_PREFIX_LEN = 16;
const MAX_RETURN_TO = 512;

export interface SsoTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
}

function keyFrom(secret: string): Uint8Array {
  // 与会话 JWT 的签名钥分开：HKDF 派生、带用途标签。
  return new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'dsh-sso-login-transaction', 32));
}

function cookieName(state: string): string {
  return `${COOKIE_PREFIX}${state.slice(0, STATE_PREFIX_LEN)}`;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 登录后只允许回到本站路径：拒绝 `//evil`、`/\evil`、`https://…`、控制字符、
 * 回到 SSO 入口自身（循环）。不合法一律回首页，不报错。
 */
export function safeReturnTo(raw: unknown): string {
  const value = typeof raw === 'string' ? raw : '';
  if (!value || value.length > MAX_RETURN_TO || !value.startsWith('/')) return '/';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '/';
  const base = 'http://return-to.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return '/';
  }
  if (url.origin !== base) return '/';
  if (url.pathname.startsWith(COOKIE_PATH)) return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function sealTransaction(
  txn: SsoTransaction,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const jwe = await new EncryptJWT({
    s: txn.state,
    n: txn.nonce,
    v: txn.codeVerifier,
    r: txn.returnTo,
  })
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .encrypt(keyFrom(secret));
  return [
    `${cookieName(txn.state)}=${jwe}`,
    `Path=${COOKIE_PATH}`,
    'HttpOnly',
    // IdP 回跳是顶层 GET 导航：Lax 会带上这枚 Cookie。
    'SameSite=Lax',
    `Max-Age=${ttlSeconds}`,
  ].join('; ');
}

export function clearTransactionCookie(state: string): string {
  return `${cookieName(state)}=; Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * 按回调 query 里的 state 找回事务。缺失、过期、被改、state 不符都返回 null
 * （调用方统一报 `SSO_STATE_INVALID`，不区分原因）。
 */
export async function openTransaction(
  req: IncomingMessage,
  state: string,
  secret: string,
): Promise<SsoTransaction | null> {
  if (!state || state.length < STATE_PREFIX_LEN || state.length > 256) return null;
  const sealed = readCookie(req, cookieName(state));
  if (!sealed) return null;
  try {
    const { payload } = await jwtDecrypt(sealed, keyFrom(secret), {
      keyManagementAlgorithms: ['dir'],
      contentEncryptionAlgorithms: ['A256GCM'],
    });
    const txn = {
      state: String(payload.s || ''),
      nonce: String(payload.n || ''),
      codeVerifier: String(payload.v || ''),
      returnTo: safeReturnTo(payload.r),
    };
    if (!txn.nonce || !txn.codeVerifier || !sameText(txn.state, state)) return null;
    return txn;
  } catch {
    return null;
  }
}
