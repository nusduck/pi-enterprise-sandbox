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
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};

/** @returns {boolean} true when chat should proxy to Python agent */
export function isPythonAgentRuntime(runtime = config.AGENT_RUNTIME) {
  return normalizeAgentRuntime(runtime) === 'python';
}
