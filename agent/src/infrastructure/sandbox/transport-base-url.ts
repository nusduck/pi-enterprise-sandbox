/**
 * Agent → Sandbox 传输层的 baseUrl 策略。
 *
 * 这段逻辑原先躺在 `internal-hmac.ts` 里，但它跟 HS256 令牌没有任何关系——
 * 它管的是"这个地址能不能拿来发内部请求"：不许带凭据、不许带 query/hash、
 * 明文 http 只允许字面 loopback（除非部署显式打开 `allowInsecureHttp`）。
 * HMAC 实现收口到 `@pi/contract/hmac.js` 时，这一段留在了 agent 侧。
 */

/** baseUrl 配置不合法。`code` 稳定，不携带机密信息。 */
export class SandboxTransportConfigError extends Error {
  readonly code = 'SANDBOX_TRANSPORT_CONFIG';

  constructor(message: string) {
    super(message);
    this.name = 'SandboxTransportConfigError';
  }
}

function fail(message: string): never {
  throw new SandboxTransportConfigError(message);
}

function isLiteralLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

export function normalizeBaseUrl(
  baseUrl: string | undefined,
  opts: { allowInsecureHttp?: boolean } = {},
): string {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    fail('baseUrl is required');
  }
  const allowInsecureHttp = opts.allowInsecureHttp === true;
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    fail('baseUrl must be an absolute http(s) URL');
  }
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    fail('baseUrl is not a valid URL');
  }
  if (u.username || u.password) {
    fail('baseUrl must not embed credentials');
  }
  if (u.search || u.hash) {
    fail('baseUrl must not include query/hash');
  }
  if (u.protocol === 'https:') {
    return trimmed;
  }
  if (u.protocol === 'http:') {
    // 默认只放行字面 loopback 的明文 http。外部/明文 http 必须由部署显式
    // 打开 `allowInsecureHttp`（开发或受控环境）。这里不做 CIDR/DNS 策略。
    if (allowInsecureHttp || isLiteralLoopbackHostname(u.hostname)) {
      return trimmed;
    }
    fail('http baseUrl rejected unless loopback or allowInsecureHttp=true');
  }
  fail('baseUrl scheme must be http or https');
}
