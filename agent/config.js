/**
 * Shared configuration for the Agent service.
 * All environment variable reads are centralized here.
 */
import { readFileSync, existsSync } from 'node:fs';
import {
  resolveSkillsMode,
  resolveLocalAllowlist,
  resolveSkillRoots,
  SKILLS_MODE,
} from './skills/manager.js';
import { primarySkillRoot, DEFAULT_SKILL_ROOTS } from './skills/paths.js';
import {
  assertFakeLlmAllowed,
  isFakeLlmEnabled,
  FAKE_LLM_ENV,
} from './testing/fake-openai-provider.js';

const MIN_SECRET_LEN = 32;
const WEAK_SECRET_MARKERS = [
  'change-me',
  'changeme',
  'dev-only',
  'secret',
  'password',
  'example',
  'replace',
  'todo',
  'xxx',
];

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

/**
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {'development' | 'production'}
 */
export function resolveDeploymentEnv(env = process.env) {
  const raw = String(env.DEPLOYMENT_ENV || env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  return 'development';
}

/**
 * @param {string | undefined | null} value
 */
export function isWeakSecret(value) {
  const text = String(value || '').trim();
  if (text.length < MIN_SECRET_LEN) return true;
  const lower = text.toLowerCase();
  return WEAK_SECRET_MARKERS.some((m) => lower.includes(m));
}

/**
 * Load optional product-layer system prompt from env or file.
 * Platform security layer is always appended separately and cannot be disabled.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveProductSystemPrompt(env = process.env) {
  const filePath = env.AGENT_SYSTEM_PROMPT_FILE;
  if (filePath && String(filePath).trim()) {
    const path = String(filePath).trim();
    if (existsSync(path)) {
      return readFileSync(path, 'utf8');
    }
  }
  if (env.AGENT_SYSTEM_PROMPT != null && String(env.AGENT_SYSTEM_PROMPT).trim() !== '') {
    return String(env.AGENT_SYSTEM_PROMPT);
  }
  return '';
}

/**
 * Platform security / tools / artifact layer — never overridable by env alone.
 * Hard-deny, path boundaries, and artifact-only delivery remain code-enforced.
 */
export const PLATFORM_SYSTEM_PROMPT_LAYER = `
## Platform security (non-overridable)

- Obey sandbox path boundaries. Use workspace-relative paths, /home/sandbox/workspace/..., or the Conversation-owned persistent /tmp/....
- Never attempt privilege escalation, host filesystem access, or secret exfiltration.
- Do not disable or bypass hard_deny policies; security tools enforce them in code.
- Skills outside development mode are read-only; do not invent install/edit tools.
- Deliver user-facing files only via submit_artifact (artifact-only delivery).
- Never print API keys, tokens, passwords, database URLs, or full connection strings.
`.trim();

/**
 * Compose product (env) + platform layers. Product layer is fully env-controlled;
 * platform layer is always appended and cannot be turned off via env.
 * @param {string} [productPrompt]
 * @param {string} [platformLayer]
 */
export function composeSystemPrompt(
  productPrompt = '',
  platformLayer = PLATFORM_SYSTEM_PROMPT_LAYER,
) {
  const product = String(productPrompt || '').trim();
  const platform = String(platformLayer || PLATFORM_SYSTEM_PROMPT_LAYER).trim();
  if (!product) return platform;
  if (!platform) return product;
  // If product already embeds platform text, still re-append for invariant.
  if (product.includes('Platform security (non-overridable)')) {
    return product;
  }
  return `${product}\n\n${platform}`;
}

/**
 * Production fail-fast for Agent service. Call before listen.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @param {{ skillsMode?: string }} [opts]
 */
export function validateProductionConfig(env = process.env, opts = {}) {
  if (resolveDeploymentEnv(env) !== 'production') return;

  const errors = [];
  const internal = String(env.AGENT_INTERNAL_TOKEN || '').trim();
  const sandboxToken = String(env.SANDBOX_API_TOKEN || '').trim();
  const skillsMode = opts.skillsMode || resolveSkillsMode(env);

  if (!internal) {
    errors.push('AGENT_INTERNAL_TOKEN must be non-empty in production');
  } else if (isWeakSecret(internal)) {
    errors.push(
      `AGENT_INTERNAL_TOKEN is weak or shorter than ${MIN_SECRET_LEN} characters`,
    );
  }

  if (!sandboxToken) {
    errors.push('SANDBOX_API_TOKEN must be non-empty in production');
  } else if (isWeakSecret(sandboxToken)) {
    errors.push(
      `SANDBOX_API_TOKEN is weak or shorter than ${MIN_SECRET_LEN} characters`,
    );
  }

  if (skillsMode === SKILLS_MODE.DEVELOPMENT) {
    errors.push('SKILLS_MODE=development is forbidden in production (use readonly)');
  }

  const baseUrl = String(env.LLMIO_BASE_URL || '').toLowerCase();
  if (
    baseUrl.includes('fake') ||
    baseUrl.includes('127.0.0.1') ||
    baseUrl.includes('localhost') ||
    env.LLM_PROVIDER === 'fake' ||
    env.AGENT_FAKE_PROVIDER === 'true' ||
    isFakeLlmEnabled(env)
  ) {
    errors.push('Fake / localhost LLM provider is forbidden in production');
  }

  // Also enforce the dedicated test flag path (throws with a clear message).
  try {
    assertFakeLlmAllowed(env);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  if (errors.length) {
    const err = new Error(
      `Production configuration is unsafe (${errors.length} issue(s)): ${errors.join('; ')}`,
    );
    err.name = 'ProductionConfigError';
    err.errors = errors;
    throw err;
  }
}

/**
 * Redacted effective config for INFO logs (never tokens/secrets/full prompt).
 * @param {typeof config} [cfg]
 */
export function effectiveConfig(cfg = config) {
  return {
    PORT: cfg.PORT,
    NODE_ENV: cfg.NODE_ENV,
    DEPLOYMENT_ENV: cfg.DEPLOYMENT_ENV,
    SANDBOX_BASE_URL: cfg.SANDBOX_BASE_URL,
    SANDBOX_API_TOKEN: cfg.SANDBOX_API_TOKEN ? '***' : '<empty>',
    AGENT_INTERNAL_TOKEN: cfg.AGENT_INTERNAL_TOKEN ? '***' : '<empty>',
    LLMIO_BASE_URL: cfg.LLMIO_BASE_URL ? cfg.LLMIO_BASE_URL : '<empty>',
    LLMIO_API_KEY: cfg.LLMIO_API_KEY ? '***' : '<empty>',
    MODEL_ID: cfg.MODEL_ID,
    // Env overrides remain for backward compat; hot path uses model registry.
    MODEL_CONTEXT_WINDOW: cfg.MODEL_CONTEXT_WINDOW,
    MODEL_MAX_TOKENS: cfg.MODEL_MAX_TOKENS,
    MODEL_REGISTRY_PATH: cfg.MODEL_REGISTRY_PATH || process.env.MODEL_REGISTRY_PATH || '<default>',
    APPROVAL_ENABLED: cfg.APPROVAL_ENABLED,
    SKILLS_MODE: cfg.SKILLS_MODE,
    SKILLS_ROOT: cfg.SKILLS_ROOT,
    SKILLS_INSTALL_LOCAL_ALLOWLIST: cfg.SKILLS_INSTALL_LOCAL_ALLOWLIST,
    SKILLS_AUDIT_LOG: cfg.SKILLS_AUDIT_LOG ? '<set>' : '<empty>',
    SESSION_WORKSPACE_CWD: cfg.SESSION_WORKSPACE_CWD,
    PRODUCT_SYSTEM_PROMPT: cfg.PRODUCT_SYSTEM_PROMPT
      ? `<set:${cfg.PRODUCT_SYSTEM_PROMPT.length} chars>`
      : '<empty>',
    // Full composed prompt never dumped.
    SYSTEM_PROMPT: '<redacted>',
    AGENT_FORCE_INMEMORY: Boolean(cfg.AGENT_FORCE_INMEMORY),
  };
}

export { resolveSkillsMode, SKILLS_MODE, resolveLocalAllowlist, resolveSkillRoots };
export { assertFakeLlmAllowed, isFakeLlmEnabled, FAKE_LLM_ENV };

// Fail closed at import when production tries to enable the test-only fake LLM.
assertFakeLlmAllowed(process.env);

const skillRoots = resolveSkillRoots();
const productSystemPrompt = resolveProductSystemPrompt();

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4100,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  /**
   * Stable logical cwd recorded by Pi SDK sessions after Sandbox creates or
   * reuses the session workspace. This is intentionally not a physical host
   * path; sandbox tools normalize it to the same REST path identity.
   */
  SESSION_WORKSPACE_CWD:
    process.env.AGENT_SESSION_WORKSPACE_CWD || '/home/sandbox/workspace',
  /**
   * Shared secret for BFF → Agent internal API.
   * Empty allows open dev mode (same host only recommended).
   */
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN || '',
  LLMIO_BASE_URL: process.env.LLMIO_BASE_URL || '',
  LLMIO_API_KEY: process.env.LLMIO_API_KEY || '',
  MODEL_ID: process.env.MODEL_ID || 'deepseek-v4-flash',
  /**
   * Backward-compatible env overrides applied on top of the Model Registry
   * entry for the active MODEL_ID. Registry is the sole capability source on
   * the session-create hot path (see services/model-registry.js).
   */
  MODEL_CONTEXT_WINDOW: parseInt(process.env.MODEL_CONTEXT_WINDOW, 10) || 128000,
  MODEL_MAX_TOKENS: parseInt(process.env.MODEL_MAX_TOKENS, 10) || 8192,
  /** Optional path to enterprise model-registry.json (overrides seed). */
  MODEL_REGISTRY_PATH: process.env.MODEL_REGISTRY_PATH || '',
  /** True only when AGENT_ENABLE_FAKE_LLM is set and production guards pass. */
  FAKE_LLM_ENABLED: isFakeLlmEnabled(),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DEPLOYMENT_ENV: resolveDeploymentEnv(),
  APPROVAL_ENABLED: resolveApprovalEnabled(),
  /**
   * Skill management mode.
   * - readonly (default): production-safe; skill_install/edit absent; skill tree R/O policy
   * - development: dedicated skill_install / skill_edit / skill_reload tools enabled
   * Requires a writable skills volume mount when development (see AGENT_SKILLS_MOUNT).
   */
  SKILLS_MODE: resolveSkillsMode(),
  /** Primary skill root on the agent (shared volume). */
  SKILLS_ROOT: primarySkillRoot(skillRoots),
  SKILL_ROOTS: skillRoots,
  /** Comma-separated allowlisted absolute dirs for local skill_install sources. */
  SKILLS_INSTALL_LOCAL_ALLOWLIST: resolveLocalAllowlist(),
  /** Optional file path for skill change audit lines (also always console). */
  SKILLS_AUDIT_LOG: process.env.SKILLS_AUDIT_LOG || '',
  DEFAULT_SKILL_ROOTS,
  /** Env-controlled product/role layer only (no secrets). */
  PRODUCT_SYSTEM_PROMPT: productSystemPrompt,
  /**
   * Full system prompt = product layer + non-overridable platform layer.
   * Platform security cannot be disabled via env.
   */
  SYSTEM_PROMPT: composeSystemPrompt(productSystemPrompt),
  /**
   * Rollback flag: force SessionManager.inMemory() and skip DB session restore.
   * Default false — production uses durable agent_sessions + JSONL materialize.
   */
  AGENT_FORCE_INMEMORY:
    String(process.env.AGENT_FORCE_INMEMORY || '')
      .trim()
      .toLowerCase() === 'true' ||
    String(process.env.AGENT_FORCE_INMEMORY || '').trim() === '1',
};

export const AUTH_HEADER = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};
