/**
 * 公司 OIDC ID token 的独立校验（design `docs/design/sso-oidc-dev.md` §4）。
 *
 * BFF 已经用 openid-client 校验过一次；Agent 仍要**自己**验签，因为它是签发平台会话的
 * 权威，不能只信 BFF 传来的 claims JSON。校验项（OIDC Core §3.1.3.7）：
 *
 * - 固定 issuer：discovery 的 `issuer` 必须与配置逐字相等，token 的 `iss` 也一样；
 * - 签名：只接受非对称算法白名单，key 来自 JWKS（有超时、冷却、缓存；未知 kid
 *   由 jose 有界刷新，刷新失败即拒绝）；
 * - `aud` 含固定 client ID；多 audience 时 `azp` 必须是本 client；
 * - `exp` / `iat` 必填，`nonce` 必须等于 BFF 已消费事务里的那个；`sub` 非空。
 *
 * 不自己写密码学：签名与时间校验全部交给 `jose`。
 */

import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { BrowserAuthError } from './browser-auth-errors.js';
import type { SsoConfig } from './sso-config.js';

/** 非对称算法白名单：HS* 会让 client secret 变成签名钥，none 不可接受。 */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_DISCOVERY_BYTES = 64 * 1024;

export interface VerifiedIdToken {
  readonly issuer: string;
  readonly subject: string;
  readonly claims: JWTPayload & Record<string, unknown>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function ssoConfigUnavailable(): BrowserAuthError {
  return new BrowserAuthError(503, 'SSO_CONFIG_UNAVAILABLE', 'SSO is not available');
}

export function ssoUpstreamUnavailable(): BrowserAuthError {
  return new BrowserAuthError(503, 'SSO_UPSTREAM_UNAVAILABLE', 'SSO provider is unavailable');
}

export function ssoTokenInvalid(): BrowserAuthError {
  return new BrowserAuthError(401, 'SSO_TOKEN_INVALID', 'SSO token is invalid');
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * JWKS 拿不到 ≠ token 不合法。jose 对网络错误不包装（原样抛出、没有 `ERR_*` code），
 * 超时是 `ERR_JWKS_TIMEOUT`，非 200 / 坏 JSON 是 `ERR_JOSE_GENERIC` / `ERR_JWKS_INVALID`。
 */
function isJwksUnavailable(error: unknown): boolean {
  const code = String((error as { code?: string })?.code || '');
  if (!code.startsWith('ERR_')) return true;
  if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JWKS_INVALID') return true;
  return code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/i.test(String((error as Error)?.message));
}

export class OidcIdTokenVerifier {
  readonly config: SsoConfig;
  readonly fetchImpl: FetchLike;
  #jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  #jwksPending: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

  constructor(config: SsoConfig, { fetchImpl = fetch as FetchLike }: { fetchImpl?: FetchLike } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  /** discovery 只为拿 `jwks_uri`，且 issuer 必须精确匹配（防止被引到别的 IdP）。 */
  async #discoverJwksUri(): Promise<string> {
    if (this.config.jwksUri) return this.config.jwksUri;
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    let resp: Response;
    try {
      resp = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        headers: { accept: 'application/json' },
        redirect: 'error',
      });
    } catch {
      throw ssoUpstreamUnavailable();
    }
    if (!resp.ok) throw ssoUpstreamUnavailable();
    const text = await resp.text().catch(() => '');
    if (!text || text.length > MAX_DISCOVERY_BYTES) throw ssoUpstreamUnavailable();
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(text);
    } catch {
      throw ssoUpstreamUnavailable();
    }
    const issuer = String(metadata?.issuer || '').replace(/\/+$/, '');
    if (issuer !== this.config.issuer) throw ssoConfigUnavailable();
    const jwksUri = String(metadata?.jwks_uri || '');
    let parsed: URL;
    try {
      parsed = new URL(jwksUri);
    } catch {
      throw ssoConfigUnavailable();
    }
    // SSRF 收口：discovery 给出的 JWKS 必须与 issuer 同源；别的源用 SSO_JWKS_URI 显式配。
    if (parsed.origin !== new URL(this.config.issuer).origin) throw ssoConfigUnavailable();
    return parsed.toString();
  }

  async #keySet() {
    if (this.#jwks) return this.#jwks;
    if (!this.#jwksPending) {
      this.#jwksPending = this.#discoverJwksUri()
        .then((uri) => {
          this.#jwks = createRemoteJWKSet(new URL(uri), {
            timeoutDuration: this.config.requestTimeoutMs,
            cooldownDuration: 30_000,
            cacheMaxAge: 10 * 60_000,
          });
          return this.#jwks;
        })
        .finally(() => {
          this.#jwksPending = null;
        });
    }
    return this.#jwksPending;
  }

  async verify(idToken: string, expectedNonce: string): Promise<VerifiedIdToken> {
    if (!this.config.available) throw ssoConfigUnavailable();
    if (typeof idToken !== 'string' || !idToken || idToken.length > 16_384) throw ssoTokenInvalid();
    if (typeof expectedNonce !== 'string' || !expectedNonce) throw ssoTokenInvalid();
    const keys = await this.#keySet();
    let payload: JWTPayload & Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        algorithms: ALGORITHMS,
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      if (isJwksUnavailable(error)) throw ssoUpstreamUnavailable();
      // 其余（签名、声明、过期、刷新后仍无匹配 kid）都是 token 不合法。
      throw ssoTokenInvalid();
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.length > 1 && payload.azp !== this.config.clientId) throw ssoTokenInvalid();
    if (typeof payload.nonce !== 'string' || !sameText(payload.nonce, expectedNonce)) {
      throw ssoTokenInvalid();
    }
    const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!subject || subject.length > 255) throw ssoTokenInvalid();
    return { issuer: this.config.issuer, subject, claims: payload };
  }
}
