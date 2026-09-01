import { config } from '../config.js';
import { agentFetch, requestHeaders } from './agent-client.js';

async function requestAgentAuth(
  action,
  { method = 'POST', body = null, authorization = null, traceId = null, traceContext = null } = {},
) {
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
    const payload = await resp.json().catch(() => ({}));
    const error = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent auth request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

export function authRegister(body, options = {}) {
  return requestAgentAuth('register', { ...options, body });
}

export function authLogin(body, options = {}) {
  return requestAgentAuth('login', { ...options, body });
}

export function authMe(auth = null, options = {}) {
  return requestAgentAuth('me', {
    ...options,
    method: 'GET',
    authorization: auth?.authorization || null,
  });
}

