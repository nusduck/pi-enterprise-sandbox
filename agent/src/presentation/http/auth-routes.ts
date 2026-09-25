import type { IncomingMessage, ServerResponse } from 'node:http';
import { BrowserAuthError } from '../../application/browser-auth-service.js';
import { json, readBody } from './request-response.js';

type BrowserAuthLike = {
  register(body: Record<string, unknown>): Promise<unknown>;
  login(body: Record<string, unknown>): Promise<unknown>;
  me(authorization: string | undefined): Promise<unknown>;
  profile(authorization: string | undefined): Promise<unknown>;
  updateProfile(authorization: string | undefined, body: Record<string, unknown>): Promise<unknown>;
};

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 16_384);
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new BrowserAuthError(400, 'INVALID_JSON', 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BrowserAuthError(400, 'INVALID_JSON', 'Request body must be an object');
  }
  return body as Record<string, unknown>;
}

export async function handleAuthRoute(input: {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  browserAuthService?: BrowserAuthLike | null;
}) {
  const { req, res, path, browserAuthService } = input;
  const action = path === '/internal/auth/register'
    ? 'register'
    : path === '/internal/auth/login'
      ? 'login'
      : path === '/internal/auth/me'
        ? 'me'
        : path === '/internal/auth/profile'
          ? (req.method === 'PATCH' ? 'updateProfile' : 'profile')
          : null;
  const method = action === 'me' || action === 'profile' ? 'GET' : action === 'updateProfile' ? 'PATCH' : 'POST';
  if (!action || req.method !== method) return false;
  if (!browserAuthService) {
    json(res, 503, { error: 'Authentication unavailable', code: 'AUTH_STORE_UNAVAILABLE' });
    return true;
  }
  try {
    const authorization = req.headers.authorization;
    if (action === 'me') {
      json(res, 200, await browserAuthService.me(authorization));
    } else if (action === 'profile') {
      json(res, 200, await browserAuthService.profile(authorization));
    } else if (action === 'updateProfile') {
      json(res, 200, await browserAuthService.updateProfile(authorization, await readJsonObject(req)));
    } else {
      json(res, 200, await browserAuthService[action](await readJsonObject(req)));
    }
  } catch (error) {
    const authError = error instanceof BrowserAuthError ? error : null;
    if (!authError) console.error('[agent-http] browser auth failed:', error);
    json(res, authError?.status || 500, {
      error: authError?.message || 'Internal server error',
      code: authError?.code || 'INTERNAL_ERROR',
    });
  }
  return true;
}

