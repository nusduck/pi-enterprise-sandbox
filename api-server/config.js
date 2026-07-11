/**
 * Shared configuration for the API Server (thin BFF).
 * All environment variable reads are centralized here.
 */

/**
 * Whether BFF should require browser Authorization on user-facing routes.
 * Aligns with SANDBOX_AUTH_ENABLED when AUTH_ENABLED is unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveAuthEnabled(env = process.env) {
  if (env.AUTH_ENABLED != null && String(env.AUTH_ENABLED).trim() !== '') {
    return String(env.AUTH_ENABLED).toLowerCase() === 'true';
  }
  if (env.SANDBOX_AUTH_ENABLED != null && String(env.SANDBOX_AUTH_ENABLED).trim() !== '') {
    return String(env.SANDBOX_AUTH_ENABLED).toLowerCase() === 'true';
  }
  return false;
}

/**
 * Whether interactive approval is required for high-risk tools.
 * Default true. When false, approval_required tools execute with bypass audit;
 * hard_deny is never overridden. Aligns with SANDBOX_APPROVAL_ENABLED when unset.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveApprovalEnabled(env = process.env) {
  if (env.APPROVAL_ENABLED != null && String(env.APPROVAL_ENABLED).trim() !== '') {
    return String(env.APPROVAL_ENABLED).toLowerCase() !== 'false';
  }
  if (env.SANDBOX_APPROVAL_ENABLED != null && String(env.SANDBOX_APPROVAL_ENABLED).trim() !== '') {
    return String(env.SANDBOX_APPROVAL_ENABLED).toLowerCase() !== 'false';
  }
  return true;
}

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4000,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  /**
   * Independent Agent service base URL (no trailing slash).
   * BFF relays POST /api/chat → Agent internal run API.
   */
  AGENT_BASE_URL: (process.env.AGENT_BASE_URL || 'http://agent:4100').replace(/\/$/, ''),
  /**
   * Shared secret for BFF → Agent. Empty allows open dev mode.
   */
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  /**
   * When true, protect user-facing /api/* routes with Bearer token and
   * forward Authorization to sandbox. Default false (open dev mode).
   */
  AUTH_ENABLED: resolveAuthEnabled(),
  /**
   * Interactive human approval for high-risk tools. Default true.
   * false → risk tools execute with bypass audit; hard_deny still blocks.
   * Surfaced on status for UI; enforcement lives in Agent + Sandbox.
   */
  APPROVAL_ENABLED: resolveApprovalEnabled(),
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};

/**
 * Paths that remain public when AUTH_ENABLED (status + auth proxy).
 * @param {string} path
 */
export function isPublicApiPath(path) {
  if (path === '/api/status') return true;
  if (path.startsWith('/api/auth/')) return true;
  return false;
}

/**
 * Whether *path* requires browser Authorization when AUTH_ENABLED.
 * @param {string} path
 */
export function isProtectedApiPath(path) {
  if (!path.startsWith('/api/')) return false;
  if (isPublicApiPath(path)) return false;
  return (
    path === '/api/chat' ||
    path.startsWith('/api/conversations') ||
    path.startsWith('/api/files/') ||
    path.startsWith('/api/sessions') ||
    path.startsWith('/api/artifacts') ||
    path.startsWith('/api/approvals')
  );
}
