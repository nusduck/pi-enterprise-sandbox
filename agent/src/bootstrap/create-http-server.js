/**
 * Agent HTTP server factory (PR-04 T4).
 *
 * No listen/exit on import. Production entry injects Create/Get/Cancel services.
 * Does **not** import the legacy process-local Run manager module.
 *
 * Endpoints (compatible paths):
 *   POST/GET /internal/agent-runs
 *   POST/GET /internal/conversations
 *   GET/DELETE /internal/conversations/:id
 *   POST /internal/sessions/ensure
 *   GET  /internal/agent-runs/:id
 *   GET  /internal/agent-runs/:id/events  (MySQL history + Redis live SSE, PR-10)
 *   POST /internal/agent-runs/:id/cancel
 *   durable steer and conversation-scoped follow-up
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  OwnerScopedNotFoundError,
  IdempotencyInProgressError,
  IdempotencyConflictError,
  ValidationError,
  CanonicalJsonError,
  ParentProvisioningRaceError,
} from '../application/errors.js';


/**
 * Strict W3C traceparent parse.
 * version ≠ ff, 32-hex non-zero trace, 16-hex non-zero span, 2-hex flags.
 * @param {unknown} value
 * @returns {{ traceId: string, parentSpanId: string, traceFlags: string } | null}
 */
export function parseTraceparentContext(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.trim().split('-');
  if (parts.length !== 4) return null;
  const [ver, tid, sid, flags] = parts;
  if (!/^[0-9a-fA-F]{2}$/.test(ver) || ver.toLowerCase() === 'ff') return null;
  if (!/^[0-9a-fA-F]{32}$/.test(tid) || tid.toLowerCase() === '0'.repeat(32)) {
    return null;
  }
  if (!/^[0-9a-fA-F]{16}$/.test(sid) || sid.toLowerCase() === '0'.repeat(16)) {
    return null;
  }
  if (!/^[0-9a-fA-F]{2}$/.test(flags)) return null;
  return {
    traceId: tid.toLowerCase(),
    parentSpanId: sid.toLowerCase(),
    traceFlags: flags.toLowerCase(),
  };
}

/** Keep the vendor list opaque while rejecting header injection and malformed members. */
export function parseTracestate(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 512 || /[^\x20-\x7e]/.test(raw)) return null;
  const members = raw.split(',');
  if (members.length > 32) return null;
  const keys = new Set();
  for (const part of members) {
    const member = part.trim();
    const eq = member.indexOf('=');
    const key = eq > 0 ? member.slice(0, eq) : '';
    const valuePart = eq > 0 ? member.slice(eq + 1) : '';
    if (
      !/^[a-z][a-z0-9_*/-]{0,255}$/.test(key) ||
      !valuePart ||
      valuePart.length > 256 ||
      /[,=]/.test(valuePart) ||
      valuePart.startsWith(' ') ||
      valuePart.endsWith(' ') ||
      keys.has(key)
    ) return null;
    keys.add(key);
  }
  return members.map((part) => part.trim()).join(',');
}

/**
 * Backward-compatible trace-id-only parser.
 * @param {unknown} value
 * @returns {string | null}
 */
export function parseTraceparent(value) {
  return parseTraceparentContext(value)?.traceId ?? null;
}

/**
 * Parse the incoming W3C parent context. X-Trace-Id/body fallback carries no
 * parent span because it is only a trace correlation compatibility field.
 * @param {import('node:http').IncomingMessage} req
 * @param {unknown} [bodyTrace]
 * @returns {{ traceId: string, parentSpanId: string | null, traceFlags: string | null, traceState: string | null }}
 */
export function resolveRequestTraceContext(req, bodyTrace) {
  const headers = req.headers || {};
  const fromTp = parseTraceparentContext(
    headers.traceparent || headers.Traceparent,
  );
  if (fromTp) {
    return {
      ...fromTp,
      ...(parseTracestate(
        headers.tracestate || headers.Tracestate || headers.TraceState,
      )
        ? {
            traceState: parseTracestate(
              headers.tracestate || headers.Tracestate || headers.TraceState,
            ),
          }
        : {}),
    };
  }

  const xt =
    headers['x-trace-id'] ||
    headers['X-Trace-Id'] ||
    (typeof bodyTrace === 'string' ? bodyTrace : null);
  if (typeof xt === 'string' && /^[0-9a-fA-F]{32}$/.test(xt.trim())) {
    const id = xt.trim().toLowerCase();
    if (id !== '0'.repeat(32)) {
      return {
        traceId: id,
        parentSpanId: null,
        traceFlags: null,
      };
    }
  }
  // Reject legacy trace_* / UUID shapes — mint a fresh W3C id.
  return {
    traceId: randomBytes(16).toString('hex'),
    parentSpanId: null,
    traceFlags: null,
  };
}

/**
 * Parse W3C traceparent / X-Trace-Id into a trace id for legacy callers.
 * @param {import('node:http').IncomingMessage} req
 * @param {unknown} [bodyTrace]
 * @returns {string}
 */
export function resolveRequestTraceId(req, bodyTrace) {
  return resolveRequestTraceContext(req, bodyTrace).traceId;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ provider: string, externalOrgId: string, externalUserId: string, role?: string|null, displayName?: string|null } | null}
 */
export function authSubjectsFromRequest(req) {
  const uid = req.headers['x-acting-user-id'];
  const oid = req.headers['x-acting-organization-id'];
  if (typeof uid !== 'string' || !uid.trim()) return null;
  if (typeof oid !== 'string' || !oid.trim()) return null;
  return {
    provider: 'bff',
    externalOrgId: oid.trim(),
    externalUserId: uid.trim(),
    requestId: req?.requestId || null,
    callerType: 'web',
    role:
      typeof req.headers['x-acting-role'] === 'string'
        ? req.headers['x-acting-role'].trim()
        : null,
  };
}

/** Resolve a bounded request id for internal correlation. */
export function resolveRequestId(req) {
  const incoming = String(
    req?.headers?.['x-request-id'] || req?.headers?.['X-Request-Id'] || '',
  ).trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(incoming)
    ? incoming
    : randomBytes(16).toString('hex');
}

/**
 * @param {import('node:http').IncomingMessage} req
 */
export function readIdempotencyKey(req) {
  const h =
    req.headers['idempotency-key'] ||
    req.headers['Idempotency-Key'] ||
    req.headers['x-idempotency-key'] ||
    req.headers['X-Idempotency-Key'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  return null;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
export function json(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Map application errors to HTTP without leaking DSN/secrets.
 * @param {unknown} err
 * @returns {{ status: number, body: object }}
 */
export function mapErrorToHttp(err) {
  if (err instanceof ValidationError || err instanceof CanonicalJsonError) {
    return { status: 400, body: { error: err.message, code: err.code } };
  }
  if (err instanceof OwnerScopedNotFoundError) {
    const resource = err.details?.resource;
    const noun =
      resource === 'conversations'
        ? 'Conversation'
        : resource === 'approvals'
          ? 'Approval'
        : resource === 'process_executions'
          ? 'Process'
        : resource === 'trace_spans'
          ? 'Trace'
        : resource === 'interactions'
          ? 'Interaction'
          : 'Run';
    return { status: 404, body: { error: `${noun} not found`, code: 'NOT_FOUND' } };
  }
  if (err instanceof IdempotencyInProgressError) {
    return {
      status: 409,
      body: { error: err.message, code: err.code, retryable: true },
    };
  }
  if (err instanceof IdempotencyConflictError) {
    return { status: 409, body: { error: err.message, code: err.code } };
  }
  if (err instanceof ParentProvisioningRaceError) {
    return {
      status: 409,
      body: { error: 'Conflict; retry', code: err.code, retryable: true },
    };
  }
  const code = /** @type {{ code?: string, name?: string }} */ (err)?.code;
  const name = /** @type {{ name?: string }} */ (err)?.name;
  if (code === 'INTERACTION_RESPONSE_INVALID') {
    return {
      status: 400,
      body: { error: 'Invalid interaction response', code },
    };
  }
  // Repository / infra typed errors (safe messages only).
  if (code === 'NOT_FOUND' || name === 'NotFoundError') {
    return { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
  }
  if (code === 'CONFLICT' || name === 'ConflictError') {
    return { status: 409, body: { error: 'Conflict', code: 'CONFLICT' } };
  }
  if (
    code === 'MYSQL_CONFIG_ERROR' ||
    code === 'REDIS_CONFIG_ERROR' ||
    name === 'MysqlConfigError' ||
    name === 'RedisConfigError'
  ) {
    return {
      status: 503,
      body: { error: 'Service configuration unavailable', code: 'CONFIG' },
    };
  }
  if (
    code === 'MYSQL_DEPENDENCY_ERROR' ||
    code === 'REDIS_DEPENDENCY_ERROR' ||
    code === 'SANDBOX_SESSION_PROVISION_FAILED' ||
    name === 'MysqlDependencyError' ||
    name === 'RedisDependencyError'
  ) {
    return {
      status: 503,
      body: { error: 'Service dependency unavailable', code: 'DEPENDENCY' },
    };
  }
  return { status: 500, body: { error: 'Internal server error' } };
}

/**
 * Dual-key public create/get DTO (camelCase plan + legacy snake_case).
 * @param {object} result
 */
export function presentCreateRunResponse(result) {
  return {
    runId: result.runId,
    run_id: result.runId,
    status: result.status,
    conversationId: result.conversationId,
    conversation_id: result.conversationId,
    eventsUrl: result.eventsUrl,
    events_url: result.eventsUrl,
    agentSessionId: result.agentSessionId ?? null,
    agent_session_id: result.agentSessionId ?? null,
    queueWarning: result.queueWarning ?? null,
    queue_warning: result.queueWarning ?? null,
    replayed: result.replayed === true,
  };
}

/**
 * @param {object} run — domain run row
 */
export function presentGetRunResponse(run) {
  const pending = run.pendingInput || run.pending_input || null;
  const pendingInput = pending
    ? {
        interactionId: pending.interactionId || pending.interaction_id || null,
        interaction_id: pending.interactionId || pending.interaction_id || null,
        interactionType:
          pending.interactionType || pending.interaction_type || 'input',
        interaction_type:
          pending.interactionType || pending.interaction_type || 'input',
        title: pending.title ?? 'Input required',
        message: pending.message ?? null,
        options: Array.isArray(pending.options) ? pending.options : [],
        status: pending.status || 'PENDING',
      }
    : null;
  return {
    runId: run.runId,
    run_id: run.runId,
    status: run.status,
    conversationId: run.conversationId,
    conversation_id: run.conversationId,
    agentSessionId: run.agentSessionId,
    agent_session_id: run.agentSessionId,
    orgId: run.orgId,
    org_id: run.orgId,
    userId: run.userId,
    user_id: run.userId,
    traceId: run.traceId,
    trace_id: run.traceId,
    attempt: run.attempt,
    statusReason: run.statusReason,
    status_reason: run.statusReason,
    cancelRequestedAt: run.cancelRequestedAt,
    cancel_requested_at: run.cancelRequestedAt,
    createdAt: run.createdAt,
    created_at: run.createdAt,
    updatedAt: run.updatedAt,
    updated_at: run.updatedAt,
    startedAt: run.startedAt,
    started_at: run.startedAt,
    completedAt: run.completedAt,
    completed_at: run.completedAt,
    pendingInput,
    pending_input: pendingInput,
  };
}

const PUBLIC_TOOL_STATUS = Object.freeze({
  PROPOSED: 'prepared',
  WAITING_APPROVAL: 'waiting_approval',
  RUNNING: 'executing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

/**
 * Public reconnect snapshot. Integrity metadata and request claims remain
 * internal to the Agent ledger and are deliberately omitted.
 * @param {object} tool
 */
export function presentToolExecutionResponse(tool) {
  const status = PUBLIC_TOOL_STATUS[String(tool.status)] || 'unknown';
  return {
    tool_execution_id: tool.toolExecutionId,
    tool_call_id: tool.toolCallId,
    run_id: tool.runId,
    agent_session_id: tool.agentSessionId,
    tool_name: tool.toolName,
    tool_source: tool.toolSource,
    risk_level: tool.riskLevel,
    arguments: tool.argumentsJson ?? {},
    result_json: tool.resultJson ?? null,
    status,
    error_code: tool.errorCode ?? null,
    error: tool.errorCode ?? null,
    started_at: tool.startedAt ?? null,
    completed_at: tool.completedAt ?? null,
    finished_at: tool.completedAt ?? null,
    created_at: tool.createdAt ?? null,
    updated_at: tool.completedAt ?? tool.startedAt ?? tool.createdAt ?? null,
  };
}

/** @param {object} process */
export function presentProcessResponse(process) {
  return {
    process_id: process.processId,
    session_id: process.sandboxSessionId,
    sandbox_session_id: process.sandboxSessionId,
    run_id: process.runId,
    execution_id: process.executionId,
    command: process.command || '',
    status: process.status,
    pid: process.pid ?? null,
    exit_code: process.exitCode ?? null,
    started_at: process.startedAt ?? null,
    finished_at: process.endedAt ?? null,
    created_at: process.createdAt ?? null,
  };
}

function mapProcessErrorToHttp(err) {
  const mapped = mapErrorToHttp(err);
  if (mapped.status !== 500) return mapped;
  const status = Number(err?.status ?? err?.httpStatus);
  if (status === 400 || status === 422) {
    return { status: 400, body: { error: 'Invalid process request', code: 'INVALID_PROCESS_REQUEST' } };
  }
  if (status === 404) {
    return { status: 404, body: { error: 'Process not found', code: 'NOT_FOUND' } };
  }
  if (status === 409) {
    return { status: 409, body: { error: 'Process operation conflict', code: 'PROCESS_CONFLICT' } };
  }
  if (status === 503) {
    return { status: 503, body: { error: 'Process service unavailable', code: 'DEPENDENCY' } };
  }
  return mapped;
}

/**
 * @param {{
 *   createRunService: { execute: Function },
 *   getRunService: { execute: Function },
 *   cancelRunService: { execute: Function },
 *   eventQueryService: { listEvents: Function, resolveEventSequence?: Function },
 *   traceQueryService?: { listForRun: Function, listByTrace?: Function } | null,
 *   eventSseService?: { openStream: Function } | null,
 *   a2aHandler?: { handle: Function } | null,
 *   a2aAdminHandler?: { handle: Function } | null,
 *   config?: { AGENT_INTERNAL_TOKEN?: string, PORT?: number, A2A_PUBLIC_BASE_URL?: string },
 *   sandboxHealthCheck?: () => Promise<{ status?: string } | null>,
 *   dataPlaneReady?: boolean | (() => boolean | Promise<boolean>),
 *   getExtensionDiagnostics?: Function | null,
 *   listRuns?: Function | null,
 *   conversationService?: { list: Function, get: Function, create: Function, delete: Function, ensureSession: Function } | null,
 *   approvalQueryService?: { list: Function, get: Function } | null,
 *   approvalDecisionService?: { resolve: Function, resume: Function } | null,
 *   interactionResponseService?: { respond: Function, rehydrateWaiting: Function } | null,
 *   steerRunService?: { execute: Function } | null,
 *   followUpService?: { execute: Function } | null,
 *   listToolExecutions?: Function | null,
 *   processAccessService?: object | null,
 *   activeRunHint?: () => number,
 *   eventPollIntervalMs?: number,
 *   eventHeartbeatMs?: number,
 * }} deps
 */
export function createAgentHttpServer(deps) {
  if (!deps?.createRunService || !deps?.getRunService || !deps?.cancelRunService) {
    throw new Error('createAgentHttpServer requires create/get/cancel services');
  }
  if (!deps.eventQueryService) {
    throw new Error('createAgentHttpServer requires eventQueryService');
  }

  const token = deps.config?.AGENT_INTERNAL_TOKEN || '';
  const pollMs = deps.eventPollIntervalMs ?? 500;
  const heartbeatMs = deps.eventHeartbeatMs ?? 15_000;
  const eventSseService = deps.eventSseService || null;
  const a2aHandler = deps.a2aHandler || null;
  const a2aAdminHandler = deps.a2aAdminHandler || null;
  const conversationService = deps.conversationService || null;
  const approvalQueryService = deps.approvalQueryService || null;
  const approvalDecisionService = deps.approvalDecisionService || null;
  const interactionResponseService = deps.interactionResponseService || null;
  const processAccessService = deps.processAccessService || null;
  const traceQueryService = deps.traceQueryService || null;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function enforceInternalAuth(req, res) {
    if (!token) return true;
    const provided =
      req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || '';
    if (provided !== token) {
      json(res, 401, { error: 'Invalid or missing internal token' });
      return false;
    }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const requestId = resolveRequestId(req);
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    try {
      const parsedUrl = new URL(
        req.url || '/',
        `http://${req.headers.host || 'localhost'}`,
      );
      const path = parsedUrl.pathname;

      // A2A Agent Card + JSON-RPC (PR-12) — public routes, own credential auth.
      if (
        a2aHandler &&
        typeof a2aHandler.handle === 'function' &&
        (path === '/.well-known/agent-card.json' ||
          path === '/a2a' ||
          path.startsWith('/a2a/'))
      ) {
        const handled = await a2aHandler.handle(req, res, parsedUrl);
        if (handled) return;
      }

      if (req.method === 'GET' && path === '/health') {
        json(res, 200, {
          status: 'ok',
          service: 'pi-enterprise-agent',
          version: '4.0.0',
          active_runs: deps.activeRunHint ? deps.activeRunHint() : 0,
          authority: 'mysql',
        });
        return;
      }

      if (req.method === 'GET' && path === '/ready') {
        let dataPlaneOk = true;
        if (deps.dataPlaneReady === false) {
          dataPlaneOk = false;
        } else if (typeof deps.dataPlaneReady === 'function') {
          try {
            dataPlaneOk = Boolean(await deps.dataPlaneReady());
          } catch {
            dataPlaneOk = false;
          }
        } else if (deps.dataPlaneReady === undefined) {
          // Default: require explicit data plane when not injected as ready.
          dataPlaneOk = true;
        }

        let sandboxOk = true;
        if (deps.sandboxHealthCheck) {
          try {
            const h = await deps.sandboxHealthCheck();
            sandboxOk = h?.status === 'ok';
          } catch {
            sandboxOk = false;
          }
        }

        const ready = dataPlaneOk && sandboxOk;
        json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          data_plane: dataPlaneOk ? 'ok' : 'unavailable',
          sandbox: sandboxOk ? 'ok' : 'unreachable',
        });
        return;
      }

      if (path.startsWith('/internal/')) {
        if (!enforceInternalAuth(req, res)) return;
      }

      if (
        a2aAdminHandler &&
        typeof a2aAdminHandler.handle === 'function' &&
        path.startsWith('/internal/a2a/')
      ) {
        const handled = await a2aAdminHandler.handle(req, res, parsedUrl);
        if (handled) return;
      }

      if (req.method === 'GET' && path === '/internal/extensions/diagnostics') {
        if (typeof deps.getExtensionDiagnostics !== 'function') {
          json(res, 501, {
            error: 'Extension diagnostics not configured',
            code: 'NOT_IMPLEMENTED',
          });
          return;
        }
        try {
          const auth = authSubjectsFromRequest(req);
          json(
            res,
            200,
            deps.getExtensionDiagnostics({
              profileId:
                parsedUrl.searchParams.get('profile_id') || 'coding-agent',
              ownerUserId: auth?.externalUserId || null,
              organizationId: auth?.externalOrgId || null,
            }),
          );
        } catch (error) {
          json(res, 400, {
            error: error instanceof Error ? error.message : 'bad request',
          });
        }
        return;
      }

      if (path === '/internal/conversations') {
        if (!conversationService) {
          json(res, 503, {
            error: 'Conversation data plane unavailable',
            code: 'DEPENDENCY',
          });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        try {
          if (req.method === 'GET') {
            const requestedLimit = Number(parsedUrl.searchParams.get('limit')) || 200;
            const limit = Math.min(200, Math.max(1, requestedLimit));
            json(res, 200, await conversationService.list(auth, { limit }));
            return;
          }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            let body = {};
            try {
              body = raw ? JSON.parse(raw) : {};
            } catch {
              json(res, 400, { error: 'Invalid JSON body' });
              return;
            }
            json(res, 201, await conversationService.create(auth, body));
            return;
          }
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
          return;
        }
      }

      if (req.method === 'POST' && path === '/internal/sessions/ensure') {
        if (!conversationService) {
          json(res, 503, {
            error: 'Conversation data plane unavailable',
            code: 'DEPENDENCY',
          });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const traceId = resolveRequestTraceId(
          req,
          body.trace_id || body.traceId,
        );
        try {
          const result = await conversationService.ensureSession(auth, {
            conversationId:
              body.conversation_id || body.conversationId || null,
            traceId,
          });
          res.setHeader('X-Trace-Id', traceId);
          json(res, 200, { ...result, trace_id: traceId });
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      {
        const sessionAccess = path.match(/^\/internal\/sessions\/([^/]+)$/);
        if (req.method === 'GET' && sessionAccess) {
          if (!conversationService?.resolveSandboxSession) {
            json(res, 503, {
              error: 'Conversation data plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          try {
            json(
              res,
              200,
              await conversationService.resolveSandboxSession(
                auth,
                decodeURIComponent(sessionAccess[1]),
              ),
            );
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      {
        const m = path.match(/^\/internal\/conversations\/([^/]+)$/);
        if (m && (req.method === 'GET' || req.method === 'DELETE')) {
          if (!conversationService) {
            json(res, 503, {
              error: 'Conversation data plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          const conversationId = decodeURIComponent(m[1]);
          try {
            if (req.method === 'GET') {
              json(res, 200, await conversationService.get(conversationId, auth));
            } else {
              await conversationService.delete(conversationId, auth);
              res.writeHead(204);
              res.end();
            }
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // Follow-up is a separate durable Run in the same Conversation/Session.
      {
        const m = path.match(
          /^\/internal\/conversations\/([^/]+)\/follow-ups$/,
        );
        if (m && req.method === 'POST') {
          if (!deps.followUpService?.execute) {
            json(res, 503, {
              error: 'Follow-up service unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          const idempotencyKey = readIdempotencyKey(req);
          if (!idempotencyKey) {
            json(res, 400, {
              error: 'Idempotency-Key header is required',
              code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          const traceContext = resolveRequestTraceContext(
            req,
            body.trace_id || body.traceId,
          );
          const traceId = traceContext.traceId;
          try {
            const result = await deps.followUpService.execute({
              conversationId: decodeURIComponent(m[1]),
              text: body.text,
              auth,
              traceId,
              ...(traceContext.traceState
                ? { traceState: traceContext.traceState }
                : {}),
              idempotencyKey,
              agentId: body.agent_id || body.agentId || null,
              spanId: traceContext.parentSpanId,
            });
            res.setHeader('X-Trace-Id', traceId);
            json(res, 202, presentCreateRunResponse(result));
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      if (path === '/internal/processes' && req.method === 'GET') {
        if (!processAccessService) {
          json(res, 503, { error: 'Process data plane unavailable', code: 'DEPENDENCY' });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        try {
          const rows = await processAccessService.list({
            auth,
            runId: parsedUrl.searchParams.get('run_id'),
            sandboxSessionId: parsedUrl.searchParams.get('session_id'),
            status: parsedUrl.searchParams.get('status'),
            limit: parsedUrl.searchParams.get('limit') || 100,
          });
          const processes = rows.map(presentProcessResponse);
          json(res, 200, { processes, items: processes });
        } catch (err) {
          const mapped = mapProcessErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      {
        const m = path.match(
          /^\/internal\/processes\/([^/]+)(?:\/(logs|read|stdin|signal|cancel|kill))?$/,
        );
        if (m) {
          if (!processAccessService) {
            json(res, 503, { error: 'Process data plane unavailable', code: 'DEPENDENCY' });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          const processId = decodeURIComponent(m[1]);
          const action = m[2] || 'status';
          try {
            if (req.method === 'GET' && action === 'status') {
              json(
                res,
                200,
                presentProcessResponse(
                  await processAccessService.get({ processId, auth }),
                ),
              );
              return;
            }
            if (req.method === 'GET' && action === 'logs') {
              json(
                res,
                200,
                await processAccessService.logs({
                  processId,
                  auth,
                  offset: parsedUrl.searchParams.get('offset') || 0,
                  limit: parsedUrl.searchParams.get('limit'),
                }),
              );
              return;
            }
            if (req.method === 'GET' && action === 'read') {
              json(
                res,
                200,
                await processAccessService.read({
                  processId,
                  auth,
                  stream: parsedUrl.searchParams.get('stream') || 'stdout',
                  cursor: parsedUrl.searchParams.get('cursor') || '0-0',
                  limit: parsedUrl.searchParams.get('limit') || 8192,
                }),
              );
              return;
            }
            if (
              req.method === 'POST' &&
              (action === 'stdin' || action === 'signal' || action === 'kill')
            ) {
              const raw = await readBody(req);
              let body = {};
              try {
                body = raw ? JSON.parse(raw) : {};
              } catch {
                json(res, 400, { error: 'Invalid JSON body' });
                return;
              }
              const result =
                action === 'stdin'
                  ? await processAccessService.stdin({
                      processId,
                      auth,
                      data: body.data,
                      eof: body.eof,
                    })
                  : await processAccessService.signal({
                      processId,
                      auth,
                      signal: body.signal || 'SIGTERM',
                    });
              json(res, 200, result);
              return;
            }
            if (req.method === 'POST' && action === 'cancel') {
              json(
                res,
                200,
                await processAccessService.cancel({ processId, auth }),
              );
              return;
            }
            json(res, 405, { error: 'Method not allowed' });
          } catch (err) {
            const mapped = mapProcessErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      if (req.method === 'GET' && path === '/internal/approvals') {
        if (!approvalQueryService) {
          json(res, 503, {
            error: 'Approval data plane unavailable',
            code: 'DEPENDENCY',
          });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        try {
          const approvals = await approvalQueryService.list(auth, {
            status: parsedUrl.searchParams.get('status') || undefined,
            limit: parsedUrl.searchParams.get('limit') || undefined,
          });
          json(res, 200, { approvals, items: approvals });
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      {
        const m = path.match(/^\/internal\/approvals\/([^/]+)$/);
        if (m && req.method === 'GET') {
          if (!approvalQueryService) {
            json(res, 503, {
              error: 'Approval data plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          try {
            json(
              res,
              200,
              await approvalQueryService.get(decodeURIComponent(m[1]), auth),
            );
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      {
        const m = path.match(/^\/internal\/approvals\/([^/]+)\/decide$/);
        if (m && req.method === 'POST') {
          if (!approvalDecisionService) {
            json(res, 503, {
              error: 'Approval decision plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          try {
            const result = await approvalDecisionService.resolve({
              approvalId: decodeURIComponent(m[1]),
              decision: body.decision,
              reason: body.reason ?? null,
              runId: body.run_id ?? body.runId ?? null,
              auth,
            });
            json(res, result.resumePending ? 202 : 200, result);
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      {
        const m = path.match(
          /^\/internal\/agent-runs\/([^/]+)\/resume-approval$/,
        );
        if (m && req.method === 'POST') {
          if (!approvalDecisionService) {
            json(res, 503, {
              error: 'Approval decision plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          try {
            const result = await approvalDecisionService.resume({
              runId: decodeURIComponent(m[1]),
              approvalId: body.approval_id ?? body.approvalId ?? null,
              auth,
            });
            json(res, result.resumePending ? 202 : 200, result);
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // POST create
      if (req.method === 'POST' && path === '/internal/agent-runs') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const messages = body.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          json(res, 400, { error: 'messages array is required' });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error:
              'X-Acting-User-Id and X-Acting-Organization-Id are required (trusted BFF subjects)',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        const idempotencyKey = readIdempotencyKey(req);
        if (!idempotencyKey) {
          json(res, 400, {
            error: 'Idempotency-Key header is required',
            code: 'IDEMPOTENCY_KEY_REQUIRED',
          });
          return;
        }
        const traceContext = resolveRequestTraceContext(
          req,
          body.trace_id || body.traceId,
        );
        const traceId = traceContext.traceId;
        try {
          const result = await deps.createRunService.execute({
            messages,
            auth: {
              ...auth,
              externalConversationId:
                body.conversation_id || body.conversationId || null,
            },
            traceId,
            ...(traceContext.traceState
              ? { traceState: traceContext.traceState }
              : {}),
            idempotencyKey,
            agentProfileId: body.agent_profile_id || body.agentProfileId || null,
            budget: body.budget || null,
            spanId: traceContext.parentSpanId,
          });
          res.setHeader('X-Trace-Id', traceId);
          json(res, 202, presentCreateRunResponse(result));
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      // GET list
      if (req.method === 'GET' && path === '/internal/agent-runs') {
        if (typeof deps.listRuns !== 'function') {
          json(res, 501, {
            error: 'List not implemented on this node',
            code: 'NOT_IMPLEMENTED',
          });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
          });
          return;
        }
        try {
          const rows = await deps.listRuns({
            auth,
            conversationId:
              parsedUrl.searchParams.get('conversation_id') || null,
            status: parsedUrl.searchParams.get('status') || null,
            limit: Number(parsedUrl.searchParams.get('limit')) || 50,
          });
          json(res, 200, {
            runs: rows.map(presentGetRunResponse),
            items: rows.map(presentGetRunResponse),
          });
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      // GET one
      {
        const traceRun = path.match(/^\/internal\/agent-runs\/([^/]+)\/trace$/);
        if (traceRun && req.method === 'GET') {
          if (!traceQueryService?.listForRun) {
            json(res, 503, { error: 'Trace data plane unavailable', code: 'DEPENDENCY' });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          try {
            const requestTraceId = resolveRequestTraceId(req);
            // The response header identifies this HTTP call. The historical
            // Run trace remains in the JSON body and must not replace it.
            res.setHeader('X-Trace-Id', requestTraceId);
            const result = await traceQueryService.listForRun({
              runId: decodeURIComponent(traceRun[1]),
              auth,
              limit: Number(parsedUrl.searchParams.get('limit')) || 500,
              cursor: parsedUrl.searchParams.get('cursor') || null,
            });
            json(res, 200, result);
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // GET one
      {
        const m = path.match(/^\/internal\/agent-runs\/([^/]+)$/);
        if (m && req.method === 'GET') {
          const runId = decodeURIComponent(m[1]);
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
            });
            return;
          }
          try {
            const run = await deps.getRunService.execute({ runId, auth });
            json(res, 200, presentGetRunResponse(run));
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // GET authoritative ToolExecution ledger snapshot for one owned Run.
      {
        const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/tools$/);
        if (m && req.method === 'GET') {
          if (typeof deps.listToolExecutions !== 'function') {
            json(res, 501, {
              error: 'Tool ledger query not implemented on this node',
              code: 'NOT_IMPLEMENTED',
            });
            return;
          }
          const runId = decodeURIComponent(m[1]);
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
            });
            return;
          }
          try {
            const rows = await deps.listToolExecutions({ runId, auth });
            json(res, 200, {
              tools: rows.map(presentToolExecutionResponse),
            });
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // GET events SSE (MySQL history + Redis live cutover — not process Map)
      {
        const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/events$/);
        if (m && req.method === 'GET') {
          const runId = decodeURIComponent(m[1]);
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
            });
            return;
          }

          // Cursor: after / after_sequence / afterSequence + Last-Event-ID
          // (numeric sequence or ULID event id — resolved by SSE service).
          let after =
            parseInt(
              parsedUrl.searchParams.get('after_sequence') ||
                parsedUrl.searchParams.get('after') ||
                '0',
              10,
            ) || 0;
          const afterSeqParam =
            parsedUrl.searchParams.get('afterSequence') ||
            parsedUrl.searchParams.get('after_sequence');
          if (afterSeqParam && /^\d+$/.test(afterSeqParam)) {
            after = Math.max(after, parseInt(afterSeqParam, 10));
          }
          const lastEventIdHeader = req.headers['last-event-id'];
          const lastEventId =
            typeof lastEventIdHeader === 'string' && lastEventIdHeader.trim()
              ? lastEventIdHeader.trim()
              : null;
          // Numeric Last-Event-ID is still accepted as sequence (legacy).
          if (lastEventId && /^\d+$/.test(lastEventId)) {
            after = Math.max(after, parseInt(lastEventId, 10));
          }

          // JSON list helper for tests / clients that prefer non-SSE
          if (parsedUrl.searchParams.get('format') === 'json') {
            try {
              const page = await deps.eventQueryService.listEvents({
                runId,
                auth,
                afterSequence: after,
                limit: 200,
              });
              json(res, 200, page);
            } catch (err) {
              const mapped = mapErrorToHttp(err);
              json(res, mapped.status, mapped.body);
            }
            return;
          }

          // Ownership fail-closed before opening the stream (no bytes leaked).
          try {
            await deps.getRunService.execute({ runId, auth });
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          let closed = false;
          const ac = new AbortController();
          const onClose = () => {
            closed = true;
            // Disconnect only ends SSE — never cancel Run (plan §12.4).
            try {
              ac.abort();
            } catch {
              /* ignore */
            }
          };
          req.on('close', onClose);
          res.on('close', onClose);
          res.on('error', onClose);

          /**
           * Node res.write semantics: false = high-water mark hit (bytes still
           * queued). Caller must await waitDrain before the next frame.
           * @param {string} chunk
           * @returns {boolean}
           */
          const writeChunk = (chunk) => {
            if (closed || res.writableEnded || res.destroyed) return false;
            try {
              return res.write(chunk);
            } catch {
              closed = true;
              return false;
            }
          };

          const {
            formatSseDataFrame,
            formatSsePingFrame,
            formatSseEndFrame,
            waitForWritableResume,
            sleepMs,
          } = await import('../application/run-event-sse-service.js');

          const waitDrain = () =>
            waitForWritableResume({
              stream: res,
              signal: ac.signal,
              isClosed: () => closed || res.writableEnded || res.destroyed,
            });

          /**
           * Write + await backpressure (fallback poll path).
           * @param {string} frame
           * @returns {Promise<boolean>}
           */
          const writeWithBackpressure = async (frame) => {
            if (closed || res.writableEnded || res.destroyed) return false;
            let ok;
            try {
              ok = writeChunk(frame);
            } catch {
              closed = true;
              return false;
            }
            if (ok === false) {
              const r = await waitDrain();
              return r === 'drained' && !closed && !res.writableEnded;
            }
            return !closed && !res.writableEnded;
          };

          try {
            if (eventSseService && typeof eventSseService.openStream === 'function') {
              try {
                await eventSseService.openStream(
                  {
                    runId,
                    auth,
                    afterSequence: after,
                    lastEventId:
                      lastEventId && !/^\d+$/.test(lastEventId)
                        ? lastEventId
                        : null,
                  },
                  {
                    write: writeChunk,
                    waitDrain,
                    stream: res,
                    isClosed: () => closed || res.writableEnded || res.destroyed,
                    signal: ac.signal,
                  },
                );
              } catch (err) {
                if (err?.name !== 'AbortError' && !closed) {
                  // Stream already open — cannot JSON error; end quietly.
                }
              }
            } else {
              // Fallback: MySQL poll only (still no process Map).
              let cursor = after;
              let lastHeartbeat = Date.now();
              while (!closed && !res.writableEnded && !ac.signal.aborted) {
                try {
                  const page = await deps.eventQueryService.listEvents({
                    runId,
                    auth,
                    afterSequence: cursor,
                    limit: 100,
                  });
                  for (const env of page.events) {
                    if (env.sequence <= cursor) continue;
                    // Await backpressure before next event (no unbounded buffer).
                    // eslint-disable-next-line no-await-in-loop
                    if (!(await writeWithBackpressure(formatSseDataFrame(env)))) {
                      closed = true;
                      break;
                    }
                    cursor = Math.max(cursor, env.sequence);
                  }
                  if (closed) break;
                  if (page.terminal && page.events.length === 0) {
                    await writeWithBackpressure(formatSseEndFrame(page.status));
                    break;
                  }
                  const now = Date.now();
                  if (now - lastHeartbeat >= heartbeatMs) {
                    lastHeartbeat = now;
                    if (!(await writeWithBackpressure(formatSsePingFrame()))) {
                      break;
                    }
                  }
                } catch {
                  // Transient poll errors: wait and retry until client disconnects
                }
                if (closed || res.writableEnded || ac.signal.aborted) break;
                try {
                  await sleepMs(pollMs, ac.signal);
                } catch (err) {
                  if (err?.name === 'AbortError') break;
                  throw err;
                }
              }
            }
          } finally {
            req.off('close', onClose);
            res.off('close', onClose);
            res.off('error', onClose);
            if (!res.writableEnded) {
              try {
                res.end();
              } catch {
                /* ignore */
              }
            }
          }
          return;
        }
      }

      // POST durable steer. Admission and idempotency are committed before 202.
      {
        const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/steer$/);
        if (m && req.method === 'POST') {
          if (!deps.steerRunService?.execute) {
            json(res, 503, {
              error: 'Steer service unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          const idempotencyKey = readIdempotencyKey(req);
          if (!idempotencyKey) {
            json(res, 400, {
              error: 'Idempotency-Key header is required',
              code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          const traceContext = resolveRequestTraceContext(
            req,
            body.trace_id || body.traceId,
          );
          const traceId = traceContext.traceId;
          try {
            const result = await deps.steerRunService.execute({
              runId: decodeURIComponent(m[1]),
              text: body.text,
              conversationId:
                body.conversation_id || body.conversationId || null,
              auth,
              traceId,
              ...(traceContext.traceState
                ? { traceState: traceContext.traceState }
                : {}),
              idempotencyKey,
              spanId: traceContext.parentSpanId,
            });
            res.setHeader('X-Trace-Id', traceId);
            json(res, 202, {
              ...result,
              run_id: result.runId,
              steer_id: result.steerId,
              message_id: result.messageId,
            });
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // Compatibility path: resolve the owned source Run, then create a new
      // follow-up Run. The canonical public API is Conversation-scoped.
      {
        const m = path.match(
          /^\/internal\/agent-runs\/([^/]+)\/follow-up$/,
        );
        if (m && req.method === 'POST') {
          if (!deps.followUpService?.execute) {
            json(res, 503, {
              error: 'Follow-up service unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          const idempotencyKey = readIdempotencyKey(req);
          if (!idempotencyKey) {
            json(res, 400, {
              error: 'Idempotency-Key header is required',
              code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          const traceContext = resolveRequestTraceContext(
            req,
            body.trace_id || body.traceId,
          );
          const traceId = traceContext.traceId;
          try {
            const sourceRun = await deps.getRunService.execute({
              runId: decodeURIComponent(m[1]),
              auth,
            });
            const result = await deps.followUpService.execute({
              conversationId: sourceRun.conversationId,
              text: body.text,
              auth,
              traceId,
              ...(traceContext.traceState
                ? { traceState: traceContext.traceState }
                : {}),
              idempotencyKey,
              spanId: traceContext.parentSpanId,
            });
            res.setHeader('X-Trace-Id', traceId);
            json(res, 202, presentCreateRunResponse(result));
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // POST cancel (plan §18.5 — Idempotency-Key required)
      {
        const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/cancel$/);
        if (m && req.method === 'POST') {
          const runId = decodeURIComponent(m[1]);
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error:
                'X-Acting-User-Id and X-Acting-Organization-Id are required',
            });
            return;
          }
          const idempotencyKey = readIdempotencyKey(req);
          if (!idempotencyKey) {
            // Protocol contract; CancelRunService itself is first-writer durable
            // intent (no full idempotency_records response replay claimed).
            json(res, 400, {
              error: 'Idempotency-Key header is required',
              code: 'IDEMPOTENCY_KEY_REQUIRED',
            });
            return;
          }
          let body = {};
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          try {
            const result = await deps.cancelRunService.execute({
              runId,
              auth,
              reason: body.reason || null,
            });
            json(res, 200, {
              runId: result.runId,
              run_id: result.runId,
              status: result.status,
              cancelRequested: result.cancelRequested,
              cancel_requested: result.cancelRequested,
              signalPending: result.signalPending,
              signal_pending: result.signalPending,
              terminal: result.terminal,
              // Echo key so clients can correlate; not a stored replay payload.
              idempotencyKey,
            });
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // Durable user interaction response. MySQL owns the request/response
      // CAS; Redis enqueue is acceleration only and may be retried later.
      {
        const m = path.match(
          /^\/internal\/agent-runs\/([^/]+)\/interactions\/([^/]+)\/respond$/,
        );
        if (m && req.method === 'POST') {
          if (!interactionResponseService?.respond) {
            json(res, 503, {
              error: 'Interaction data plane unavailable',
              code: 'DEPENDENCY',
            });
            return;
          }
          const auth = authSubjectsFromRequest(req);
          if (!auth) {
            json(res, 400, {
              error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
              code: 'AUTH_CONTEXT_REQUIRED',
            });
            return;
          }
          let body;
          try {
            const raw = await readBody(req);
            body = raw ? JSON.parse(raw) : {};
          } catch {
            json(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(body || {}, 'response')) {
            json(res, 400, { error: 'response is required', code: 'VALIDATION' });
            return;
          }
          try {
            const result = await interactionResponseService.respond({
              runId: decodeURIComponent(m[1]),
              interactionId: decodeURIComponent(m[2]),
              response: body.response,
              auth,
              traceId: resolveRequestTraceId(req),
            });
            json(res, result.resumePending ? 202 : 200, result);
          } catch (err) {
            const mapped = mapErrorToHttp(err);
            json(res, mapped.status, mapped.body);
          }
          return;
        }
      }

      // Restart/refresh rehydration enumerates durable WAITING_INPUT facts and
      // wakes only interactions that already have a resolved response.
      if (req.method === 'POST' && path === '/internal/agent-runs/rehydrate-waiting') {
        if (!interactionResponseService?.rehydrateWaiting) {
          json(res, 503, {
            error: 'Interaction data plane unavailable',
            code: 'DEPENDENCY',
          });
          return;
        }
        const auth = authSubjectsFromRequest(req);
        if (!auth) {
          json(res, 400, {
            error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
            code: 'AUTH_CONTEXT_REQUIRED',
          });
          return;
        }
        let body;
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        try {
          const result = await interactionResponseService.rehydrateWaiting({
            ...body,
            runId: body.run_id ?? body.runId ?? null,
            auth,
          });
          json(res, 200, result);
        } catch (err) {
          const mapped = mapErrorToHttp(err);
          json(res, mapped.status, mapped.body);
        }
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      if (!res.headersSent) {
        const mapped = mapErrorToHttp(err);
        json(res, mapped.status, mapped.body);
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  return server;
}
