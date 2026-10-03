/**
 * Routes: browser auth adapter → Agent credential authority.
 */
import type { ServerResponse } from 'node:http';
import { authFromRequest } from '../services/sandbox-client.js';
import {
  authConfig,
  authLogin,
  authLogout,
  authMe,
  authProfile,
  authRegister,
} from '../services/agent-auth-client.js';
import { config } from '../config.js';
import { expiredSessionCookie, sessionCookie } from '../http/cookies.js';
import { sendError, sendJson as json } from '../http/response.js';
import {
  REVOCATION_NOT_REQUIRED,
  classifyLogoutResponse,
} from '../application/auth-revocation.js';
import type { ReqWithTrace } from '../application/run-access-service.js';

function markNoStore(res: ServerResponse): void {
  // Auth responses carry identity/lifecycle state and must never be cached.
  res.setHeader('Cache-Control', 'no-store');
}

function establishSession(res: ServerResponse, data: any) {
  if (!data?.token) throw new Error('Agent auth response did not include a token');
  res.setHeader('Set-Cookie', sessionCookie(data.token));
  return { user: data.user };
}

/**
 * Minimal shape gate for the locked `GET /internal/auth/config` DTO. The Agent
 * stays the authority for field values; the BFF only refuses to present a
 * malformed body as if it were a valid (possibly empty) capability set.
 */
function isAuthConfigDto(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const dto = value as Record<string, unknown>;
  if (typeof dto.mode !== 'string' || !dto.mode.trim()) return false;
  const methods = dto.methods;
  if (!methods || typeof methods !== 'object' || Array.isArray(methods)) return false;
  const entries = methods as Record<string, unknown>;
  return ['local', 'sso'].some((name) => {
    const entry = entries[name];
    return Boolean(entry && typeof entry === 'object' && !Array.isArray(entry));
  });
}

/**
 * SSO 能否发起登录取决于两侧：Agent 能验签（它报的 `available`），BFF 持有完整的
 * client 配置（secret、回调地址、事务密钥）。任一侧缺失都压成 false——不给出
 * 「按钮可点、回调必失败」的入口。BFF 只能把 true 压成 false，不能反向。
 */
function withBffSsoAvailability(dto: any): any {
  const sso = dto?.methods?.sso;
  if (!sso || typeof sso !== 'object' || sso.available !== true || config.SSO.available) return dto;
  return { ...dto, methods: { ...dto.methods, sso: { ...sso, available: false } } };
}

/**
 * POST /api/auth/register
 */
export async function handleRegister(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  markNoStore(res);
  try {
    const data = await authRegister(body || {}, {
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    json(res, 200, establishSession(res, data));
  } catch (err: any) {
    console.error('[auth] register:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/auth/login
 */
export async function handleLogin(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  markNoStore(res);
  try {
    const data = await authLogin(body || {}, {
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    json(res, 200, establishSession(res, data));
  } catch (err: any) {
    console.error('[auth] login:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/auth/config — public proxy to the Agent capability authority.
 *
 * A failure to load the authority (Agent 5xx, timeout, malformed body) becomes
 * 503 with the upstream code preserved; it must never be flattened into an
 * empty capability set, which the browser would read as "no login methods".
 */
export async function handleAuthConfig(res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  markNoStore(res);
  try {
    const data = await authConfig({
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    if (!isAuthConfigDto(data)) {
      json(res, 503, {
        error: 'Authentication configuration is unavailable',
        code: 'AUTH_CONFIG_UNAVAILABLE',
      });
      return;
    }
    json(res, 200, withBffSsoAvailability(data));
  } catch (err: any) {
    console.error('[auth] config:', err?.message || err);
    const code =
      typeof err?.code === 'string' && err.code ? err.code : 'AUTH_CONFIG_UNAVAILABLE';
    json(res, 503, {
      error: 'Authentication configuration is unavailable',
      code,
    });
  }
}

/**
 * POST /api/auth/logout — revoke the current session, then always clear the
 * BFF Cookie. Classification is precise (design §5.2):
 * confirmed / not_required / 503 unconfirmed. A failed or
 * unconfirmable revocation never reports `{ok:true}`.
 */
export async function handleLogout(res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  // Clear the browser Cookie for every outcome, including failures.
  res.setHeader('Set-Cookie', expiredSessionCookie());

  const authorization = authFromRequest(req).authorization || null;
  if (!authorization) {
    // Nothing was presented: idempotent, no Agent/DB round-trip.
    json(res, 200, { ok: true, revocation: REVOCATION_NOT_REQUIRED });
    return;
  }

  let upstream: Awaited<ReturnType<typeof authLogout>> | null = null;
  try {
    upstream = await authLogout(
      { authorization },
      {
        traceId: req?.traceId || null,
        traceContext: req?.traceContext || null,
      },
    );
  } catch (err: any) {
    // Timeout / network failure: we cannot confirm revocation. Keep the
    // Cookie cleared but report 503 rather than a false success.
    console.error('[auth] logout:', err?.message || err);
    upstream = null;
  }

  const decision = classifyLogoutResponse(upstream);
  json(res, decision.status, decision.body);
}

/**
 * GET /api/auth/me
 */
export async function handleMe(res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  markNoStore(res);
  try {
    const data = await authMe(authFromRequest(req), {
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    json(res, 200, data);
  } catch (err: any) {
    console.error('[auth] me:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET / PATCH /api/auth/profile — the account page. The Agent verifies the
 * session token and decides which fields are editable; the body is forwarded
 * as-is so a refused field is reported instead of silently dropped.
 */
export async function handleProfile(method: 'GET' | 'PATCH', body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  markNoStore(res);
  try {
    const data = await authProfile(authFromRequest(req), {
      method,
      body: method === 'PATCH' ? (body ?? {}) : null,
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
    });
    json(res, 200, data);
  } catch (err: any) {
    console.error('[auth] profile:', err.message);
    sendError(res, err, req?.traceId);
  }
}
