/**
 * Routes: browser auth adapter → Agent credential authority.
 */
import type { ServerResponse } from 'node:http';
import { authFromRequest } from '../services/sandbox-client.js';
import { authLogin, authMe, authRegister } from '../services/agent-auth-client.js';
import { config } from '../config.js';
import { expiredSessionCookie, sessionCookie } from '../http/cookies.js';
import { sendError, sendJson as json } from '../http/response.js';
import type { ReqWithTrace } from '../application/run-access-service.js';

function establishSession(res: ServerResponse, data: any) {
  if (!data?.token) throw new Error('Agent auth response did not include a token');
  res.setHeader(
    'Set-Cookie',
    sessionCookie(data.token, { secure: config.DEPLOYMENT_ENV === 'production' }),
  );
  return { user: data.user };
}

/**
 * POST /api/auth/register
 */
export async function handleRegister(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
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

/** POST /api/auth/logout — clear the BFF-owned browser session. */
export function handleLogout(res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    expiredSessionCookie({ secure: config.DEPLOYMENT_ENV === 'production' }),
  );
  json(res, 200, { ok: true });
}

/**
 * GET /api/auth/me
 */
export async function handleMe(res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
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

