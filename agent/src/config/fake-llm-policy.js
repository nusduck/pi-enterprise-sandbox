/**
 * Runtime policy for the explicitly enabled fake LLM.
 *
 * The HTTP fake itself lives under tests/support. Production configuration
 * imports only this fail-closed policy, so runtime code never depends on test
 * infrastructure.
 */

/** Env flag that enables the test-only fake provider. */
export const FAKE_LLM_ENV = 'AGENT_ENABLE_FAKE_LLM';

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function isFakeLlmEnabled(env = process.env) {
  const raw = env[FAKE_LLM_ENV];
  if (raw == null || String(raw).trim() === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * Fail closed when a production process attempts to enable the fake provider.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function assertFakeLlmAllowed(env = process.env) {
  if (!isFakeLlmEnabled(env)) return false;
  const nodeEnv = String(env.NODE_ENV || '').toLowerCase();
  const deployEnv = String(env.DEPLOYMENT_ENV || '').toLowerCase();
  if (nodeEnv === 'production' || deployEnv === 'production') {
    throw new Error(
      `${FAKE_LLM_ENV} is forbidden when NODE_ENV or DEPLOYMENT_ENV is production`,
    );
  }
  return true;
}
