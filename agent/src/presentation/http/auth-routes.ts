import type { IncomingMessage, ServerResponse } from 'node:http';
import { BrowserAuthError } from '../../application/browser-auth-service.js';
import { json, readBody } from './request-response.js';

type BrowserAuthLike = {
  register(body: Record<string, unknown>): Promise<unknown>;
  login(body: Record<string, unknown>): Promise<unknown>;
  me(authorization: string | undefined): Promise<unknown>;
};

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
        : null;
  if (!action || (action === 'me' ? req.method !== 'GET' : req.method !== 'POST')) return false;
  if (!browserAuthService) {
    json(res, 503, { error: 'Authentication unavailable', code: 'AUTH_STORE_UNAVAILABLE' });
    return true;
  }
  try {
    if (action === 'me') {
      json(res, 200, await browserAuthService.me(req.headers.authorization));
    } else {
      const raw = await readBody(req, 16_384);
      let body: Record<string, unknown>;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        throw new BrowserAuthError(400, 'INVALID_JSON', 'Invalid JSON body');
      }
      json(res, 200, await browserAuthService[action](body));
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

