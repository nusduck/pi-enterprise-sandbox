/**
 * Routes: auth proxy → sandbox /auth/*
 */
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { config } from '../config.js';
import { expiredSessionCookie, sessionCookie } from '../http/cookies.js';
import { sendError, sendJson as json } from '../http/response.js';

function establishSession(res, data) {
  if (!data?.token) throw new Error('Sandbox auth response did not include a token');
  res.setHeader(
    'Set-Cookie',
    sessionCookie(data.token, { secure: config.DEPLOYMENT_ENV === 'production' }),
  );
  return { user: data.user };
}

/**
 * POST /api/auth/register
 */
export async function handleRegister(body, res, req = null) {
  try {
    const data = await sb.authRegister(body || {});
    json(res, 200, establishSession(res, data));
  } catch (err) {
    console.error('[auth] register:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/auth/login
 */
export async function handleLogin(body, res, req = null) {
  try {
    const data = await sb.authLogin(body || {});
    json(res, 200, establishSession(res, data));
  } catch (err) {
    console.error('[auth] login:', err.message);
    sendError(res, err, req?.traceId);
  }
}


/** POST /api/auth/logout — clear the BFF-owned browser session. */
export function handleLogout(res) {
  res.setHeader(
    'Set-Cookie',
    expiredSessionCookie({ secure: config.DEPLOYMENT_ENV === 'production' }),
  );
  json(res, 200, { ok: true });
}

/**
 * GET /api/auth/me
 */
export async function handleMe(res, req) {
  try {
    const data = await sb.authMe(authFromRequest(req));
    json(res, 200, data);
  } catch (err) {
    console.error('[auth] me:', err.message);
    sendError(res, err, req?.traceId);
  }
}
