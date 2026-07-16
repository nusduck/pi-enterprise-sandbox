/**
 * Agent Service — independent Node runtime for pi-coding-agent.
 *
 * Internal HTTP API (service auth via X-Internal-Token when configured):
 *   POST /internal/agent-runs
 *   GET  /internal/agent-runs/:id
 *   GET  /internal/agent-runs/:id/events?after=N  (SSE)
 *   POST /internal/agent-runs/:id/cancel
 *   POST /internal/agent-runs/:id/steer
 *   POST /internal/agent-runs/:id/follow-up
 *   POST /internal/agent-runs/:id/resume-approval
 *   POST /internal/approvals/:id/decide
 *   GET  /health
 *   GET  /ready
 */
import http from 'node:http';
import {
  config,
  validateProductionConfig,
  effectiveConfig,
} from './config.js';
import { checkHealth } from './infrastructure/sandbox-client.js';
import {
  createRun,
  getRun,
  subscribeEvents,
  cancelRun,
  activeRunCount,
  steerRun,
  followUpRun,
  resumeRunAfterApproval,
  resumeRunAfterInput,
  decideApprovalLocal,
  rehydrateWaitingRun,
  rehydrateWaitingRunFromSandbox,
} from './application/run-manager.js';
import { getExtensionDiagnostics } from './application/extension-diagnostics-service.js';

// Production fail-fast before bind.
try {
  validateProductionConfig(process.env, { skillsMode: config.SKILLS_MODE });
} catch (err) {
  console.error(`[agent-server] ${err.message}`);
  process.exit(1);
}

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

    if (req.method === 'GET' && path === '/internal/extensions/diagnostics') {
      try {
        json(res, 200, getExtensionDiagnostics({
          profileId: parsedUrl.searchParams.get('profile_id') || 'coding-agent',
          mcpServers: config.MCP_SERVERS,
          skillRoots: config.SKILL_ROOTS,
        }));
      } catch (error) {
        json(res, 400, { error: error.message });
      }
      return;
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
      let result;
      try {
        result = await createRun({
          messages,
          conversation_id: body.conversation_id || null,
          auth,
          trace_id: req.headers['x-trace-id'] || body.trace_id || null,
          budget: body.budget || null,
          agent_profile_id: body.agent_profile_id || null,
        });
      } catch (error) {
        if (error?.code === 'RUN_INITIALIZATION_TIMEOUT') {
          json(res, error.status || 504, {
            error: error.message,
            code: error.code,
          });
          return;
        }
        throw error;
      }
      json(res, 202, result);
      return;
    }

    // GET /internal/agent-runs/:id
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)$/);
      if (m && req.method === 'GET') {
        const runId = decodeURIComponent(m[1]);
        let run = getRun(runId);
        if (!run) {
          await rehydrateWaitingRunFromSandbox(
            runId,
            authFromInternalRequest(req),
          ).catch(() => null);
          run = getRun(runId);
        }
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
        let run = getRun(runId);
        if (!run) {
          await rehydrateWaitingRunFromSandbox(
            runId,
            authFromInternalRequest(req),
          ).catch(() => null);
          run = getRun(runId);
        }
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

    // POST /internal/agent-runs/:id/steer  (ADR §4.7 → session.steer)
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/steer$/);
      if (m && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const result = await steerRun(decodeURIComponent(m[1]), body);
        if (!result) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        if (result.error) {
          json(res, result.status || 400, result);
          return;
        }
        json(res, 200, result);
        return;
      }
    }

    // POST /internal/agent-runs/:id/follow-up  (ADR §4.7 → session.followUp)
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/follow-up$/);
      if (m && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const result = await followUpRun(decodeURIComponent(m[1]), body);
        if (!result) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        if (result.error) {
          json(res, result.status || 400, result);
          return;
        }
        json(res, 200, result);
        return;
      }
    }

    // POST /internal/agent-runs/:id/resume-approval
    {
      const m = path.match(/^\/internal\/agent-runs\/([^/]+)\/resume-approval$/);
      if (m && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const runId = decodeURIComponent(m[1]);
        let result = await resumeRunAfterApproval(runId, body);
        if (!result) {
          await rehydrateWaitingRunFromSandbox(
            runId,
            authFromInternalRequest(req),
          ).catch(() => null);
          result = await resumeRunAfterApproval(runId, body);
        }
        if (!result) {
          json(res, 404, { error: 'run not found' });
          return;
        }
        if (result.error) {
          json(res, result.status || 400, result);
          return;
        }
        json(res, 200, result);
        return;
      }
    }

    // POST /internal/agent-runs/:id/interactions/:interactionId/respond
    {
      const m = path.match(
        /^\/internal\/agent-runs\/([^/]+)\/interactions\/([^/]+)\/respond$/,
      );
      if (m && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        let result = await resumeRunAfterInput(
          decodeURIComponent(m[1]),
          decodeURIComponent(m[2]),
          body,
        );
        if (!result) {
          await rehydrateWaitingRunFromSandbox(
            decodeURIComponent(m[1]),
            authFromInternalRequest(req),
          ).catch(() => null);
          result = await resumeRunAfterInput(
            decodeURIComponent(m[1]),
            decodeURIComponent(m[2]),
            body,
          );
        }
        if (!result) json(res, 404, { error: 'run not found' });
        else if (result.error) json(res, result.status || 400, result);
        else json(res, 200, result);
        return;
      }
    }

    // POST /internal/agent-runs/rehydrate-waiting — agent restart recovery
    if (req.method === 'POST' && path === '/internal/agent-runs/rehydrate-waiting') {
      const raw = await readBody(req);
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: 'Invalid JSON body' });
        return;
      }
      try {
        const result = rehydrateWaitingRun(body);
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: err.message || String(err) });
      }
      return;
    }

    // POST /internal/approvals/:id/decide — resolve local waiter + optional resume
    {
      const m = path.match(/^\/internal\/approvals\/([^/]+)\/decide$/);
      if (m && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          json(res, 400, { error: 'Invalid JSON body' });
          return;
        }
        const approvalId = decodeURIComponent(m[1]);
        const local = decideApprovalLocal(approvalId, body);
        // If pending carries a run_id and decision is terminal, try resume
        const runId = body.run_id || local.pending?.run_id;
        if (runId && (body.decision === 'approve' || body.decision === 'reject' ||
            body.decision === 'approved' || body.decision === 'rejected')) {
          let resumed = await resumeRunAfterApproval(runId, {
            ...body,
            approval_id: approvalId,
          });
          if (!resumed) {
            await rehydrateWaitingRunFromSandbox(
              runId,
              authFromInternalRequest(req),
            ).catch(() => null);
            resumed = await resumeRunAfterApproval(runId, {
              ...body,
              approval_id: approvalId,
            });
          }
          if (resumed && !resumed.error) {
            json(res, 200, { ...local, resume: resumed });
            return;
          }
        }
        json(res, 200, local);
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
    `[agent-server] pi-enterprise-agent v4.0.0 (${config.DEPLOYMENT_ENV}/${config.NODE_ENV}) on port ${config.PORT}`,
  );
  console.log('[agent-server] Effective config:', JSON.stringify(effectiveConfig()));
  if (config.AGENT_INTERNAL_TOKEN) {
    console.log('[agent-server] Internal token auth enabled');
  } else {
    console.warn('[agent-server] AGENT_INTERNAL_TOKEN unset — internal API is open (dev only)');
  }
  await startupCheck();
});
