/**
 * Api Server — thin BFF HTTP entry point.
 * Auth, conversations, files, uploads stay here.
 * Chat orchestration is delegated to the independent Agent service.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
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
import { handleDecideApproval } from './routes/approvals.js';
import {
  handleSteerRun,
  handleFollowUpRun,
  handleCancelRun,
  handleGetRun,
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
  handleCapabilityRegistry,
  handleExtensionDiagnostics,
} from './routes/capabilities.js';
import { authFromRequest, checkHealth } from './services/sandbox-client.js';
import { checkAgentHealth } from './services/agent-client.js';
import { readJsonBody } from './http/body.js';
import { sendError } from './http/response.js';

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
    'Content-Type, Authorization, X-Trace-Id, Idempotency-Key, Last-Event-ID',
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

const server = http.createServer(async (req, res) => {
  // W3C 32-hex trace-id (never legacy trace_*). Strict traceparent validation.
  const tp = req.headers.traceparent;
  let traceId = null;
  if (typeof tp === 'string' && tp.trim()) {
    const parts = tp.trim().split('-');
    if (parts.length === 4) {
      const [ver, tid, sid, flags] = parts;
      const verOk = /^[0-9a-fA-F]{2}$/.test(ver) && ver.toLowerCase() !== 'ff';
      const tidOk =
        /^[0-9a-fA-F]{32}$/.test(tid) && tid.toLowerCase() !== '0'.repeat(32);
      const sidOk =
        /^[0-9a-fA-F]{16}$/.test(sid) && sid.toLowerCase() !== '0'.repeat(16);
      const flagsOk = /^[0-9a-fA-F]{2}$/.test(flags);
      if (verOk && tidOk && sidOk && flagsOk) {
        traceId = tid.toLowerCase();
      }
    }
  }
  if (!traceId) {
    const xt = req.headers['x-trace-id'];
    if (
      typeof xt === 'string' &&
      /^[0-9a-fA-F]{32}$/.test(xt.trim()) &&
      xt.trim().toLowerCase() !== '0'.repeat(32)
    ) {
      traceId = xt.trim().toLowerCase();
    }
  }
  if (!traceId) {
    traceId = randomUUID().replaceAll('-', '');
  }
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
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
          await handleListDatasets(parsedUrl, res, req);
          return;
        }
        if (req.method === 'POST') {
          await handleDatasetUpload(conversationId, parsedUrl, req, res);
          return;
        }
      }
    }

    // ── Approvals: POST /api/approvals/:id/decide ──
    {
      const apprMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
      if (req.method === 'POST' && apprMatch) {
        const approvalId = decodeURIComponent(apprMatch[1]);
        const parsed = await readJsonBody(req, { maxBytes: config.JSON_BODY_LIMIT_BYTES });
        await handleDecideApproval(approvalId, parsed, res, req);
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
    console.error('[server] Unhandled:', err);
    if (!res.headersSent) sendError(res, err, traceId);
    else if (!res.writableEnded) res.end();
  }
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
