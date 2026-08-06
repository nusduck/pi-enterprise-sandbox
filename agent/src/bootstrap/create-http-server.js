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
import {
  parseTraceparentContext,
  parseTracestate,
  parseTraceparent,
  resolveRequestTraceContext,
  resolveRequestTraceId,
} from '../presentation/http/trace-context.js';
import {
  authSubjectsFromRequest,
  resolveRequestId,
  readIdempotencyKey,
  readBody,
  json,
} from '../presentation/http/request-response.js';
import {
  mapErrorToHttp,
  mapProcessErrorToHttp,
} from '../presentation/http/error-mapper.js';
import {
  presentCreateRunResponse,
  presentGetRunResponse,
  presentToolExecutionResponse,
  presentProcessResponse,
} from '../presentation/http/run-presenters.js';
import { handleCronRoute } from '../presentation/http/cron-routes.js';

export {
  parseTraceparentContext,
  parseTracestate,
  parseTraceparent,
  resolveRequestTraceContext,
  resolveRequestTraceId,
  authSubjectsFromRequest,
  resolveRequestId,
  readIdempotencyKey,
  readBody,
  json,
  mapErrorToHttp,
  presentCreateRunResponse,
  presentGetRunResponse,
  presentToolExecutionResponse,
  presentProcessResponse,
};

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
 *   mcpReadiness?: () => { ready?: boolean, serverCount?: number, toolCount?: number, servers?: object[] },
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
 *   cronJobService?: { list: Function, get: Function, create: Function, update: Function, delete: Function, listRuns: Function, runManual: Function } | null,
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
  const cronJobService = deps.cronJobService || null;

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
        // Draining wins over every other signal. On SIGTERM this replica must
        // leave the Service endpoints *before* it starts refusing work, so
        // in-flight requests finish while new ones go elsewhere.
        if (typeof deps.isDraining === 'function' && deps.isDraining()) {
          json(res, 503, { status: 'draining' });
          return;
        }
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

        let mcp = { ready: true, serverCount: 0, toolCount: 0, servers: [] };
        if (typeof deps.mcpReadiness === 'function') {
          try {
            mcp = deps.mcpReadiness() || mcp;
          } catch {
            mcp = { ...mcp, ready: false };
          }
        }
        const mcpOk = mcp.ready !== false;

        const ready = dataPlaneOk && sandboxOk && mcpOk;
        json(res, ready ? 200 : 503, {
          status: ready ? 'ready' : 'not_ready',
          data_plane: dataPlaneOk ? 'ok' : 'unavailable',
          sandbox: sandboxOk ? 'ok' : 'unreachable',
          mcp: {
            status: mcpOk ? 'ok' : 'unreachable',
            server_count: Number(mcp.serverCount) || 0,
            tool_count: Number(mcp.toolCount) || 0,
            servers: Array.isArray(mcp.servers)
              ? mcp.servers.map((server) => ({
                  id: server.serverId,
                  status: server.status,
                  tool_count: Number(server.toolCount) || 0,
                  ...(server.error ? { error: String(server.error) } : {}),
                }))
              : [],
          },
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

      // Which Sandbox replica owns a session's workspace.
      //
      // The BFF streams files and datasets straight to the Sandbox — proxying
      // 50 MB uploads through here would buy nothing — but it has no database
      // of its own, so it cannot know which shard holds the workspace. The
      // Agent does, so it answers the routing question and the BFF dials the
      // owner directly.
      if (req.method === 'GET' && path === '/internal/sandbox-placement') {
        if (typeof deps.resolveSandboxPlacement !== 'function') {
          json(res, 501, {
            error: 'Sandbox placement lookup not configured',
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
        const sandboxSessionId = String(
          parsedUrl.searchParams.get('sandboxSessionId') || '',
        ).trim();
        if (!sandboxSessionId) {
          json(res, 400, { error: 'sandboxSessionId is required' });
          return;
        }
        try {
          const placement = await deps.resolveSandboxPlacement({
            sandboxSessionId,
            orgId: auth.organizationId,
            userId: auth.userId,
          });
          // A session with no placement yet is not an error: it has not been
          // ensured. The caller falls back to discovery, where ensure runs.
          json(res, 200, placement ?? { nodeId: null, baseUrl: null });
        } catch {
          json(res, 503, {
            error: 'Sandbox placement lookup unavailable',
            code: 'PLACEMENT_UNAVAILABLE',
          });
        }
        return;
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

      if (
        await handleCronRoute({
          req,
          res,
          parsedUrl,
          path,
          cronJobService,
        })
      ) {
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
            modelId: body.model_id || body.modelId || null,
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
            const body = presentGetRunResponse(run);
            // Run keeps the next sequence but not the event ULID. Resolve the
            // final event from the durable ledger only for detail reads; list
            // reads stay bounded and avoid an N+1 event query.
            if (body.last_sequence != null) {
              try {
                const page = await deps.eventQueryService.listEvents({
                  runId,
                  auth,
                  afterSequence: Math.max(0, body.last_sequence - 1),
                  limit: 1,
                });
                const event = Array.isArray(page?.events) ? page.events[0] : null;
                body.last_event_id = event?.eventId ?? event?.event_id ?? null;
              } catch {
                // The Run record is still authoritative. A diagnostics-only
                // event lookup must not turn an otherwise valid GET into 500.
              }
            }
            json(res, 200, body);
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
              // Honor ?limit= up to the query-service cap (500). Default 500 so
              // conversation rehydrate is less likely to drop late tool events
              // after many message.delta frames (previous hard-coded 200).
              const requestedLimit = Number(parsedUrl.searchParams.get('limit'));
              const limit = Number.isFinite(requestedLimit)
                ? Math.min(500, Math.max(1, requestedLimit))
                : 500;
              const page = await deps.eventQueryService.listEvents({
                runId,
                auth,
                afterSequence: after,
                limit,
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
