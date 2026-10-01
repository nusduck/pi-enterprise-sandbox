/**
 * Routes: 公司 SSO（OIDC）浏览器入口（design docs/design/sso-oidc-dev.md §4.1、§6）。
 *
 * - `GET /api/auth/sso/login?return_to=/path` → 302 去 IdP（附加密事务 Cookie）；
 * - `GET /api/auth/sso/callback` → 换票 → Agent 兑换 → 写会话 Cookie → 303 回站内路径。
 *
 * 两者都是浏览器顶层导航，失败不回 JSON：统一 303 到 `/?sso_error=<稳定错误码>`，
 * 由前端登录页展示。日志只记错误码，不记 code / token / IdP 原文。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config.js';
import { sessionCookie } from '../http/cookies.js';
import { authSsoExchange } from '../services/agent-auth-client.js';
import { SsoFlowError, ssoFlowFor } from '../application/sso-flow.js';
import { clearTransactionCookie } from '../application/sso-transaction.js';
import type { ReqWithTrace } from '../application/run-access-service.js';

const STABLE_CODE = /^[A-Z][A-Z_]{2,63}$/;

function redirect(res: ServerResponse, status: 302 | 303, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    Location: location,
    'Cache-Control': 'no-store',
    // 回调 URL 带着 code：跳走时不把它当 Referer 送给下一个页面。
    'Referrer-Policy': 'no-referrer',
  };
  if (cookies.length) headers['Set-Cookie'] = cookies;
  res.writeHead(status, headers);
  res.end();
}

function failure(res: ServerResponse, code: string, cookies: string[] = []): void {
  const safe = STABLE_CODE.test(code) ? code : 'SSO_CALLBACK_INVALID';
  redirect(res, 303, `/?sso_error=${encodeURIComponent(safe)}`, cookies);
}

/** Agent 兑换失败：保留 Agent 的稳定错误码（401/404/409/503），其余归为回调不合法。 */
function exchangeErrorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' && STABLE_CODE.test(code) ? code : 'SSO_CALLBACK_INVALID';
}

/** GET /api/auth/sso/login */
export async function handleSsoLogin(req: IncomingMessage, query: URLSearchParams, res: ServerResponse): Promise<void> {
  const flow = ssoFlowFor(config.SSO);
  try {
    const started = await flow.start(query.get('return_to'));
    redirect(res, 302, started.authorizationUrl, [started.transactionCookie]);
  } catch (err) {
    const code = err instanceof SsoFlowError ? err.code : 'SSO_UPSTREAM_UNAVAILABLE';
    console.error('[auth] sso login:', code);
    failure(res, code);
  }
}

/** GET /api/auth/sso/callback */
export async function handleSsoCallback(
  req: IncomingMessage & ReqWithTrace,
  query: URLSearchParams,
  res: ServerResponse,
): Promise<void> {
  const flow = ssoFlowFor(config.SSO);
  const state = query.get('state') || '';
  // 不论成败都清掉这次的事务 Cookie：事务是一次性的。
  const cleared = state ? [clearTransactionCookie(state)] : [];
  let finished;
  try {
    finished = await flow.finish(req, query);
  } catch (err) {
    const code = err instanceof SsoFlowError ? err.code : 'SSO_CALLBACK_INVALID';
    console.error('[auth] sso callback:', code);
    failure(res, code, cleared);
    return;
  }
  let data: any;
  try {
    data = await authSsoExchange(
      { id_token: finished.idToken, nonce: finished.nonce },
      { traceId: req?.traceId || null, traceContext: req?.traceContext || null },
    );
  } catch (err) {
    const code = exchangeErrorCode(err);
    console.error('[auth] sso exchange:', code);
    failure(res, code, cleared);
    return;
  }
  if (typeof data?.token !== 'string' || !data.token) {
    failure(res, 'AUTH_DEPENDENCY_UNAVAILABLE', cleared);
    return;
  }
  redirect(res, 303, finished.transaction.returnTo, [...cleared, sessionCookie(data.token)]);
}
