/**
 * Agent Service — independent Node runtime for pi-coding-agent.
 *
 * Internal HTTP API (service auth via X-Internal-Token when configured):
 *   POST /internal/agent-runs
 *   GET  /internal/agent-runs/:id
 *   GET  /internal/agent-runs/:id/events?after=N  (SSE)
 *   POST /internal/agent-runs/:id/cancel
 *   GET  /health
 *   GET  /ready
 */
import http from 'node:http';
import { config } from './config.js';
import { checkHealth } from './services/sandbox-client.js';
import {
  createRun,
  getRun,
  subscribeEvents,
  cancelRun,
  activeRunCount,
} from './run-manager.js';

// ── Startup health check ────────────────────────

async function startupCheck() {
  const MAX_RETRIES = 10;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const health = await checkHealth();
    if (health?.status === 'ok') {
      console.log(
        `[agent-server] Sandbox healthy (v${health.version}, ${health.sessions_active} sessions active)`,
      );
      return true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.warn('[agent-server] Sandbox not responding after startup — will retry on demand');
  return false;
}

// ── Helpers ─────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Service-to-service auth. When AGENT_INTERNAL_TOKEN is empty, allow (dev).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function enforceInternalAuth(req, res) {
  const required = config.AGENT_INTERNAL_TOKEN;
  if (!required) return true;
  const provided =
    req.headers['x-internal-token'] ||
    req.headers['X-Internal-Token'] ||
    '';
  if (provided !== required) {
    json(res, 401, { error: 'Invalid or missing internal token' });
    return false;
  }
  return true;
}

/**
 * Extract user auth forwarded by BFF for sandbox actor resolution.
 * @param {import('node:http').IncomingMessage} req
 */
function authFromInternalRequest(req) {
  const out = {};
  const auth = req.headers.authorization || req.headers.Authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    out.authorization = auth;
  }
  // BFF may forward acting headers after validating the user
  const uid = req.headers['x-acting-user-id'];
  const oid = req.headers['x-acting-organization-id'];
  const role = req.headers['x-acting-role'];
  if (typeof uid === 'string' && uid) out.actingUserId = uid;
  if (typeof oid === 'string' && oid) out.actingOrganizationId = oid;
  if (typeof role === 'string' && role) out.actingRole = role;
  return out;
}

// ── Server ──────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = parsedUrl.pathname;

    // Public health probes (no internal token)
    if (req.method === 'GET' && path === '/health') {
      json(res, 200, {
        status: 'ok',
        service: 'pi-enterprise-agent',
        version: '4.0.0',
        active_runs: activeRunCount(),
      });
      return;
    }

    if (req.method === 'GET' && path === '/ready') {
      const sandbox = await checkHealth();
      const sandboxOk = sandbox?.status === 'ok';
      json(res, sandboxOk ? 200 : 503, {
        status: sandboxOk ? 'ready' : 'not_ready',
        sandbox: sandboxOk ? 'ok' : 'unreachable',
        active_runs: activeRunCount(),
      });
      return;
    }

    // All /internal/* require service token when configured
    if (path.startsWith('/internal/')) {
      if (!enforceInternalAuth(req, res)) return;
    }

    // POST /internal/agent-runs
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
      const auth = authFromInternalRequest(req);
      const result = createRun({
        messages,
        conversation_id: body.conversation_id || null,
        auth,
        trace_id: req.headers['x-trace-id'] || body.trace_id || null,
      });
      json(res, 202, result);
      return;
    }

    // GET /internal/agent-runs/:id
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const run = getRun(decodeURIComponent(m[1]));
        if (!run) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        json(res, 200, run);
        return;
      }
    }

    // GET /internal/agent-runs/:id/events?after=N  (SSE)
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/events$/);
      if (m && req.method === 'GET') {
        const runId = decodeURIComponent(m[1]);
        const run = getRun(runId);
        if (!run) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        const after = parseInt(parsedUrl.searchParams.get('after') || '0', 10) || 0;

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        let closed = false;
        const writeEntry = (entry) => {
          if (closed || res.writableEnded || res.destroyed) return;
          if (entry.event?.type === '__run_terminal__') {
            // End stream after terminal marker
            closed = true;
            try {
              res.write(`event: end\ndata: ${JSON.stringify({ status: getRun(runId)?.status })}\n\n`);
            } catch {
              /* ignore */
            }
            if (!res.writableEnded) res.end();
            return;
          }
          try {
            res.write(
              `id: ${entry.sequence}\ndata: ${JSON.stringify({
                sequence: entry.sequence,
                event: entry.event,
                ts: entry.ts,
              })}\n\n`,
            );
          } catch {
            closed = true;
          }
        };

        const unsub = subscribeEvents(runId, after, writeEntry);
        if (!unsub) {
          json(res, 404, { error: 'run not found' });
          return;
        }

        const onClose = () => {
          closed = true;
          unsub();
        };
        req.on('close', onClose);
        res.on('close', onClose);
        return;
      }
    }

    // POST /internal/agent-runs/:id/cancel
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/cancel$/);
      if (m && req.method === 'POST') {
        const result = await cancelRun(decodeURIComponent(m[1]));
        if (!result) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        json(res, 200, result);
        return;
      }
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[agent-server] Unhandled:', err);
    if (!res.headersSent) {
      json(res, 500, { error: 'Internal server error' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

server.listen(config.PORT, async () => {
  console.log(
    `[agent-server] pi-enterprise-agent v4.0.0 (${config.NODE_ENV}) on port ${config.PORT}`,
  );
  if (config.AGENT_INTERNAL_TOKEN) {
    console.log('[agent-server] Internal token auth enabled');
  } else {
    console.warn('[agent-server] AGENT_INTERNAL_TOKEN unset — internal API is open (dev only)');
  }
  await startupCheck();
});
