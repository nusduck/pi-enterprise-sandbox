/**
 * 公司 SSO（OIDC）在 Agent 侧的配置（design `docs/design/sso-oidc-dev.md` §5）。
 *
 * fail-closed：`SSO_ENABLED=true` 但 issuer / client 缺失或非法时，SSO 仍算「打开」
 * （config 投影 `enabled:true`），但 `available:false`，兑换接口一律 503
 * `SSO_CONFIG_UNAVAILABLE`。绝不回退成「不校验 issuer / audience」。
 */

export interface SsoConfig {
  /** 部署意图：是否打开公司 SSO。 */
  readonly enabled: boolean;
  /** 配置完整、可发起登录。`enabled && !available` = 配置缺失。 */
  readonly available: boolean;
  readonly issuer: string;
  readonly clientId: string;
  /** 显式 JWKS 地址；空则取 discovery 的 `jwks_uri`。 */
  readonly jwksUri: string;
  /** 工号所在 claim 名（公司实际字段到位后只改配置）。 */
  readonly employeeIdClaim: string;
  /** 所有 SSO 用户落入的唯一 org（外部 org ID，对应 `organization_external_refs`）。 */
  readonly orgExternalId: string;
  /** 仅开发替身：允许 http issuer。生产必须 https。 */
  readonly allowInsecureHttp: boolean;
  /** discovery / JWKS 出站超时。 */
  readonly requestTimeoutMs: number;
  readonly label: string;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;

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

export function resolveSsoConfig(env: Record<string, string | undefined>): SsoConfig {
  const enabled = flag(env.SSO_ENABLED);
  const issuer = String(env.SSO_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = String(env.SSO_CLIENT_ID || '').trim();
  const jwksUri = String(env.SSO_JWKS_URI || '').trim();
  const allowInsecureHttp = flag(env.SSO_ALLOW_INSECURE_HTTP);
  const timeout = Number(env.SSO_REQUEST_TIMEOUT_MS);
  const requestTimeoutMs = Number.isFinite(timeout) && timeout > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.floor(timeout))
    : DEFAULT_TIMEOUT_MS;
  const available =
    enabled &&
    Boolean(clientId) &&
    validUrl(issuer, allowInsecureHttp) &&
    (!jwksUri || validUrl(jwksUri, allowInsecureHttp));
  return {
    enabled,
    available,
    issuer,
    clientId,
    jwksUri,
    employeeIdClaim: String(env.SSO_EMPLOYEE_ID_CLAIM || 'employee_id').trim() || 'employee_id',
    orgExternalId: String(env.SSO_ORG_ID || 'org_bootstrap').trim() || 'org_bootstrap',
    allowInsecureHttp,
    requestTimeoutMs,
    label: String(env.SSO_LABEL || '公司 SSO').trim() || '公司 SSO',
  };
}
