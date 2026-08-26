/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * Prefer `createSandboxClient({ traceId, auth })` for request-scoped Agent turns.
 * Module-level helpers use ephemeral clients so concurrent requests never share
 * mutable trace state.
 *
 * Auth model:
 * - Always send service X-API-Key when configured.
 * - Forward browser `Authorization: Bearer <jwt>` so sandbox resolves the actor.
 * - Never trust browser-supplied X-Acting-* headers (stripped via authFromRequest).
 * - Server code may set acting headers after validating the user.
 *
 * Scope: this is the **owner-scoped public plane** only. The model's own tool
 * calls do not come through here — they go over the signed internal plane
 * (`sandbox-bridge-http-transport.js`), which is run-fenced and carries a
 * claimed ToolExecution. What is left here is what a server-side caller with no
 * fence token needs: workspace GC, managed-process control for the operator
 * surface, file and artifact access, and health.
 *
 * Every method here must correspond to a route Sandbox still serves. Sandbox
 * dropped its own session-creation, conversation, ad-hoc execution and approval
 * surfaces, and the methods for them lived on here for a while returning 404 on
 * first use; a few module-level wrappers were worse still, delegating to client
 * methods that did not exist. Check `/openapi.json` before adding one back.
 */
import { randomBytes } from 'node:crypto';
import { config, resolveSandboxAuthHeader } from '../../../config.js';
import { createTraceHeaders } from './trace-context.js';

const BASE = config.SANDBOX_BASE_URL;

/**
 * Path of one managed process under the session that owns it.
 * @param {string} sessionId
 * @param {string} processId
 */
function processPath(sessionId, processId) {
  return `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}`;
}

export class SandboxError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Extract sandbox-forwardable auth from an incoming HTTP request.
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
  }
  // Do NOT copy X-Acting-* from browser. Callers may set acting* only after server auth.
  return out;
}

/**
 * Create a request-scoped sandbox client.
 * @param {{
 *   traceId?: string|null,
 *   traceState?: string|null,
 *   auth?: {
 *     authorization?: string,
 *     actingUserId?: string,
 *     actingOrganizationId?: string,
 *     actingRole?: string,
 *   } | null,
 * }} [options]
 */
export function createSandboxClient({ traceId = null, traceState = null, auth = null } = {}) {
  let clientTraceId = traceId || null;
  const authCtx = auth || {};

  function newTraceId() {
    return randomBytes(16).toString('hex');
  }

  function setTraceId(id) {
    clientTraceId = id || null;
    return clientTraceId;
  }

  function getTraceId() {
    return clientTraceId;
  }

  function ensureTraceId(preferred) {
    if (preferred) {
      clientTraceId = preferred;
      return clientTraceId;
    }
    if (!clientTraceId) {
      clientTraceId = newTraceId();
    }
    return clientTraceId;
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
      ...safeExtra,
      // Service identity is resolved last and cannot be overridden by extras.
      ...resolveSandboxAuthHeader(),
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
    const tid = clientTraceId || extra['X-Trace-Id'];
    if (tid) {
      Object.assign(h, createTraceHeaders(String(tid).toLowerCase(), {
        traceState,
      }));
      if (!clientTraceId) clientTraceId = tid;
    } else {
      const generated = newTraceId();
      clientTraceId = generated;
      Object.assign(h, createTraceHeaders(generated, { traceState }));
    }
    return h;
  }

  async function sbFetch(path, opts = {}) {
    const url = `${BASE}${path}`;
    const {
      headers: extraHeaders,
      signal: externalSignal,
      timeoutMs = null,
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
        throw new SandboxError(resp.status, detail.detail || resp.statusText, path);
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

  return {
    setTraceId,
    getTraceId,
    ensureTraceId,

    // ── Session ─────────────────────────────────────
    /**
     * Remove a SandboxSession's physical workspace (idempotent GC).
     * Triggered by Agent conversation delete/archive (D2 triage: no
     * separate legal-hold requirement — Sandbox disk is deleted when its
     * owning conversation is deleted). A session that was never provisioned
     * or already removed is not an error — Sandbox reports `removed: false`.
     * @param {string} sessionId sandbox_session_id (AgentSession-bound)
     */
    async removeSessionWorkspace(sessionId) {
      const resp = await sbFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      return resp.json();
    },

    // ── Managed processes ───────────────────────────
    /**
     * Managed-process control for the operator surface.
     *
     * These are session-scoped (`/sessions/:sandboxSessionId/processes/...`),
     * not `/processes/...`: Sandbox has no tenant-free process surface, and the
     * `/internal/v1/processes/*` HMAC plane is for the model's claimed
     * ToolExecutions, which a browser-side call has no fence token for. The
     * caller passes the sandboxSessionId recorded on the process row.
     */
    async getProcessLogs(sessionId, processId, offset = 0, limit = null) {
      const q = new URLSearchParams({ offset: String(offset ?? 0) });
      if (limit != null) q.set('limit', String(limit));
      const resp = await sbFetch(
        `${processPath(sessionId, processId)}/logs?${q}`,
      );
      return resp.json();
    },

    /**
     * PR-08 process_read: incremental stream read by generation-offset cursor.
     * @param {string} sessionId
     * @param {string} processId
     * @param {{ stream?: 'stdout'|'stderr', cursor?: string, limit?: number }} [opts]
     */
    async readProcess(
      sessionId,
      processId,
      { stream = 'stdout', cursor = '0-0', limit = 8192 } = {},
    ) {
      const q = new URLSearchParams({
        stream: stream === 'stderr' ? 'stderr' : 'stdout',
        cursor: String(cursor ?? '0-0'),
        limit: String(limit ?? 8192),
      });
      const resp = await sbFetch(
        `${processPath(sessionId, processId)}/read?${q}`,
      );
      return resp.json();
    },

    async writeProcessStdin(sessionId, processId, data, eof = false) {
      const resp = await sbFetch(`${processPath(sessionId, processId)}/stdin`, {
        method: 'POST',
        body: JSON.stringify({ data, eof }),
      });
      return resp.json();
    },

    async signalProcess(sessionId, processId, signal = 'SIGTERM') {
      const resp = await sbFetch(`${processPath(sessionId, processId)}/signal`, {
        method: 'POST',
        body: JSON.stringify({ signal }),
      });
      return resp.json();
    },

    async cancelProcess(sessionId, processId) {
      const resp = await sbFetch(`${processPath(sessionId, processId)}/cancel`, {
        method: 'POST',
      });
      return resp.json();
    },

    // ── Files ───────────────────────────────────────
    async editFile(sessionId, body) {
      const resp = await sbFetch(`/sessions/${sessionId}/files/edit`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return resp.json();
    },

    async readFile(sessionId, path) {
      const q = new URLSearchParams({ path });
      const resp = await sbFetch(`/sessions/${sessionId}/files/read?${q}`);
      return resp.json();
    },

    async writeFile(sessionId, path, content) {
      const resp = await sbFetch(`/sessions/${sessionId}/files/write`, {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      });
      return resp.json();
    },

    async listFiles(sessionId, dir = '.') {
      const q = new URLSearchParams({ path: dir });
      const resp = await sbFetch(`/sessions/${sessionId}/files?${q}`);
      return resp.json();
    },

    /** Structured ls — POST /sessions/{id}/files/ls */
    async lsFiles(sessionId, body = {}) {
      const resp = await sbFetch(`/sessions/${sessionId}/files/ls`, {
        method: 'POST',
        body: JSON.stringify({
          path: body.path ?? '.',
          depth: body.depth ?? 1,
          include_hidden: Boolean(body.include_hidden),
        }),
      });
      return resp.json();
    },

    /** Structured find — POST /sessions/{id}/files/find */
    async findFiles(sessionId, body = {}) {
      const payload = {
        path: body.path ?? '.',
        pattern: body.pattern ?? '*',
      };
      if (body.type != null) payload.type = body.type;
      if (body.max_depth != null) payload.max_depth = body.max_depth;
      if (body.limit != null) payload.limit = body.limit;
      const resp = await sbFetch(`/sessions/${sessionId}/files/find`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return resp.json();
    },

    /** Structured grep — POST /sessions/{id}/files/grep */
    async grepFiles(sessionId, body = {}) {
      const payload = {
        path: body.path ?? '.',
        query: body.query,
        regex: Boolean(body.regex),
        case_sensitive: body.case_sensitive !== false,
      };
      if (body.glob != null) payload.glob = body.glob;
      if (body.context != null) payload.context = body.context;
      if (body.limit != null) payload.limit = body.limit;
      const resp = await sbFetch(`/sessions/${sessionId}/files/grep`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return resp.json();
    },

    async downloadFileStream(sessionId, path, options = {}) {
      return sbFetch(
        `/sessions/${sessionId}/files/download?path=${encodeURIComponent(path)}`,
        { signal: options.signal },
      );
    },

    async downloadDatasetContent(sessionId, datasetId, options = {}) {
      return sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/datasets/${encodeURIComponent(datasetId)}/content`,
        { signal: options.signal },
      );
    },

    // ── Artifacts (submit only — no metadata-only register) ──
    async submitArtifact(sessionId, name, path, mimeType) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts/submit`, {
        method: 'POST',
        body: JSON.stringify({
          name,
          path,
          mime_type: mimeType || 'application/octet-stream',
        }),
      });
      return resp.json();
    },

    async listArtifacts(sessionId) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts`);
      return resp.json();
    },

    artifactDownloadPath(sessionId, artifactId) {
      return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
    },

    async downloadArtifactStream(sessionId, artifactId, options = {}) {
      return sbFetch(this.artifactDownloadPath(sessionId, artifactId), {
        signal: options.signal,
      });
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
        const resp = await fetch(`${BASE}/health`, {
          headers: resolveSandboxAuthHeader(),
        });
        if (!resp.ok) return null;
        return resp.json();
      } catch {
        return null;
      }
    },
  };
}

// ── Module-level helpers (ephemeral client per call — no shared request state) ──

/** Generate or return a preferred trace id without mutating shared state. */
export function ensureTraceId(preferred) {
  return preferred || randomUUID();
}

export function artifactDownloadPath(sessionId, artifactId) {
  return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function removeSessionWorkspace(sessionId, auth = null) {
  return createSandboxClient({ auth }).removeSessionWorkspace(sessionId);
}

export async function authRegister(body) {
  return createSandboxClient().authRegister(body);
}

export async function authLogin(body) {
  return createSandboxClient().authLogin(body);
}

export async function authMe(auth = null) {
  return createSandboxClient({ auth }).authMe();
}

export async function readFile(sessionId, path) {
  return createSandboxClient().readFile(sessionId, path);
}

export async function writeFile(sessionId, path, content) {
  return createSandboxClient().writeFile(sessionId, path, content);
}

export async function listFiles(sessionId, dir = '.') {
  return createSandboxClient().listFiles(sessionId, dir);
}

export async function lsFiles(sessionId, body = {}) {
  return createSandboxClient().lsFiles(sessionId, body);
}

export async function findFiles(sessionId, body = {}) {
  return createSandboxClient().findFiles(sessionId, body);
}

export async function grepFiles(sessionId, body = {}) {
  return createSandboxClient().grepFiles(sessionId, body);
}

export async function downloadFileStream(sessionId, path) {
  return createSandboxClient().downloadFileStream(sessionId, path);
}

export async function submitArtifact(sessionId, name, path, mimeType) {
  return createSandboxClient().submitArtifact(sessionId, name, path, mimeType);
}

export async function listArtifacts(sessionId) {
  return createSandboxClient().listArtifacts(sessionId);
}

export async function downloadArtifactStream(sessionId, artifactId, options = {}) {
  return createSandboxClient().downloadArtifactStream(
    sessionId,
    artifactId,
    options,
  );
}

export async function checkHealth() {
  return createSandboxClient().checkHealth();
}
