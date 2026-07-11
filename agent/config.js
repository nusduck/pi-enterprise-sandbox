/**
 * Shared configuration for the Agent service.
 * All environment variable reads are centralized here.
 */

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
  PORT: parseInt(process.env.PORT, 10) || 4100,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  /**
   * Shared secret for BFF → Agent internal API.
   * Empty allows open dev mode (same host only recommended).
   */
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN || '',
  LLMIO_BASE_URL: process.env.LLMIO_BASE_URL || '',
  LLMIO_API_KEY: process.env.LLMIO_API_KEY || '',
  MODEL_ID: process.env.MODEL_ID || 'deepseek-v4-flash',
  NODE_ENV: process.env.NODE_ENV || 'development',
  APPROVAL_ENABLED: resolveApprovalEnabled(),
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};
