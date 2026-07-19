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

const POLICY_PROFILES = new Set(['strict', 'balanced']);

function envTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function effectiveBubblewrap(env = process.env) {
  return (
    String(env.SANDBOX_ISOLATION_BACKEND || '').trim().toLowerCase() === 'bubblewrap' &&
    envTruthy(env.SANDBOX_ISOLATION_REQUIRED)
  );
}

export function requestedPolicyProfile(env = process.env) {
  const raw = String(env.SANDBOX_POLICY_PROFILE || 'strict').trim().toLowerCase();
  if (!POLICY_PROFILES.has(raw)) {
    throw new Error(
      `Invalid SANDBOX_POLICY_PROFILE=${raw || '<empty>'}; expected strict|balanced`,
    );
  }
  return raw;
}

/** Balanced fails fast unless required bwrap is effective. */
export function resolvePolicyProfile(env = process.env) {
  const requested = requestedPolicyProfile(env);
  if (requested === 'balanced' && !effectiveBubblewrap(env)) {
    throw new Error(
      'SANDBOX_POLICY_PROFILE=balanced requires effective SANDBOX_ISOLATION_BACKEND=bubblewrap and SANDBOX_ISOLATION_REQUIRED=true',
    );
  }
  return requested;
}

/** Supported approval behavior for approval_required policy results. */
export const APPROVAL_MODES = Object.freeze({
  ASK: 'ask',
  AUTO_APPROVE: 'auto_approve',
  DENY: 'deny',
});

function nonEmptyEnv(env, key) {
  const value = env?.[key];
  return value != null && String(value).trim() !== '' ? String(value).trim() : null;
}

function parseLegacyApprovalEnabled(value) {
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`Invalid APPROVAL_ENABLED=${value}; expected true or false`);
}

/**
 * Resolve the global approval policy. Default is ask. Legacy booleans map
 * true → ask and false → deny, so disabling the ask switch never broadens
 * permissions. auto_approve is explicit and intended only for development.
 * @param {NodeJS.ProcessEnv | Record<string, string|boolean|undefined>} [env]
 */
export function resolveApprovalMode(env = process.env) {
  const explicit = nonEmptyEnv(env, 'APPROVAL_MODE') || nonEmptyEnv(env, 'SANDBOX_APPROVAL_MODE');
  if (explicit) {
    const mode = explicit.toLowerCase().replaceAll('-', '_');
    if (Object.values(APPROVAL_MODES).includes(mode)) return mode;
    throw new Error(
      `Invalid APPROVAL_MODE=${explicit}; expected ask|auto_approve|deny`,
    );
  }

  const legacy = nonEmptyEnv(env, 'APPROVAL_ENABLED') || nonEmptyEnv(env, 'SANDBOX_APPROVAL_ENABLED');
  if (legacy != null) {
    return parseLegacyApprovalEnabled(legacy)
      ? APPROVAL_MODES.ASK
      : APPROVAL_MODES.DENY;
  }
  return APPROVAL_MODES.ASK;
}

/** @param {NodeJS.ProcessEnv | Record<string, string|boolean|undefined>} [env] */
export function resolveApprovalEnabled(env = process.env) {
  return resolveApprovalMode(env) !== APPROVAL_MODES.DENY;
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
  const productionSkillRoots = resolveSkillRoots(env);
  const requestedProfile = requestedPolicyProfile(env);
  const approvalMode = resolveApprovalMode(env);
  const a2aPublicBaseUrl = String(env.A2A_PUBLIC_BASE_URL || '').trim();
  const a2aDownloadSecret = String(
    env.A2A_ARTIFACT_DOWNLOAD_SECRET || '',
  ).trim();

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
  if (
    productionSkillRoots.length !== 1 ||
    productionSkillRoots[0] !== DEFAULT_SKILL_ROOTS[0]
  ) {
    errors.push(
      `SKILLS_ROOT must be the canonical ${DEFAULT_SKILL_ROOTS[0]} path in production`,
    );
  }

  if (requestedProfile === 'balanced' && !effectiveBubblewrap(env)) {
    errors.push(
      'SANDBOX_POLICY_PROFILE=balanced requires effective SANDBOX_ISOLATION_BACKEND=bubblewrap and SANDBOX_ISOLATION_REQUIRED=true',
    );
  }
  if (requestedProfile === 'balanced') {
    errors.push('SANDBOX_POLICY_PROFILE=balanced is forbidden in production (use strict)');
  }

  if (approvalMode === APPROVAL_MODES.AUTO_APPROVE) {
    errors.push('APPROVAL_MODE=auto_approve is forbidden in production (use ask or deny)');
  }

  if (!a2aPublicBaseUrl) {
    errors.push('A2A_PUBLIC_BASE_URL must be set in production');
  } else {
    try {
      const parsed = new URL(a2aPublicBaseUrl);
      if (
        parsed.protocol !== 'https:' ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/'
      ) {
        errors.push(
          'A2A_PUBLIC_BASE_URL must be an https origin without path, credentials, query, or fragment',
        );
      }
    } catch {
      errors.push('A2A_PUBLIC_BASE_URL must be a valid https origin');
    }
  }
  if (isWeakSecret(a2aDownloadSecret)) {
    errors.push(
      `A2A_ARTIFACT_DOWNLOAD_SECRET is weak or shorter than ${MIN_SECRET_LEN} characters`,
    );
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
    RUN_INITIALIZATION_TIMEOUT_MS: cfg.RUN_INITIALIZATION_TIMEOUT_MS,
    NODE_ENV: cfg.NODE_ENV,
    DEPLOYMENT_ENV: cfg.DEPLOYMENT_ENV,
    SANDBOX_BASE_URL: cfg.SANDBOX_BASE_URL,
    SANDBOX_API_TOKEN: cfg.SANDBOX_API_TOKEN ? '***' : '<empty>',
    AGENT_INTERNAL_TOKEN: cfg.AGENT_INTERNAL_TOKEN ? '***' : '<empty>',
    A2A_PUBLIC_BASE_URL: cfg.A2A_PUBLIC_BASE_URL || '<empty>',
    A2A_ARTIFACT_DOWNLOAD_SECRET: cfg.A2A_ARTIFACT_DOWNLOAD_SECRET
      ? '***'
      : '<empty>',
    LLMIO_BASE_URL: cfg.LLMIO_BASE_URL ? cfg.LLMIO_BASE_URL : '<empty>',
    LLMIO_API_KEY: cfg.LLMIO_API_KEY ? '***' : '<empty>',
    MODEL_ID: cfg.MODEL_ID,
    // Env overrides remain for backward compat; hot path uses model registry.
    MODEL_CONTEXT_WINDOW: cfg.MODEL_CONTEXT_WINDOW,
    MODEL_MAX_TOKENS: cfg.MODEL_MAX_TOKENS,
    MODEL_REGISTRY_PATH: cfg.MODEL_REGISTRY_PATH || process.env.MODEL_REGISTRY_PATH || '<default>',
    APPROVAL_MODE: cfg.APPROVAL_MODE,
    APPROVAL_ENABLED: cfg.APPROVAL_ENABLED,
    POLICY_PROFILE: cfg.POLICY_PROFILE,
    SKILLS_MODE: cfg.SKILLS_MODE,
    SKILLS_ROOT: cfg.SKILLS_ROOT,
    SKILLS_INSTALL_LOCAL_ALLOWLIST: cfg.SKILLS_INSTALL_LOCAL_ALLOWLIST,
    SKILLS_AUDIT_LOG: cfg.SKILLS_AUDIT_LOG ? '<set>' : '<empty>',
    MCP_SERVERS: Array.isArray(cfg.MCP_SERVERS) ? cfg.MCP_SERVERS.map((server) => server.id) : [],
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

function resolveMcpServers(env = process.env) {
  if (!env.MCP_SERVERS_JSON) return [];
  try {
    const parsed = JSON.parse(env.MCP_SERVERS_JSON);
    if (!Array.isArray(parsed)) throw new Error('must be an array');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid MCP_SERVERS_JSON: ${error.message}`);
  }
}

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4100,
  /** Public https origin for Agent Card / artifact download URLs (no path). */
  A2A_PUBLIC_BASE_URL: process.env.A2A_PUBLIC_BASE_URL || '',
  /** HMAC secret for short-lived artifact download tokens (≥32 chars). */
  A2A_ARTIFACT_DOWNLOAD_SECRET: process.env.A2A_ARTIFACT_DOWNLOAD_SECRET || '',
  /** Dev-only: allow loopback Host fallback when A2A_PUBLIC_BASE_URL unset. */
  A2A_ALLOW_DEV_HOST_FALLBACK:
    String(process.env.A2A_ALLOW_DEV_HOST_FALLBACK || '').toLowerCase() ===
    'true',
  // Bounded publication barrier for conversation/session/durable-run setup.
  RUN_INITIALIZATION_TIMEOUT_MS: Math.min(
    60_000,
    Math.max(1_000, parseInt(process.env.AGENT_RUN_INIT_TIMEOUT_MS, 10) || 15_000),
  ),
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
  APPROVAL_MODE: resolveApprovalMode(),
  // Legacy projection retained for older status consumers.
  APPROVAL_ENABLED: resolveApprovalEnabled(),
  /** strict by default; balanced only activates with effective required bwrap. */
  POLICY_PROFILE: resolvePolicyProfile(),
  /** External MCP servers owned by Agent Runtime/MCP Gateway, never Sandbox. */
  MCP_SERVERS: resolveMcpServers(),
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
  /** Legacy composed prompt export; runtime composition is owned by Prompt Extension. */
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

/** Resolve at request time so an existing client observes in-process rotation. */
export function resolveSandboxAuthHeader(env = process.env) {
  const token = String(env?.SANDBOX_API_TOKEN || '').trim();
  return token ? { 'X-API-Key': token } : {};
}

// Compatibility snapshot for external imports. Production request paths call
// resolveSandboxAuthHeader() and do not retain this module-load value.
export const AUTH_HEADER = resolveSandboxAuthHeader();
