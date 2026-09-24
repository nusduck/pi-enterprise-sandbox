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

export interface DevelopmentActingIdentity {
  actingUserId: string;
  actingOrganizationId: string;
  actingRole: 'admin' | 'user';
}

/**
 * Whether BFF should require browser Authorization on user-facing routes.
 * Aligns with SANDBOX_AUTH_ENABLED when AUTH_ENABLED is unset.
 */
export function resolveAuthEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
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
 */
export function resolveDatasetUploadMaxBytes(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): number {
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
 */
export function resolveDevelopmentActingIdentity(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Readonly<DevelopmentActingIdentity> {
  const requestedRole = String(env.BFF_DEV_ACTING_ROLE || 'user')
    .trim()
    .toLowerCase();
  // Development-only convenience for exercising the A2A admin surface. The
  // authenticated production path resolves role from Sandbox instead.
  const actingRole: 'admin' | 'user' = requestedRole === 'admin' ? 'admin' : 'user';
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
} as const);

export type ApprovalMode = typeof APPROVAL_MODES[keyof typeof APPROVAL_MODES];

function nonEmptyEnv(
  env: NodeJS.ProcessEnv | Record<string, unknown>,
  key: string,
): string | null {
  const value = env?.[key];
  return value != null && String(value).trim() !== '' ? String(value).trim() : null;
}

function parseLegacyApprovalEnabled(value: unknown): boolean {
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
 */
export function resolveApprovalMode(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): string {
  const explicit = nonEmptyEnv(env, 'APPROVAL_MODE') || nonEmptyEnv(env, 'SANDBOX_APPROVAL_MODE');
  if (explicit) {
    const mode = explicit.toLowerCase().replaceAll('-', '_');
    if ((Object.values(APPROVAL_MODES) as readonly string[]).includes(mode)) return mode;
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

export function resolveApprovalEnabled(
  env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): boolean {
  return resolveApprovalMode(env) !== APPROVAL_MODES.DENY;
}

export function resolveDeploymentEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): 'development' | 'production' {
  const raw = String(env.DEPLOYMENT_ENV || env.NODE_ENV || 'development')
    .trim()
    .toLowerCase();
  if (raw === 'production' || raw === 'prod') return 'production';
  return 'development';
}

export function isWeakSecret(value: string | undefined | null): boolean {
  const text = String(value || '').trim();
  if (text.length < MIN_SECRET_LEN) return true;
  const lower = text.toLowerCase();
  return WEAK_SECRET_MARKERS.some((m) => lower.includes(m));
}

export class ProductionConfigError extends Error {
  errors: string[];
  constructor(message: string, errors: string[]) {
    super(message);
    this.name = 'ProductionConfigError';
    this.errors = errors;
  }
}

/**
 * Production fail-fast for BFF. Call before listen.
 */
export function validateProductionConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): void {
  if (resolveDeploymentEnv(env) !== 'production') return;

  const errors: string[] = [];
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
    throw new ProductionConfigError(
      `Production configuration is unsafe (${errors.length} issue(s)): ${errors.join('; ')}`,
      errors,
    );
  }
}

/**
 * Redacted effective config for INFO logs.
 */
export function effectiveConfig(cfg: typeof config = config): Record<string, unknown> {
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

/** Bounded positive-integer millisecond setting with a documented default. */
export function resolveTimeoutMs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = String(env[key] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export const config = {
  PORT: parseInt(process.env.PORT || '4000', 10) || 4000,
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
  /**
   * Deadline for a single BFF → Agent / Sandbox request.
   */
  AGENT_REQUEST_TIMEOUT_MS: resolveTimeoutMs(
    process.env,
    'AGENT_REQUEST_TIMEOUT_MS',
    15_000,
  ),
  SANDBOX_REQUEST_TIMEOUT_MS: resolveTimeoutMs(
    process.env,
    'SANDBOX_REQUEST_TIMEOUT_MS',
    15_000,
  ),
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
   */
  APPROVAL_MODE: resolveApprovalMode(),
  APPROVAL_ENABLED: resolveApprovalEnabled(),
  JSON_BODY_LIMIT_BYTES:
    parseInt(process.env.JSON_BODY_LIMIT_BYTES || '1048576', 10) || 1024 * 1024,
  DATASET_UPLOAD_MAX_BYTES: resolveDatasetUploadMaxBytes(),
  CORS_ALLOWED_ORIGINS: String(process.env.CORS_ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
};

export const AUTH_HEADER: Record<string, string> = config.SANDBOX_API_TOKEN
  ? { 'X-API-Key': config.SANDBOX_API_TOKEN }
  : {};

/**
 * Paths that remain public when AUTH_ENABLED (health probes + auth proxy).
 */
export function isPublicApiPath(path: string): boolean {
  if (path === '/health/live' || path === '/health/ready') return true;
  if (path.startsWith('/api/auth/')) return true;
  return false;
}

/**
 * Whether *path* requires browser Authorization when AUTH_ENABLED.
 */
export function isProtectedApiPath(path: string): boolean {
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
    path.startsWith('/api/cron-jobs') ||
    path.startsWith('/api/agents') ||
    path.startsWith('/api/extensions') ||
    path.startsWith('/api/capabilities') ||
    path.startsWith('/api/a2a') ||
    path.startsWith('/api/processes')
  );
}

