/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * `createSandboxClient({ traceId, auth })` is the entry point — trace state is
 * per-client, so a request-scoped client is what keeps concurrent Agent turns
 * from sharing it. The one module-level export left is the `/health` probe.
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

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

const BASE = config.SANDBOX_BASE_URL;

/**
 * AGENTS.md §2: every outbound call is bounded. A hung Sandbox must not pin a
 * conversation-delete GC, an operator process call or a health probe forever.
 *
 * `DEFAULT_SANDBOX_TIMEOUT_MS` bounds the whole request/response for the
 * control-plane calls. Byte-streaming responses (`streaming: true`) bound only
 * time-to-headers — the deadline is cleared once headers land so a large
 * download is not aborted mid-body.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000;
const DEFAULT_SANDBOX_STREAM_HEADERS_TIMEOUT_MS = 60_000;
const SANDBOX_HEALTH_TIMEOUT_MS = 3_000;

/**
 * Path of one managed process under the session that owns it.
 * @param sessionId
 * @param processId
 */
function processPath(sessionId: string, processId: string) {
  return `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}`;
}

export class SandboxError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  status: Loose;
  path: Loose;

  constructor(status, message, path) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
  }
}

/**
 * 转发给 exec 的调用者身份。
 *
 * `authorization` 只从**服务端已认证**的请求上取；X-Acting-* 一律不从浏览器
 * 复制，由服务端在认证后自行设置。
 */
/**
 * 发往 exec 的 JSON 请求体。**刻意不逐路由收窄**：每条路由的字段由 exec 侧
 * 的契约定义并校验，在客户端再抄一份形状只会多一处会漂移的声明。
 */
export type SandboxRequestBody = Record<string, any>;

export interface SandboxAuth {
  authorization?: string;
  actingUserId?: string;
  actingOrganizationId?: string;
  actingRole?: string;
}

/**
 * Extract sandbox-forwardable auth from an incoming HTTP request.
 * Strips client X-Acting-* (untrusted from browser).
 */
export function authFromRequest(
  req: import('node:http').IncomingMessage | null | undefined,
): SandboxAuth {
  if (!req || !req.headers) return {};
  // 逐条按条件填，字面量推断带不上没写出来的字段。
  const out: SandboxAuth = {};
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

    const h = (({
      'Content-Type': 'application/json',
      ...safeExtra,
      // Service identity is resolved last and cannot be overridden by extras.
      ...resolveSandboxAuthHeader(),
    }) as Record<string, string>);
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

  async function sbFetch(
    path: string,
    opts: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      streaming?: boolean;
      timeoutMs?: number;
      [key: string]: unknown;
    } = {},
  ) {
    const url = `${BASE}${path}`;
    const {
      headers: extraHeaders,
      signal: externalSignal,
      streaming = false,
      timeoutMs = streaming
        ? DEFAULT_SANDBOX_STREAM_HEADERS_TIMEOUT_MS
        : DEFAULT_SANDBOX_TIMEOUT_MS,
      ...rest
    } = opts;
    const controller = new AbortController();
    let timer = timeoutMs == null
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
      if (streaming && timer !== null) {
        // Deadline covered time-to-headers; the body is consumed by the caller.
        clearTimeout(timer);
        timer = null;
      }
      if (!resp.ok) {
        const detail = (await resp
          .json()
          .catch(() => ({ detail: resp.statusText }))) as { detail?: string };
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
     * @param sessionId sandbox_session_id (AgentSession-bound)
     */
    async removeSessionWorkspace(sessionId: string) {
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
    async lsFiles(sessionId: string, body: SandboxRequestBody = {}) {
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
    async findFiles(sessionId: string, body: SandboxRequestBody = {}) {
      // type / max_depth / limit 按需追加，字面量推断带不上。
      const payload: Record<string, unknown> = {
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
    async grepFiles(sessionId: string, body: SandboxRequestBody = {}) {
      const payload: Record<string, unknown> = {
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

    async downloadFileStream(sessionId, path, options: { signal?: AbortSignal } = {}) {
      return sbFetch(
        `/sessions/${sessionId}/files/download?path=${encodeURIComponent(path)}`,
        { signal: options.signal, streaming: true },
      );
    },

    async downloadDatasetContent(sessionId, datasetId, options: { signal?: AbortSignal } = {}) {
      return sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/datasets/${encodeURIComponent(datasetId)}/content`,
        { signal: options.signal, streaming: true },
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

    async downloadArtifactStream(sessionId, artifactId, options: { signal?: AbortSignal } = {}) {
      return sbFetch(this.artifactDownloadPath(sessionId, artifactId), {
        signal: options.signal,
        streaming: true,
      });
    },

    // ── Health ──────────────────────────────────────
    async checkHealth() {
      try {
        const resp = await fetch(`${BASE}/health`, {
          headers: resolveSandboxAuthHeader(),
          signal: AbortSignal.timeout(SANDBOX_HEALTH_TIMEOUT_MS),
        });
        if (!resp.ok) return null;
        return resp.json();
      } catch {
        return null;
      }
    },
  };
}

// ── Module-level helpers ─────────────────────────────────────────────────
// Only the /health probe still has a module-level caller (`http-main.js`
// imports it dynamically). Everything else goes through `createSandboxClient`
// so trace state stays request-scoped; the old per-route wrappers pointed at
// retired Sandbox routes and are gone. Do not add one back without a caller.

/**
 * Sandbox `/health` 探针。返回 null 表示不可达（超时/非 2xx/网络错误都归一到
 * null），而不是抛错——调用方是 `/ready`，它只需要"健不健康"。
 *
 * @returns {Promise<{ status?: string } | null>}
 */
export async function checkHealth() {
  return createSandboxClient().checkHealth();
}
