/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * Prefer `createSandboxClient({ traceId, traceContext, auth })` for request-scoped usage.
 * Module-level helpers use ephemeral clients so concurrent requests never share
 * mutable trace state.
 *
 * Auth model:
 * - Always send service X-API-Key when configured.
 * - Forward browser `Authorization: Bearer <jwt>` so sandbox resolves the actor.
 * - Never trust browser-supplied X-Acting-* headers (stripped via authFromRequest).
 * - Server code may set acting headers after validating the user.
 */
import { config, AUTH_HEADER } from '../config.js';
import { readCookie } from '../http/cookies.js';
import {
  boundRequestTraceContext,
  createTraceId,
  normalizeTracestate,
  resolveRequestTraceContext,
  traceCarrierHeaders,
} from '../application/trace-context.js';

const BASE = config.SANDBOX_BASE_URL;
const REQUEST_GRACE_MS = 5_000;

function createClientTraceContext(traceId, traceState) {
  const context = resolveRequestTraceContext({
    'X-Trace-Id': String(traceId),
  });
  return Object.freeze({
    ...context,
    tracestate: normalizeTracestate(traceState),
  });
}

export class SandboxError extends Error {
  constructor(status, message, path, { code = null, detail = null } = {}) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Extract sandbox-forwardable auth from an incoming HTTP request.
 * Browser sessions use the BFF HttpOnly cookie; API clients may use Bearer.
 * Strips client X-Acting-* (untrusted from browser).
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @returns {{ authorization?: string, actingUserId?: string, actingOrganizationId?: string, actingRole?: string }}
 */
export function authFromRequest(req) {
  if (!req || !req.headers) return {};
  const out = {};
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    out.authorization = auth;
  } else {
    const sessionToken = readCookie(req);
    if (sessionToken) out.authorization = `Bearer ${sessionToken}`;
  }
  // Do NOT copy X-Acting-* from browser. Callers may set acting* only after server auth.
  return out;
}

/**
 * Create a request-scoped sandbox client.
 * @param {{
 *   traceId?: string|null,
 *   traceState?: string|null,
 *   traceContext?: object|null,
 *   auth?: {
 *     authorization?: string,
 *     actingUserId?: string,
 *     actingOrganizationId?: string,
 *     actingRole?: string,
 *   } | null,
 * }} [options]
 */
export function createSandboxClient({
  traceId = null,
  traceState = null,
  traceContext = null,
  auth = null,
} = {}) {
  let clientTraceId = traceId || null;
  const authCtx = auth || {};
  let clientTraceContext =
    traceContext || boundRequestTraceContext(authCtx) || null;
  if (!clientTraceContext && traceId) {
    clientTraceContext = createClientTraceContext(traceId, traceState);
  }

  function headers(extra = {}) {
    // Drop any client-supplied acting headers from extra (defense in depth)
    const safeExtra = { ...extra };
    delete safeExtra['X-Acting-User-Id'];
    delete safeExtra['X-Acting-Organization-Id'];
    delete safeExtra['X-Acting-Role'];
    delete safeExtra['x-acting-user-id'];
    delete safeExtra['x-acting-organization-id'];
    delete safeExtra['x-acting-role'];

    const h = {
      'Content-Type': 'application/json',
      ...AUTH_HEADER,
      ...safeExtra,
    };
    if (authCtx.authorization) {
      h.Authorization = authCtx.authorization;
    }
    // Only server-provided acting context (never from browser extra)
    if (authCtx.actingUserId && authCtx.actingOrganizationId) {
      h['X-Acting-User-Id'] = authCtx.actingUserId;
      h['X-Acting-Organization-Id'] = authCtx.actingOrganizationId;
      if (authCtx.actingRole) h['X-Acting-Role'] = authCtx.actingRole;
    }
    if (authCtx.requestId) h['X-Request-Id'] = String(authCtx.requestId);
    const tid =
      clientTraceContext?.traceId || clientTraceId || extra['X-Trace-Id'];
    if (tid) {
      h['X-Trace-Id'] = tid;
      if (!clientTraceId) clientTraceId = tid;
      if (clientTraceContext?.traceId) {
        Object.assign(h, traceCarrierHeaders(clientTraceContext));
      }
    } else {
      const generated = createTraceId();
      clientTraceId = generated;
      clientTraceContext = createClientTraceContext(generated, traceState);
      Object.assign(h, traceCarrierHeaders(clientTraceContext));
    }
    return h;
  }

  async function sbFetch(path, opts = {}) {
    const url = `${BASE}${path}`;
    const {
      headers: extraHeaders,
      signal: externalSignal,
      // A per-call value (long executions pass their own); otherwise the
      // configured default. `null` used to mean "wait forever", and every
      // caller took that default — a Sandbox that stopped answering held BFF
      // requests open until the client gave up.
      timeoutMs = config.SANDBOX_REQUEST_TIMEOUT_MS,
      ...rest
    } = opts;
    const controller = new AbortController();
    const timer = timeoutMs == null
      ? null
      : setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: headers(extraHeaders || {}),
      });
      if (!resp.ok) {
        const detail = await resp.json().catch(() => ({ detail: resp.statusText }));
        const raw = detail?.detail ?? detail?.error ?? resp.statusText;
        const message =
          typeof raw === 'string'
            ? raw
            : typeof raw?.message === 'string'
              ? raw.message
              : resp.statusText;
        const code =
          (raw && typeof raw === 'object' && typeof raw.code === 'string'
            ? raw.code
            : null) ||
          (typeof detail?.code === 'string' ? detail.code : null);
        throw new SandboxError(resp.status, message, path, { code, detail });
      }
      return resp;
    } catch (err) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new Error(`Sandbox request timed out after ${timeoutMs}ms: ${path}`);
      }
      throw err;
    } finally {
      if (timer !== null) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  const timeoutForSeconds = (seconds) => {
    const value = Number(seconds);
    return Number.isFinite(value) && value >= 0
      ? value * 1000 + REQUEST_GRACE_MS
      : null;
  };

  return {
    // PR-13 severe: Sandbox does not expose /agent-runs, /agent-sessions, or
    // /tool-executions. Run/tool ledger authority is Agent MySQL.

    async listArtifacts(sessionId) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts`);
      return resp.json();
    },

    async importArtifact(sessionId, artifactId, targetFilename = null) {
      const payload = { artifact_id: artifactId };
      if (targetFilename) payload.target_filename = targetFilename;
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts/imports`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return resp.json();
    },

    // ── Auth proxy ──────────────────────────────────
    async authRegister(body) {
      const resp = await sbFetch('/auth/register', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return resp.json();
    },

    async authLogin(body) {
      const resp = await sbFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return resp.json();
    },

    async authMe() {
      const resp = await sbFetch('/auth/me', { method: 'GET' });
      return resp.json();
    },

    // ── Health ──────────────────────────────────────
    async checkHealth() {
      try {
        const resp = await fetch(`${BASE}/health`, { headers: AUTH_HEADER });
        if (!resp.ok) return null;
        return resp.json();
      } catch {
        return null;
      }
    },
  };
}

// ── Module-level helpers (ephemeral client per call — no shared request state) ──

export function artifactDownloadPath(sessionId, artifactId) {
  return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function authRegister(body, options = {}) {
  return createSandboxClient(options).authRegister(body);
}

export async function authLogin(body, options = {}) {
  return createSandboxClient(options).authLogin(body);
}

export async function authMe(auth = null, options = {}) {
  return createSandboxClient({ ...options, auth }).authMe();
}

export async function checkHealth() {
  return createSandboxClient().checkHealth();
}
