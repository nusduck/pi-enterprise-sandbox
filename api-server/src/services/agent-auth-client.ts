import { config } from '../config.js';
import { agentFetch, requestHeaders } from './agent-client.js';
import type { RequestTraceContext } from '../application/trace-context.js';

export interface AgentAuthOptions {
  method?: string;
  body?: unknown;
  authorization?: string | null;
  traceId?: string | null;
  traceContext?: RequestTraceContext | null;
}

async function requestAgentAuth(
  action: string,
  { method = 'POST', body = null, authorization = null, traceId = null, traceContext = null }: AgentAuthOptions = {},
): Promise<any> {
  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/auth/${action}`, {
    method,
    headers: requestHeaders({
      auth: authorization ? { authorization } : null,
      traceId,
      traceContext,
    }),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
    const error = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent auth request failed (${resp.status})`,
    ) as Error & { status: number; code?: string };
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

export function authRegister(body: unknown, options: Omit<AgentAuthOptions, 'body'> = {}): Promise<any> {
  return requestAgentAuth('register', { ...options, body });
}

export function authLogin(body: unknown, options: Omit<AgentAuthOptions, 'body'> = {}): Promise<any> {
  return requestAgentAuth('login', { ...options, body });
}

export function authMe(
  auth: { authorization?: string | null } | null = null,
  options: Omit<AgentAuthOptions, 'method' | 'authorization'> = {},
): Promise<any> {
  return requestAgentAuth('me', {
    ...options,
    method: 'GET',
    authorization: auth?.authorization || null,
  });
}


