/**
 * 浏览器认证 API（BFF `POST/GET /api/auth/*`）。
 *
 * 与其它资源模块分开的原因：认证请求的错误**形状**本身就是契约（401/403/
 * 409/503 + code），调用方（身份边界与退出流程）要按状态分流，不能只拿到一句
 * message。所有函数把 HTTP 失败抛成带 `status` / `code` 的 `ApiError`；退出登录
 * 的成功响应体是 `{revocation}`，由 `authConfig.ts` 解释。
 *
 * 安全边界：会话只存在 BFF 的 HttpOnly Cookie 里，这里的响应体永远不含 token。
 */
import { z } from 'zod';
import { ApiError } from './client';
import type { AuthConfig } from '../schemas/auth';
import { AuthConfigSchema } from '../schemas/auth';
import {
  AuthResponseSchema,
  AuthUserSchema,
  parseApi,
  parseApiStrict,
  type AuthResponse,
  type AuthUser,
} from '../schemas/api';
import { interpretLogoutResult, type LogoutOutcome } from './authConfig';

const BASE = '/api';

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

type Reply = { status: number; code: string | null; message: string; data: unknown };

/**
 * 读取一次认证请求的失败形状。3xx 视为未认证：BFF 在没有有效会话时才可能
 * 把 me/config 重定向到登录页，前端不应继续跟随后得到一份 HTML。
 */
async function readAuthReply(
  resp: Response,
  fallback: string,
): Promise<Reply> {
  const data = await resp.json().catch(() => ({}));
  const body = (data || {}) as Record<string, unknown>;
  const redirected = resp.status >= 300 && resp.status < 400;
  const code = typeof body.code === 'string' ? body.code : redirected ? 'INVALID_TOKEN' : null;
  const message = String(body.error || body.detail || `${fallback}: ${resp.status}`);
  return {
    status: redirected ? 401 : resp.status,
    code,
    message,
    data,
  };
}

function throwAuthError(reply: Reply): never {
  throw new ApiError(reply.message, { status: reply.status, code: reply.code });
}

async function postCredentials(
  path: 'login' | 'register',
  body: Record<string, unknown>,
): Promise<AuthResponse> {
  const resp = await fetch(`${BASE}/auth/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throwAuthError(await readAuthReply(resp, path === 'login' ? 'Login failed' : 'Register failed'));
  }
  return parseApi(AuthResponseSchema, await resp.json(), path);
}

export function login(body: { username: string; password: string }): Promise<AuthResponse> {
  return postCredentials('login', body);
}

export function register(body: {
  username: string;
  password: string;
  display_name?: string;
}): Promise<AuthResponse> {
  return postCredentials('register', body);
}

export function me(): Promise<AuthUser> {
  return fetchAuthJson(`${BASE}/auth/me`, 'Me failed', AuthUserSchema) as Promise<AuthUser>;
}

/** `GET /api/auth/config`：登录能力投影，未登录可读。 */
export async function getAuthConfig(): Promise<AuthConfig> {
  const resp = await fetch(`${BASE}/auth/config`, { credentials: 'include' });
  if (!resp.ok) throwAuthError(await readAuthReply(resp, 'Auth config failed'));
  // Login capabilities are a strict contract: drift must remain a retryable
  // error rather than becoming a successfully loaded empty capability set.
  return parseApiStrict(AuthConfigSchema, await resp.json(), 'auth config');
}

async function fetchAuthJson<T>(
  url: string,
  fallback: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) throwAuthError(await readAuthReply(resp, fallback));
  return parseApi(schema, await resp.json(), fallback);
}

/**
 * `POST /api/auth/logout`。只要 BFF 返回了可解析的 200 契约就返回 `LogoutOutcome`；
 * 409/503 抛带 code 的 `ApiError`，网络失败照常抛，由调用方统一按「本机已退出、
 * 服务端撤销未确认」处理。**绝不自动重试**：重试可能带着已切号的 Cookie。
 */
export async function logout(): Promise<LogoutOutcome> {
  const resp = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (resp.ok) {
    return interpretLogoutResult(await resp.json().catch(() => ({})));
  }
  throwAuthError(await readAuthReply(resp, 'Logout failed'));
}

// 兼容既有导入路径（旧代码从 ./client 取这些函数，e2e 夹具也从那里取 login）。
export { ApiError } from './client';
export type { AuthResponse, AuthUser } from '../schemas/api';
export type { AuthConfig } from '../schemas/auth';
