/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * Prefer `createSandboxClient({ traceId, traceContext, auth })` for request-scoped usage.
 * Module-level helpers use ephemeral clients so concurrent requests never share
 * mutable trace state.
 */
import type { IncomingMessage } from 'node:http';
import { config, AUTH_HEADER } from '../config.js';
import { readCookie } from '../http/cookies.js';
import {
  boundRequestTraceContext,
  createTraceId,
  normalizeTracestate,
  resolveRequestTraceContext,
  traceCarrierHeaders,
  type RequestTraceContext,
} from '../application/trace-context.js';

const BASE = config.SANDBOX_BASE_URL;

/** Readiness probe deadline — matches the Agent-client probe in agent-client.js. */
const SANDBOX_HEALTH_TIMEOUT_MS = 3_000;

function createClientTraceContext(traceId: string, traceState?: string | null): RequestTraceContext {
  const context = resolveRequestTraceContext({
    'X-Trace-Id': String(traceId),
  });
  return Object.freeze({
    ...context,
    tracestate: normalizeTracestate(traceState),
  });
}

export class SandboxError extends Error {
  status: number;
  path: string;
  code: string | null;
  detail: any;

  constructor(
    status: number,
    message: string,
    path: string,
    { code = null, detail = null }: { code?: string | null; detail?: any } = {},
  ) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
    this.code = code;
    this.detail = detail;
  }
}

export interface SandboxAuthContext {
  authorization?: string;
  actingUserId?: string;
  actingOrganizationId?: string;
  actingRole?: string;
  requestId?: string | null;
  [key: string]: unknown;
}

/**
 * Extract sandbox-forwardable auth from an incoming HTTP request.
 * Browser sessions use the BFF HttpOnly cookie; API clients may use Bearer.
 * Strips client X-Acting-* (untrusted from browser).
 */
export function authFromRequest(req: IncomingMessage | { headers?: Record<string, string | string[] | undefined> } | null | undefined): SandboxAuthContext {
  if (!req || !req.headers) return {};
  const out: SandboxAuthContext = {};
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (typeof authStr === 'string' && authStr.toLowerCase().startsWith('bearer ')) {
    out.authorization = authStr;
  } else {
    const sessionToken = readCookie(req as IncomingMessage);
    if (sessionToken) out.authorization = `Bearer ${sessionToken}`;
  }
  // Do NOT copy X-Acting-* from browser. Callers may set acting* only after server auth.
  return out;
}

export interface SandboxClientOptions {
  traceId?: string | null;
  traceState?: string | null;
  traceContext?: RequestTraceContext | null;
  auth?: SandboxAuthContext | null;
}

export interface SandboxClient {
  listArtifacts(sessionId: string): Promise<any>;
  importArtifact(sessionId: string, artifactId: string, targetFilename?: string | null): Promise<any>;
  listProcesses(sessionId: string, query?: Record<string, any>): Promise<any>;
  getProcess(sessionId: string, processId: string): Promise<any>;
  getProcessLogs(sessionId: string, processId: string, query?: Record<string, any>): Promise<any>;
  readProcess(sessionId: string, processId: string, query?: Record<string, any>): Promise<any>;
  processAction(sessionId: string, processId: string, action: string, body?: Record<string, any>): Promise<any>;
  checkHealth(): Promise<any>;
}

/**
 * Create a request-scoped sandbox client.
 */
export function createSandboxClient({
  traceId = null,
  traceState = null,
  traceContext = null,
  auth = null,
}: SandboxClientOptions = {}): SandboxClient {
  let clientTraceId = traceId || null;
  const authCtx = auth || {};
  let clientTraceContext: RequestTraceContext | null =
    traceContext || boundRequestTraceContext(authCtx) || null;
  if (!clientTraceContext && traceId) {
    clientTraceContext = createClientTraceContext(traceId, traceState);
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    // Drop any client-supplied acting headers from extra (defense in depth)
    const safeExtra = { ...extra };
    delete safeExtra['X-Acting-User-Id'];
    delete safeExtra['X-Acting-Organization-Id'];
    delete safeExtra['X-Acting-Role'];
    delete safeExtra['x-acting-user-id'];
    delete safeExtra['x-acting-organization-id'];
    delete safeExtra['x-acting-role'];

    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...AUTH_HEADER,
      ...safeExtra,
    };
    if (authCtx.authorization) {
      h['Authorization'] = authCtx.authorization;
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

  async function sbFetch(path: string, opts: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const url = `${BASE}${path}`;
    const {
      headers: extraHeaders,
      signal: externalSignal,
      timeoutMs,
      ...rest
    } = opts;
    const deadlineMs =
      Number.isFinite(timeoutMs) && (timeoutMs as number) > 0
        ? (timeoutMs as number)
        : config.SANDBOX_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    const onAbort = () => controller.abort();
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(url, {
        ...rest,
        signal: controller.signal,
        headers: headers((extraHeaders || {}) as Record<string, string>),
      });
      if (!resp.ok) {
        const detail = (await resp.json().catch(() => ({ detail: resp.statusText }))) as any;
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
    } catch (err: any) {
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new Error(`Sandbox request timed out after ${deadlineMs}ms: ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    async listArtifacts(sessionId: string) {
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts`);
      return resp.json();
    },

    async importArtifact(sessionId: string, artifactId: string, targetFilename: string | null = null) {
      const payload: Record<string, string> = { artifact_id: artifactId };
      if (targetFilename) payload['target_filename'] = targetFilename;
      const resp = await sbFetch(`/sessions/${sessionId}/artifacts/imports`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      return resp.json();
    },

    async listProcesses(sessionId: string, query: Record<string, any> = {}) {
      const params = new URLSearchParams();
      if (query['runId']) params.set('run_id', query['runId']);
      if (query['status']) params.set('status', query['status']);
      if (query['limit']) params.set('limit', query['limit']);
      const qs = params.toString();
      const resp = await sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/processes${qs ? `?${qs}` : ''}`,
      );
      return resp.json();
    },

    async getProcess(sessionId: string, processId: string) {
      const resp = await sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}`,
      );
      return resp.json();
    },

    async getProcessLogs(sessionId: string, processId: string, query: Record<string, any> = {}) {
      const params = new URLSearchParams();
      if (query['offset'] != null) params.set('offset', query['offset']);
      if (query['limit'] != null) params.set('limit', query['limit']);
      const qs = params.toString();
      const resp = await sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/logs${qs ? `?${qs}` : ''}`,
      );
      return resp.json();
    },

    async readProcess(sessionId: string, processId: string, query: Record<string, any> = {}) {
      const params = new URLSearchParams();
      if (query['stream']) params.set('stream', query['stream']);
      if (query['cursor']) params.set('cursor', query['cursor']);
      if (query['limit']) params.set('limit', query['limit']);
      const qs = params.toString();
      const resp = await sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/read${qs ? `?${qs}` : ''}`,
      );
      return resp.json();
    },

    async processAction(sessionId: string, processId: string, action: string, body: Record<string, any> = {}) {
      const resp = await sbFetch(
        `/sessions/${encodeURIComponent(sessionId)}/processes/${encodeURIComponent(processId)}/${action}`,
        { method: 'POST', body: JSON.stringify(body) },
      );
      return resp.json();
    },

    async checkHealth() {
      try {
        const resp = await fetch(`${BASE}/health`, {
          headers: AUTH_HEADER,
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

export function artifactDownloadPath(sessionId: string, artifactId: string): string {
  return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function checkHealth(): Promise<any> {
  return createSandboxClient().checkHealth();
}

