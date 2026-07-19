/**
 * Api Server — thin BFF HTTP entry point.
 * Auth, conversations, files, uploads stay here.
 * Chat orchestration is delegated to the independent Agent service.
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  config,
  isProtectedApiPath,
  validateProductionConfig,
  effectiveConfig,
} from './config.js';
import { handleLiveness, handleReadiness, handleStatus } from './routes/status.js';
import { handleFileDownload, handleFileUpload, handleArtifactDownload } from './routes/files.js';
import {
  handleListConversations,
  handleGetConversation,
  handleCreateConversation,
  handleDeleteConversation,
  handleGetConversationEvents,
} from './routes/conversations.js';
import { handleListArtifacts } from './routes/artifacts.js';
import {
  handleDatasetUpload,
  handleListDatasets,
} from './routes/datasets.js';
import {
  handleDecideApproval,
  handleGetApproval,
  handleListApprovals,
} from './routes/approvals.js';
import {
  handleSteerRun,
  handleFollowUpRun,
  handleConversationFollowUp,
  handleCancelRun,
  handleGetRun,
  handleGetRunTrace,
  handleListRunTools,
  handleResumeApproval,
  handleInteractionResponse,
  handleCreateRun,
  handleListRuns,
  handleRunEvents,
} from './routes/runs.js';
import { handleRegister, handleLogin, handleLogout, handleMe } from './routes/auth.js';
import { handleEnsureSession } from './routes/sessions.js';
import {
  handleGetProcess,
  handleGetProcessLogs,
  handleListProcesses,
  handleProcessAction,
  handleReadProcess,
} from './routes/processes.js';
import {
  handleCapabilityRegistry,
  handleExtensionDiagnostics,
} from './routes/capabilities.js';
import {
  handleGetA2aConfig,
  handleIssueA2aCredential,
  handleRotateA2aCredential,
  handleRevokeA2aCredential,
} from './routes/a2a.js';
import { authFromRequest, checkHealth } from './services/sandbox-client.js';
import { checkAgentHealth } from './services/agent-client.js';
import { readJsonBody } from './http/body.js';
import { sendError } from './http/response.js';
import {
  formatTraceparent,
  resolveRequestTraceContext,
  bindRequestTraceContext,
} from './application/trace-context.js';
import {
  startHttpServerSpan,
  startTelemetry,
  withActiveContext,
} from './application/telemetry.js';

// Production fail-fast before bind.
try {
  validateProductionConfig(process.env);
} catch (err) {
  console.error(`[server] ${err.message}`);
  process.exit(1);
}

// ── Startup health check ────────────────────────

async function startupCheck() {
  const MAX_RETRIES = 10;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const health = await checkHealth();
    if (health?.status === 'ok') {
      console.log(`[server] Sandbox healthy (v${health.version}, ${health.sessions_active} sessions active)`);
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const agent = await checkAgentHealth();
  if (agent?.status === 'ok') {
    console.log(`[server] Agent healthy (active_runs=${agent.active_runs ?? '?'})`);
  } else {
    console.warn('[server] Agent not responding after startup — will retry on demand');
  }
}

// ── Router ──────────────────────────────────────

function setCommonHeaders(req, res) {
  const origin = String(req.headers.origin || '');
  const allowed = config.CORS_ALLOWED_ORIGINS;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  } else if (config.DEPLOYMENT_ENV !== 'production' && allowed.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Trace-Id, X-Request-Id, traceparent, tracestate, Idempotency-Key, Last-Event-ID',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Trace-Id, X-Request-Id, traceparent, tracestate',
  );
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/**
 * When AUTH_ENABLED, require Bearer on protected user-facing routes.
 * Does not re-verify JWT (sandbox validates); only checks presence.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} path
 * @returns {boolean} true if request may proceed
 */
function enforceBffAuth(req, res, path) {
  if (!config.AUTH_ENABLED) return true;
  if (!isProtectedApiPath(path)) return true;
  const auth = authFromRequest(req).authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ') || auth.length < 16) {
    jsonError(res, 401, 'Authentication required');
    return false;
  }
  return true;
}

await startTelemetry(process.env);

const server = http.createServer(async (req, res) => {
  const traceContext = resolveRequestTraceContext(req.headers);
  const requestSpan = startHttpServerSpan(req, traceContext);
  const spanContext = requestSpan.span.spanContext();
  const activeTraceContext = spanContext?.traceId
    ? Object.freeze({
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
        parentSpanId: traceContext.parentSpanId,
        traceFlags: spanContext.traceFlags.toString(16).padStart(2, '0'),
        tracestate: spanContext.traceState?.serialize?.() || traceContext.tracestate,
      })
    : traceContext;
  const incomingRequestId = String(req.headers['x-request-id'] || '').trim();
  const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(incomingRequestId)
    ? incomingRequestId
    : randomBytes(16).toString('hex');
  res.once('finish', () => requestSpan.end(null, res.statusCode));
  res.once('close', () => requestSpan.end(null, res.statusCode));
  return withActiveContext(requestSpan.activeContext, async () => {
  bindRequestTraceContext(req, activeTraceContext);
  req.traceContext = activeTraceContext;
  req.requestId = requestId;
  // Keep the public compatibility header in compact 32-hex form. The
  // resolver already rejects UUID/legacy values, so this is normalization
  // rather than a second trace-id source.
  const traceId = String(activeTraceContext.traceId).replaceAll('-', '');
  req.traceId = traceId;
  req.traceparent = formatTraceparent(activeTraceContext);
  req.tracestate = activeTraceContext.tracestate;
  res.setHeader('X-Trace-Id', traceId);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('traceparent', req.traceparent);
  if (activeTraceContext.tracestate) {
    res.setHeader('tracestate', activeTraceContext.tracestate);
  }
  setCommonHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (!enforceBffAuth(req, res, path)) {
      return;
    }

    // ── Auth proxy (public) ──
    if (req.method === 'POST' && path === '/api/auth/register') {
      const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
      await handleRegister(parsed, res, req);
      return;
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
      await handleLogin(parsed, res, req);
      return;
    }
    if (req.method === 'GET' && path === '/api/auth/me') {
      await handleMe(res, req);
      return;
    }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      handleLogout(res);
      return;
    }

    // ── GET /api/status — health check ──
    if (req.method === 'GET' && path === '/api/status') {
      await handleStatus(res);
      return;
    }
    if (req.method === 'GET' && path === '/health/live') {
      handleLiveness(res);
      return;
    }
    if (req.method === 'GET' && path === '/health/ready') {
      await handleReadiness(res);
      return;
    }

    if (req.method === 'GET' && path === '/api/extensions/diagnostics') {
      await handleExtensionDiagnostics(parsedUrl, res, req);
      return;
    }
    {
      const capability = path.match(/^\/api\/capabilities\/(skills|mcp|tools|models)$/);
      if (req.method === 'GET' && capability) {
        await handleCapabilityRegistry(capability[1], parsedUrl, res, req);
        return;
      }
    }

    if (req.method === 'GET' && path === '/api/a2a/config') {
      await handleGetA2aConfig(parsedUrl, res, req);
      return;
    }
    if (req.method === 'POST' && path === '/api/a2a/credentials') {
      const parsed = await readJsonBody(req, {
        maxBytes: config.JSON_BODY_LIMIT_BYTES,
      });
      await handleIssueA2aCredential(parsed, res, req);
      return;
    }
    {
      const credentialAction = path.match(
        /^\/api\/a2a\/credentials\/([^/]+)\/(rotate|revoke)$/,
      );
      if (req.method === 'POST' && credentialAction) {
        const id = decodeURIComponent(credentialAction[1]);
        if (credentialAction[2] === 'rotate') {
          const parsed = await readJsonBody(req, {
            maxBytes: config.JSON_BODY_LIMIT_BYTES,
          });
          await handleRotateA2aCredential(id, parsed, res, req);
        } else {
          await handleRevokeA2aCredential(id, res, req);
        }
        return;
      }
    }

    // ── Conversations ──
    if (req.method === 'GET' && path === '/api/conversations') {
      await handleListConversations(res, req);
      return;
    }
    if (req.method === 'POST' && path === '/api/conversations') {
      const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
      await handleCreateConversation(parsed, res, req);
      return;
    }
    {
      const convEventsMatch = path.match(/^\/api\/conversations\/([^/]+)\/events$/);
      if (convEventsMatch && req.method === 'GET') {
        const id = decodeURIComponent(convEventsMatch[1]);
        const query = Object.fromEntries(parsedUrl.searchParams.entries());
        await handleGetConversationEvents(id, res, req, query);
        return;
      }
      const convMatch = path.match(/^\/api\/conversations\/([^/]+)$/);
      if (convMatch) {
        const id = decodeURIComponent(convMatch[1]);
        if (req.method === 'GET') {
          await handleGetConversation(id, res, req);
          return;
        }
        if (req.method === 'DELETE') {
          await handleDeleteConversation(id, res, req);
          return;
        }
      }
    }

    // ── Artifacts ──
    if (req.method === 'GET' && path === '/api/artifacts') {
      await handleListArtifacts(parsedUrl, res, req);
      return;
    }

    // ── Datasets (PR-09 streaming upload / list) ──
    if (req.method === 'GET' && path === '/api/datasets') {
      await handleListDatasets(parsedUrl, res, req);
      return;
    }
    {
      const dsMatch = path.match(/^\/api\/conversations\/([^/]+)\/datasets$/);
      if (dsMatch) {
        const conversationId = decodeURIComponent(dsMatch[1]);
        if (req.method === 'GET') {
          await handleListDatasets(parsedUrl, res, req, conversationId);
          return;
        }
        if (req.method === 'POST') {
          await handleDatasetUpload(conversationId, parsedUrl, req, res);
          return;
        }
      }
    }

    // ── Approvals ──
    if (req.method === 'GET' && path === '/api/approvals') {
      await handleListApprovals(parsedUrl, res, req);
      return;
    }
    {
      const apprMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
      if (req.method === 'POST' && apprMatch) {
        const approvalId = decodeURIComponent(apprMatch[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleDecideApproval(approvalId, parsed, res, req);
        return;
      }
      const apprDetailMatch = path.match(/^\/api\/approvals\/([^/]+)$/);
      if (req.method === 'GET' && apprDetailMatch) {
        await handleGetApproval(
          decodeURIComponent(apprDetailMatch[1]),
          res,
          req,
        );
        return;
      }
    }

    // ── Run control (ADR §4.7 / §10 / plan §18 PR-10) ──
    {
      // plan §18.3 — POST /api/conversations/{id}/runs
      const convRuns = path.match(/^\/api\/conversations\/([^/]+)\/runs$/);
      if (req.method === 'POST' && convRuns) {
        const conversationId = decodeURIComponent(convRuns[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleCreateRun(parsed, res, req, { conversationId });
        return;
      }
      const convFollowUps = path.match(
        /^\/api\/conversations\/([^/]+)\/follow-ups$/,
      );
      if (req.method === 'POST' && convFollowUps) {
        const conversationId = decodeURIComponent(convFollowUps[1]);
        const parsed = await readJsonBody(req, {
          maxBytes: config.JSON_BODY_LIMIT_BYTES,
        });
        await handleConversationFollowUp(
          conversationId,
          parsed,
          res,
          req,
        );
        return;
      }
      if (req.method === 'POST' && path === '/api/runs') {
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleCreateRun(parsed, res, req);
        return;
      }
      if (req.method === 'GET' && path === '/api/runs') {
        await handleListRuns(parsedUrl, res, req);
        return;
      }
      const runEvents = path.match(/^\/api\/runs\/([^/]+)\/events$/);
      if (req.method === 'GET' && runEvents) {
        await handleRunEvents(decodeURIComponent(runEvents[1]), parsedUrl, res, req);
        return;
      }
      const runTrace = path.match(/^\/api\/runs\/([^/]+)\/trace$/);
      if (req.method === 'GET' && runTrace) {
        await handleGetRunTrace(decodeURIComponent(runTrace[1]), res, req);
        return;
      }
      const runSteer = path.match(/^\/api\/runs\/([^/]+)\/steer$/);
      if (req.method === 'POST' && runSteer) {
        const runId = decodeURIComponent(runSteer[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleSteerRun(runId, parsed, res, req);
        return;
      }
      const runFollow = path.match(/^\/api\/runs\/([^/]+)\/follow-up$/);
      if (req.method === 'POST' && runFollow) {
        const runId = decodeURIComponent(runFollow[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleFollowUpRun(runId, parsed, res, req);
        return;
      }
      const runCancel = path.match(/^\/api\/runs\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && runCancel) {
        await handleCancelRun(decodeURIComponent(runCancel[1]), res, req);
        return;
      }
      const runResume = path.match(/^\/api\/runs\/([^/]+)\/resume-approval$/);
      if (req.method === 'POST' && runResume) {
        const runId = decodeURIComponent(runResume[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleResumeApproval(runId, parsed, res, req);
        return;
      }
      const runInteraction = path.match(
        /^\/api\/runs\/([^/]+)\/interactions\/([^/]+)\/respond$/,
      );
      if (req.method === 'POST' && runInteraction) {
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleInteractionResponse(
          decodeURIComponent(runInteraction[1]),
          decodeURIComponent(runInteraction[2]),
          parsed,
          res,
          req,
        );
        return;
      }
      const runGet = path.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === 'GET' && runGet) {
        await handleGetRun(decodeURIComponent(runGet[1]), res, req);
        return;
      }
      const runTools = path.match(/^\/api\/runs\/([^/]+)\/tools$/);
      if (req.method === 'GET' && runTools) {
        await handleListRunTools(decodeURIComponent(runTools[1]), res, req);
        return;
      }
    }

    // ── Managed process history and control ──
    if (req.method === 'GET' && path === '/api/processes') {
      await handleListProcesses(parsedUrl, res, req);
      return;
    }
    {
      const processMatch = path.match(
        /^\/api\/processes\/([^/]+)(?:\/(logs|read|stdin|signal|cancel|kill))?$/,
      );
      if (processMatch) {
        const processId = decodeURIComponent(processMatch[1]);
        const action = processMatch[2] || 'status';
        if (req.method === 'GET' && action === 'status') {
          await handleGetProcess(processId, res, req);
          return;
        }
        if (req.method === 'GET' && action === 'logs') {
          await handleGetProcessLogs(processId, parsedUrl, res, req);
          return;
        }
        if (req.method === 'GET' && action === 'read') {
          await handleReadProcess(processId, parsedUrl, res, req);
          return;
        }
        if (
          req.method === 'POST' &&
          (action === 'stdin' || action === 'signal' || action === 'cancel' || action === 'kill')
        ) {
          const parsed = await readJsonBody(req, {
            maxBytes: config.JSON_BODY_LIMIT_BYTES,
          });
          await handleProcessAction(processId, action, parsed, res, req);
          return;
        }
      }
    }

    // ── GET /api/files/download — raw workspace file proxy ──
    if (req.method === 'GET' && path === '/api/files/download') {
      await handleFileDownload(parsedUrl, res, req);
      return;
    }

    // ── GET /api/files/artifact-download — artifact deliverable proxy (P7) ──
    if (req.method === 'GET' && path === '/api/files/artifact-download') {
      await handleArtifactDownload(parsedUrl, res, req);
      return;
    }

    // ── POST /api/files/upload — streaming upload proxy (no full heap buffer) ──
    if (req.method === 'POST' && path === '/api/files/upload') {
      await handleFileUpload(parsedUrl, req, res);
      return;
    }

    // ── POST /api/sessions/ensure — create/reuse conversation + sandbox session ──
    if (req.method === 'POST' && path === '/api/sessions/ensure') {
      const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
      await handleEnsureSession(parsed, res, req);
      return;
    }

    jsonError(res, 404, 'Not found');
  } catch (err) {
    requestSpan.end(err, res.statusCode || 500);
    console.error('[server] Unhandled:', err);
    if (!res.headersSent) sendError(res, err, traceId);
    else if (!res.writableEnded) res.end();
  }
  });
});

// ── Start ───────────────────────────────────────

server.listen(config.PORT, async () => {
  console.log(
    `[server] pi-enterprise-api-server v4.0.0 (${config.DEPLOYMENT_ENV}/${config.NODE_ENV}) on port ${config.PORT}`,
  );
  console.log(`[server] Agent base URL: ${config.AGENT_BASE_URL}`);
  console.log('[server] Effective config:', JSON.stringify(effectiveConfig()));
  if (config.AUTH_ENABLED) {
    console.log('[server] AUTH_ENABLED=true — user-facing /api routes require Bearer token');
  }
  await startupCheck();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — shutting down`);
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  try {
    const telemetry = await startTelemetry(process.env);
    await telemetry.shutdown();
  } catch (error) {
    console.error(
      '[server] telemetry shutdown failed:',
      error instanceof Error ? error.message : 'error',
    );
  }
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
