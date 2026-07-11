/**
 * Shared configuration for the API Server.
 * All environment variable reads are centralized here.
 */

/**
 * Normalize AGENT_RUNTIME env: `node` (default) | `python`.
 * Unknown values fall back to `node` so production never silently flips.
 * @param {string | undefined} raw
 * @returns {'node' | 'python'}
 */
export function normalizeAgentRuntime(raw) {
  const v = String(raw || 'node').trim().toLowerCase();
  if (v === 'python') return 'python';
  return 'node';
}

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

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4000,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  LLMIO_BASE_URL: process.env.LLMIO_BASE_URL || '',
  LLMIO_API_KEY: process.env.LLMIO_API_KEY || '',
  MODEL_ID: process.env.MODEL_ID || 'deepseek-v4-flash',
  NODE_ENV: process.env.NODE_ENV || 'development',
  /**
   * Agent orchestration host for POST /api/chat:
   * - `node` (default): local pi-coding-agent handleChat path
   * - `python`: SSE proxy to sandbox POST /agent/chat
   * Rollback: set AGENT_RUNTIME=node and restart api-server.
   */
  AGENT_RUNTIME: normalizeAgentRuntime(process.env.AGENT_RUNTIME),
  /**
   * When true, protect user-facing /api/* routes with Bearer token and
   * forward Authorization to sandbox. Default false (open dev mode).
   */
  AUTH_ENABLED: resolveAuthEnabled(),
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};

/** @returns {boolean} true when chat should proxy to Python agent */
export function isPythonAgentRuntime(runtime = config.AGENT_RUNTIME) {
  return normalizeAgentRuntime(runtime) === 'python';
}

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
