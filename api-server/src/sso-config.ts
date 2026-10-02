/**
 * BFF 侧的公司 SSO（OIDC client）配置（design docs/design/sso-oidc-dev.md §5）。
 *
 * BFF 是唯一持有 client secret 的服务：它负责 code + PKCE 换票，ID token 再交给
 * Agent 独立验签。配置不完整时 fail-closed——`available:false`，登录入口 503，
 * config 投影把 `sso.available` 压成 false，不会出现「按钮可点但回调必失败」。
 */

const MIN_SECRET_LEN = 32;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TRANSACTION_TTL_SECONDS = 600;

export interface SsoClientConfig {
  readonly available: boolean;
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** 回调地址，必须与 IdP 登记的一字不差。 */
  readonly redirectUri: string;
  readonly scopes: string;
  /** 加密登录事务 Cookie 的密钥材料（≥32 字符，只在 BFF）。 */
  readonly transactionSecret: string;
  readonly transactionTtlSeconds: number;
  /** 仅开发替身：允许 http issuer / redirect。 */
  readonly allowInsecureHttp: boolean;
  readonly requestTimeoutMs: number;
}

function flag(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function validUrl(value: string, allowHttp: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return allowHttp && url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function resolveSsoClientConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): SsoClientConfig {
  const enabled = flag(env.SSO_ENABLED);
  const issuer = String(env.SSO_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = String(env.SSO_CLIENT_ID || '').trim();
  const clientSecret = String(env.SSO_CLIENT_SECRET || '');
  const redirectUri = String(env.SSO_REDIRECT_URI || '').trim();
  const transactionSecret = String(env.SSO_TRANSACTION_SECRET || '');
  const allowInsecureHttp = flag(env.SSO_ALLOW_INSECURE_HTTP);
  const timeout = Number(env.SSO_REQUEST_TIMEOUT_MS);
  const ttl = Number(env.SSO_TRANSACTION_TTL_SECONDS);
  const available =
    enabled &&
    Boolean(clientId) &&
    Boolean(clientSecret) &&
    transactionSecret.length >= MIN_SECRET_LEN &&
    validUrl(issuer, allowInsecureHttp) &&
    validUrl(redirectUri, allowInsecureHttp);
  return {
    available,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    scopes: String(env.SSO_SCOPES || 'openid profile').trim() || 'openid profile',
    transactionSecret,
    transactionTtlSeconds:
      Number.isSafeInteger(ttl) && ttl >= 60 && ttl <= 1800 ? ttl : DEFAULT_TRANSACTION_TTL_SECONDS,
    allowInsecureHttp,
    requestTimeoutMs:
      Number.isFinite(timeout) && timeout > 0
        ? Math.min(MAX_TIMEOUT_MS, Math.floor(timeout))
        : DEFAULT_TIMEOUT_MS,
  };
}
