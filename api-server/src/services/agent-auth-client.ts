import { config } from '../config.js';
import { agentFetch, requestHeaders } from './agent-client.js';
import { throwAgentError } from './agent-error.js';
import type { RequestTraceContext } from '../application/trace-context.js';

/**
 * Stable code for a failure to reach or decode the Agent auth authority.
 *
 * The Agent credential service is a live dependency: an unreachable Agent, a
 * timeout, or a *successful* response whose body is not valid JSON is an
 * availability failure (503), not an authentication failure. Leaving the raw
 * `TypeError`/`SyntaxError` to bubble up made `sendError` produce a generic
 * `500 INTERNAL_ERROR`, which is neither diagnosable nor safe to render as
 * "logged out"/"unauthenticated".
 */
export const AUTH_DEPENDENCY_UNAVAILABLE = 'AUTH_DEPENDENCY_UNAVAILABLE';

/** The config proxy owns its own classification (design `sso-integration-reservation.md` §6). */
const AUTH_CONFIG_UNAVAILABLE = 'AUTH_CONFIG_UNAVAILABLE';

export interface AgentAuthOptions {
  method?: string;
  body?: unknown;
  authorization?: string | null;
  traceId?: string | null;
  traceContext?: RequestTraceContext | null;
  /**
   * Error code reported when the authority is unreachable or its successful
   * response cannot be decoded. Defaults to {@link AUTH_DEPENDENCY_UNAVAILABLE};
   * the config proxy overrides it to keep its `AUTH_CONFIG_UNAVAILABLE` shape.
   */
  dependencyCode?: string;
}

function authDependencyError(action: string, code: string, cause: unknown): Error & { status: number; code: string } {
  const error = new Error(
    `Agent auth ${action} unavailable`,
  ) as Error & { status: number; code: string; cause?: unknown };
  error.status = 503;
  error.code = code;
  error.cause = cause;
  return error;
}

async function requestAgentAuth(
  action: string,
  {
    method = 'POST',
    body = null,
    authorization = null,
    traceId = null,
    traceContext = null,
    dependencyCode = AUTH_DEPENDENCY_UNAVAILABLE,
  }: AgentAuthOptions = {},
): Promise<any> {
  let resp: Response;
  try {
    resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/auth/${action}`, {
      method,
      headers: requestHeaders({
        auth: authorization ? { authorization } : null,
        traceId,
        traceContext,
      }),
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    // Connection refused/reset, DNS failure, or the bounded timeout. There is
    // no upstream status to preserve, so classify the dependency itself.
    throw authDependencyError(action, dependencyCode, cause);
  }
  if (!resp.ok) {
    // An explicit upstream status/code (400/401/403/409/422,
    // AUTH_STORE_UNAVAILABLE, …) is authoritative and must pass through
    // unchanged rather than being rewritten as a dependency failure.
    await throwAgentError(resp, 'Agent auth request failed');
  }
  try {
    return await resp.json();
  } catch (cause) {
    // HTTP 2xx with an unparseable/empty body: the reply is not a usable auth
    // projection. Treat it as the authority being unavailable, not as
    // anonymous success.
    throw authDependencyError(action, dependencyCode, cause);
  }
}

/**
 * GET /internal/auth/config — the Agent is the login-capability authority.
 * Public at the BFF edge; the internal token gate is the only credential.
 * Rejects on transport/parse failure so callers never render a failure as an
 * empty capability set (design §6).
 */
export function authConfig(
  options: Omit<AgentAuthOptions, 'method' | 'body' | 'authorization'> = {},
): Promise<any> {
  return requestAgentAuth('config', {
    ...options,
    method: 'GET',
    dependencyCode: AUTH_CONFIG_UNAVAILABLE,
  });
}

export interface AgentLogoutResponse {
  status: number;
  body: unknown;
}

/**
 * POST /internal/auth/logout — revoke the current `sid`.
 *
 * Resolves with the raw upstream status/body so the caller can classify
 * `confirmed` / `not_required` / `unconfirmed` precisely; transport failures
 * (timeout, network) reject and must become `AUTH_REVOCATION_UNCONFIRMED`.
 * Non-2xx responses are intentionally *not* thrown here: the whole point of
 * the logout contract is that the failure class changes the browser result.
 */
export async function authLogout(
  auth: { authorization?: string | null } | null = null,
  options: Omit<AgentAuthOptions, 'method' | 'authorization' | 'body'> = {},
): Promise<AgentLogoutResponse> {
  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/auth/logout`, {
    method: 'POST',
    headers: requestHeaders({
      auth: auth?.authorization ? { authorization: auth.authorization } : null,
      traceId: options.traceId ?? null,
      traceContext: options.traceContext ?? null,
    }),
  });
  const body: unknown = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

/**
 * POST /internal/auth/oidc/exchange — hand the company ID token and the nonce
 * from the consumed login transaction to the Agent, which verifies it
 * independently and issues the platform session (design sso-oidc-dev §4.2).
 */
export function authSsoExchange(
  body: { id_token: string; nonce: string },
  options: Omit<AgentAuthOptions, 'body' | 'authorization'> = {},
): Promise<any> {
  return requestAgentAuth('oidc/exchange', { ...options, body });
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

/** GET / PATCH the caller's own profile (account page). */
export function authProfile(
  auth: { authorization?: string | null } | null = null,
  options: Omit<AgentAuthOptions, 'authorization'> = {},
): Promise<any> {
  return requestAgentAuth('profile', {
    method: 'GET',
    ...options,
    authorization: auth?.authorization || null,
  });
}
