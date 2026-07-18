/**
 * Agent HTTP server factory (PR-04 T4).
 *
 * No listen/exit on import. Production entry injects Create/Get/Cancel services.
 * Does **not** import the legacy process-local Run manager module.
 *
 * Endpoints (compatible paths):
 *   POST/GET /internal/agent-runs
 *   GET  /internal/agent-runs/:id
 *   GET  /internal/agent-runs/:id/events  (MySQL history + Redis live SSE, PR-10)
 *   POST /internal/agent-runs/:id/cancel
 *   steer/follow-up/resume → 501 (PR-05)
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
 * @returns {string | null} lowercase trace id or null if invalid
 */
export function parseTraceparent(value) {
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
  return tid.toLowerCase();
}

/**
 * Parse W3C traceparent / X-Trace-Id into 32-hex non-zero lowercase trace id.
 * Invalid headers are ignored; mints a fresh id.
 * @param {import('node:http').IncomingMessage} req
 * @param {unknown} [bodyTrace]
 * @returns {string}
 */
export function resolveRequestTraceId(req, bodyTrace) {
  const headers = req.headers || {};
  const fromTp = parseTraceparent(
    headers.traceparent || headers.Traceparent,
  );
  if (fromTp) return fromTp;

  const xt =
    headers['x-trace-id'] ||
    headers['X-Trace-Id'] ||
    (typeof bodyTrace === 'string' ? bodyTrace : null);
  if (typeof xt === 'string' && /^[0-9a-fA-F]{32}$/.test(xt.trim())) {
    const id = xt.trim().toLowerCase();
    if (id !== '0'.repeat(32)) return id;
  }
  // Reject legacy trace_* / UUID shapes — mint a fresh W3C id.
  return randomBytes(16).toString('hex');
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ provider: string, externalOrgId: string, externalUserId: string, displayName?: string|null } | null}
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
  };
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
    return { status: 404, body: { error: 'Run not found', code: 'NOT_FOUND' } };
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
  };
}

/**
 * @param {{
 *   createRunService: { execute: Function },
 *   getRunService: { execute: Function },
 *   cancelRunService: { execute: Function },
 *   eventQueryService: { listEvents: Function, resolveEventSequence?: Function },
 *   eventSseService?: { openStream: Function } | null,
 *   a2aHandler?: { handle: Function } | null,
 *   config?: { AGENT_INTERNAL_TOKEN?: string, PORT?: number, A2A_PUBLIC_BASE_URL?: string },
 *   sandboxHealthCheck?: () => Promise<{ status?: string } | null>,
 *   dataPlaneReady?: boolean | (() => boolean | Promise<boolean>),
 *   getExtensionDiagnostics?: Function | null,
 *   listRuns?: Function | null,
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
        const traceId = resolveRequestTraceId(req, body.trace_id || body.traceId);
        try {
          const result = await deps.createRunService.execute({
            messages,
            auth: {
              ...auth,
              externalConversationId:
                body.conversation_id || body.conversationId || null,
            },
            traceId,
            idempotencyKey,
            agentProfileId: body.agent_profile_id || body.agentProfileId || null,
            budget: body.budget || null,
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

      // PR-05 durable paths — explicit not implemented (no Map fallback)
      if (
        path.match(
          /^\/internal\/agent-runs\/[^/]+\/(steer|follow-up|resume-approval)$/,
        ) ||
        path.match(
          /^\/internal\/agent-runs\/[^/]+\/interactions\/[^/]+\/respond$/,
        ) ||
        path === '/internal/agent-runs/rehydrate-waiting' ||
        path.match(/^\/internal\/approvals\/[^/]+\/decide$/)
      ) {
        json(res, 501, {
          error:
            'Steer/follow-up/resume/approval durable path requires PR-05 Pi session recovery',
          code: 'NOT_IMPLEMENTED',
        });
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
