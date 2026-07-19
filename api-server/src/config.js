/**
 * Shared configuration for the API Server (thin BFF).
 * All environment variable reads are centralized here.
 */

const MIN_SECRET_LEN = 32;
const DEFAULT_DATASET_UPLOAD_MAX_BYTES = 55 * 1024 * 1024;
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
 * Maximum multipart request size accepted by the Dataset streaming proxy.
 * Invalid values fail closed to the documented default instead of disabling
 * the limit through NaN/negative configuration.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveDatasetUploadMaxBytes(env = process.env) {
  const raw = String(env.DATASET_UPLOAD_MAX_BYTES || '').trim();
  if (!raw) return DEFAULT_DATASET_UPLOAD_MAX_BYTES;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_DATASET_UPLOAD_MAX_BYTES;
}

/**
 * Stable external subjects used only by the explicit auth-disabled development
 * mode. Agent maps these subjects to internal ULIDs on first use. Production
 * rejects AUTH_ENABLED=false before the BFF starts.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function resolveDevelopmentActingIdentity(env = process.env) {
  const requestedRole = String(env.BFF_DEV_ACTING_ROLE || 'user')
    .trim()
    .toLowerCase();
  // Development-only convenience for exercising the A2A admin surface. The
  // authenticated production path resolves role from Sandbox instead.
  const actingRole = requestedRole === 'admin' ? 'admin' : 'user';
  return Object.freeze({
    actingUserId:
      String(env.BFF_DEV_ACTING_USER_ID || '').trim() || 'local-development-user',
    actingOrganizationId:
      String(env.BFF_DEV_ACTING_ORGANIZATION_ID || '').trim() ||
      'local-development-org',
    actingRole,
  });
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
 * Production fail-fast for BFF. Call before listen.
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 */
export function validateProductionConfig(env = process.env) {
  if (resolveDeploymentEnv(env) !== 'production') return;

  const errors = [];
  const internal = String(env.AGENT_INTERNAL_TOKEN || '').trim();
  const sandboxToken = String(env.SANDBOX_API_TOKEN || '').trim();
  const authEnabled = resolveAuthEnabled(env);

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

  if (!authEnabled) {
    errors.push('AUTH_ENABLED (or SANDBOX_AUTH_ENABLED) must be true in production');
  }

  if (resolveApprovalMode(env) === APPROVAL_MODES.AUTO_APPROVE) {
    errors.push('APPROVAL_MODE=auto_approve is forbidden in production (use ask or deny)');
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
 * Redacted effective config for INFO logs.
 * @param {typeof config} [cfg]
 */
export function effectiveConfig(cfg = config) {
  return {
    PORT: cfg.PORT,
    NODE_ENV: cfg.NODE_ENV,
    DEPLOYMENT_ENV: cfg.DEPLOYMENT_ENV,
    SANDBOX_BASE_URL: cfg.SANDBOX_BASE_URL,
    SANDBOX_API_TOKEN: cfg.SANDBOX_API_TOKEN ? '***' : '<empty>',
    AGENT_BASE_URL: cfg.AGENT_BASE_URL,
    AGENT_INTERNAL_TOKEN: cfg.AGENT_INTERNAL_TOKEN ? '***' : '<empty>',
    AUTH_ENABLED: cfg.AUTH_ENABLED,
    APPROVAL_MODE: cfg.APPROVAL_MODE,
    APPROVAL_ENABLED: cfg.APPROVAL_ENABLED,
    JSON_BODY_LIMIT_BYTES: cfg.JSON_BODY_LIMIT_BYTES,
    DATASET_UPLOAD_MAX_BYTES: cfg.DATASET_UPLOAD_MAX_BYTES,
    CORS_ALLOWED_ORIGINS: cfg.CORS_ALLOWED_ORIGINS,
  };
}

export const config = {
  PORT: parseInt(process.env.PORT, 10) || 4000,
  SANDBOX_BASE_URL: process.env.SANDBOX_BASE_URL || 'http://sandbox:8081',
  SANDBOX_API_TOKEN: process.env.SANDBOX_API_TOKEN || '',
  /**
   * Independent Agent service base URL (no trailing slash).
   * BFF relays the Run API → Agent internal run API.
   */
  AGENT_BASE_URL: (process.env.AGENT_BASE_URL || 'http://agent:4100').replace(/\/$/, ''),
  /**
   * Shared secret for BFF → Agent. Empty allows open dev mode.
   */
  AGENT_INTERNAL_TOKEN: process.env.AGENT_INTERNAL_TOKEN || '',
  NODE_ENV: process.env.NODE_ENV || 'development',
  DEPLOYMENT_ENV: resolveDeploymentEnv(),
  /**
   * When true, protect user-facing /api/* routes with Bearer token and
   * forward Authorization to sandbox. Default false (open dev mode).
   */
  AUTH_ENABLED: resolveAuthEnabled(),
  DEVELOPMENT_ACTING_IDENTITY: resolveDevelopmentActingIdentity(),
  /**
   * Approval behavior for high-risk tools. Default ask. Legacy false maps to deny;
   * auto_approve requires an explicit mode and is rejected in production.
   * Surfaced on status for UI; enforcement lives in Agent + Sandbox.
   */
  APPROVAL_MODE: resolveApprovalMode(),
  APPROVAL_ENABLED: resolveApprovalEnabled(),
  JSON_BODY_LIMIT_BYTES:
    parseInt(process.env.JSON_BODY_LIMIT_BYTES, 10) || 1024 * 1024,
  DATASET_UPLOAD_MAX_BYTES: resolveDatasetUploadMaxBytes(),
  CORS_ALLOWED_ORIGINS: String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
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
  if (path === '/health/live' || path === '/health/ready') return true;
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
    path.startsWith('/api/conversations') ||
    path.startsWith('/api/datasets') ||
    path.startsWith('/api/files/') ||
    path.startsWith('/api/sessions') ||
    path.startsWith('/api/artifacts') ||
    path.startsWith('/api/approvals') ||
    path.startsWith('/api/runs') ||
    path.startsWith('/api/extensions') ||
    path.startsWith('/api/capabilities') ||
    path.startsWith('/api/a2a') ||
    path.startsWith('/api/processes')
  );
}
