/**
 * Api Server — thin BFF HTTP entry point.
 * Auth, conversations, files, uploads stay here.
 * Chat orchestration is delegated to the independent Agent service.
 */
import http from 'node:http';
import { config, isProtectedApiPath } from './config.js';
import { handleChat } from './routes/chat.js';
import { handleStatus } from './routes/status.js';
import { handleFileDownload, handleFileUpload, handleArtifactDownload } from './routes/files.js';
import {
  handleListConversations,
  handleGetConversation,
  handleCreateConversation,
  handleDeleteConversation,
  handleGetConversationEvents,
} from './routes/conversations.js';
import { handleListArtifacts } from './routes/artifacts.js';
import { handleDecideApproval } from './routes/approvals.js';
import { handleRegister, handleLogin, handleMe } from './routes/auth.js';
import { handleEnsureSession } from './routes/sessions.js';
import { checkHealth } from './services/sandbox-client.js';
import { checkAgentHealth } from './services/agent-client.js';

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

// ── Body parsing ────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── Router ──────────────────────────────────────

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Trace-Id, Idempotency-Key',
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
  const auth = req.headers.authorization || '';
  if (!auth.toLowerCase().startsWith('bearer ') || auth.length < 16) {
    jsonError(res, 401, 'Authentication required');
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  setCommonHeaders(res);

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
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      await handleRegister(parsed, res);
      return;
    }
    if (req.method === 'POST' && path === '/api/auth/login') {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      await handleLogin(parsed, res);
      return;
    }
    if (req.method === 'GET' && path === '/api/auth/me') {
      await handleMe(res, req);
      return;
    }

    // ── POST /api/chat — SSE relay to Agent service ──
    if (req.method === 'POST' && path === '/api/chat') {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      await handleChat(parsed, res, req);
      return;
    }

    // ── GET /api/status — health check ──
    if (req.method === 'GET' && path === '/api/status') {
      await handleStatus(res);
      return;
    }

    // ── Conversations ──
    if (req.method === 'GET' && path === '/api/conversations') {
      await handleListConversations(res, req);
      return;
    }
    if (req.method === 'POST' && path === '/api/conversations') {
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
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

    // ── Approvals: POST /api/approvals/:id/decide ──
    {
      const apprMatch = path.match(/^\/api\/approvals\/([^/]+)\/decide$/);
      if (req.method === 'POST' && apprMatch) {
        const approvalId = decodeURIComponent(apprMatch[1]);
        const body = await readBody(req);
        const parsed = body ? JSON.parse(body) : {};
        await handleDecideApproval(approvalId, parsed, res, req);
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
      const body = await readBody(req);
      const parsed = body ? JSON.parse(body) : {};
      await handleEnsureSession(parsed, res, req);
      return;
    }

    jsonError(res, 404, 'Not found');
  } catch (err) {
    console.error('[server] Unhandled:', err);
    jsonError(res, 500, 'Internal server error');
  }
});

// ── Start ───────────────────────────────────────

server.listen(config.PORT, async () => {
  console.log(`[server] pi-enterprise-api-server v4.0.0 (${config.NODE_ENV}) on port ${config.PORT}`);
  console.log(`[server] Agent base URL: ${config.AGENT_BASE_URL}`);
  if (config.AUTH_ENABLED) {
    console.log('[server] AUTH_ENABLED=true — user-facing /api routes require Bearer token');
  }
  await startupCheck();
});
