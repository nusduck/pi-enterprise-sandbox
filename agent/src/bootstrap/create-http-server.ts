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
import { createInternalAuthGate } from './internal-auth.js';
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
} from '../presentation/http/error-mapper.js';
import {
  handleHealthRoute,
  type McpReadiness,
} from '../presentation/http/health-routes.js';
import {
  presentCreateRunResponse,
  presentGetRunResponse,
  presentToolExecutionResponse,
} from '../presentation/http/run-presenters.js';
import { handleCronRoute } from '../presentation/http/cron-routes.js';
import { handleSkillRoute } from '../presentation/http/skill-routes.js';
import { handleAuthRoute } from '../presentation/http/auth-routes.js';

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
};

/** 过渡期宽松类型：这些依赖大多还是 JS 类，形状由各自的服务模块负责。 */
type Loose = any;

/**
 * 解析后的请求体。**刻意不收窄**：这是未经校验的外来 JSON，字段是否存在、
 * 是什么类型，由每条路由自己判断（大量 `body.a || body.b` 的双写法兼容）。
 * 写成 `Record<string, unknown>` 只会把判断变成一串断言，不会更安全。
 */
type JsonBody = Record<string, any>;

/** HTTP 服务器的依赖面。必需的三个在函数体里 fail-fast，其余缺省即关闭对应路由。 */
export interface AgentHttpServerDeps {
  createRunService: { execute: Loose };
  getRunService: { execute: Loose };
  cancelRunService: { execute: Loose };
  eventQueryService: { listEvents: Loose; resolveEventSequence?: Loose };
  traceQueryService?: { listForRun: Loose; listByTrace?: Loose } | null;
  eventSseService?: { openStream: Loose } | null;
  a2aHandler?: { handle: Loose } | null;
  a2aAdminHandler?: { handle: Loose } | null;
  config?: { AGENT_INTERNAL_TOKEN?: string; PORT?: number; A2A_PUBLIC_BASE_URL?: string };
  sandboxHealthCheck?: () => Promise<{ status?: string } | null>;
  dataPlaneReady?: boolean | (() => boolean | Promise<boolean>);
  mcpReadiness?: () => McpReadiness;
  getExtensionDiagnostics?: Loose;
  mutateSkill?: Loose;
  browserAuthService?: Loose;
  listRuns?: Loose;
  conversationService?: Loose;
  approvalQueryService?: { list: Loose; get: Loose } | null;
  approvalDecisionService?: { resolve: Loose; resume: Loose } | null;
  interactionResponseService?: { respond: Loose; rehydrateWaiting: Loose } | null;
  steerRunService?: { execute: Loose } | null;
  followUpService?: { execute: Loose } | null;
  listToolExecutions?: Loose;
  cronJobService?: import('../presentation/http/cron-routes.js').CronJobServiceLike | null;
  activeRunHint?: () => number;
  eventPollIntervalMs?: number;
  eventHeartbeatMs?: number;
}

export function createAgentHttpServer(deps: AgentHttpServerDeps) {
  if (!deps?.createRunService || !deps?.getRunService || !deps?.cancelRunService) {
    throw new Error('createAgentHttpServer requires create/get/cancel services');
  }
  if (!deps.eventQueryService) {
    throw new Error('createAgentHttpServer requires eventQueryService');
  }

  const enforceInternalAuth = createInternalAuthGate(deps.config, json);
  const pollMs = deps.eventPollIntervalMs ?? 500;
  const heartbeatMs = deps.eventHeartbeatMs ?? 15_000;
  const eventSseService = deps.eventSseService || null;
  const a2aHandler = deps.a2aHandler || null;
  const a2aAdminHandler = deps.a2aAdminHandler || null;
  const conversationService = deps.conversationService || null;
  const approvalQueryService = deps.approvalQueryService || null;
  const approvalDecisionService = deps.approvalDecisionService || null;
  const interactionResponseService = deps.interactionResponseService || null;
  const traceQueryService = deps.traceQueryService || null;
  const cronJobService = deps.cronJobService || null;

  const server = http.createServer(async (req, res) => {
    const requestId = resolveRequestId(req);
    Object.assign(req, { requestId });
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

      if (
        await handleHealthRoute({
          req,
          res,
          path,
          activeRunHint: deps.activeRunHint,
          dataPlaneReady: deps.dataPlaneReady,
          sandboxHealthCheck: deps.sandboxHealthCheck,
          mcpReadiness: deps.mcpReadiness,
        })
      ) {
        return;
      }

      if (path.startsWith('/internal/')) {
        if (!enforceInternalAuth(req, res)) return;
      }

      if (await handleAuthRoute({
        req,
        res,
        path,
        browserAuthService: deps.browserAuthService,
      })) return;

      if (
        a2aAdminHandler &&
        typeof a2aAdminHandler.handle === 'function' &&
        path.startsWith('/internal/a2a/')
      ) {
        const handled = await a2aAdminHandler.handle(req, res, parsedUrl);
        if (handled) return;
      }

      if (await handleSkillRoute({ req, res, parsedUrl, path,
        getExtensionDiagnostics: deps.getExtensionDiagnostics,
        mutateSkill: deps.mutateSkill })) return;

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
            let body: JsonBody = {};
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
        let body: JsonBody = {};
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
        let body: JsonBody = {};
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
                  afterSequence: Math.max(0, Number(body.last_sequence) - 1),
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
          let body: JsonBody = {};
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
              // Sub-agent children stopped by this cancel; empty for an
              // ordinary Run. A caller cancelling a fan-out otherwise has to
              // reconstruct the child ids from the parent's tool results.
              cancelledDescendants: result.cancelledDescendants ?? [],
              cancelled_descendants: result.cancelledDescendants ?? [],
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
