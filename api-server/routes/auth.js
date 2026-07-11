/**
 * Routes: auth proxy → sandbox /auth/*
 */
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res, status, message) {
  json(res, status, { error: message });
}

/**
 * POST /api/auth/register
 */
export async function handleRegister(body, res) {
  try {
    const data = await sb.authRegister(body || {});
    json(res, 200, data);
  } catch (err) {
    console.error('[auth] register:', err.message);
    jsonError(res, err.status || 500, err.message || 'Register failed');
  }
}

/**
 * POST /api/auth/login
 */
export async function handleLogin(body, res) {
  try {
    const data = await sb.authLogin(body || {});
    json(res, 200, data);
  } catch (err) {
    console.error('[auth] login:', err.message);
    jsonError(res, err.status || 500, err.message || 'Login failed');
  }
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
    jsonError(res, err.status || 500, err.message || 'Unauthorized');
  }
}
