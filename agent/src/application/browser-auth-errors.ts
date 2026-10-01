/**
 * 浏览器认证面的稳定错误（design sso-integration-reservation §6）。
 *
 * HTTP 层只按 `status` / `code` 原样映射，不解析 message。拆成独立模块是为了让
 * 会话 / JWT / 活跃 principal 三个边界能各自抛同一类错误，而不互相 import：
 * `browser-auth-service.ts` 再导出它，保持既有从该模块取 `BrowserAuthError` 的调用方
 * （`presentation/http/auth-routes.ts` 与测试）不变。
 */
export class BrowserAuthError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'BrowserAuthError';
    this.status = status;
    this.code = code;
  }
}

/** 401：凭据、签名、会话或准入不成立。区分不了具体原因时不泄漏存在性。 */
export function invalidBrowserToken(): BrowserAuthError {
  return new BrowserAuthError(401, 'INVALID_TOKEN', 'Invalid or expired token');
}

/** 503：权威存储（MySQL / 内部网络）不可达，无法确认状态。 */
export function browserAuthStoreUnavailable(): BrowserAuthError {
  return new BrowserAuthError(503, 'AUTH_STORE_UNAVAILABLE', 'Authentication unavailable');
}
