/**
 * Api Server — HTTP entry point.
 * Routes are modular: no monolithic switch statement.
 */
import http from 'node:http';
import { config } from './config.js';
import { handleChat } from './routes/chat.js';
import { handleStatus } from './routes/status.js';
import { handleFileDownload, handleFileUpload } from './routes/files.js';
import { checkHealth } from './services/sandbox-client.js';

// ── Startup health check ────────────────────────

async function startupCheck() {
  const MAX_RETRIES = 10;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const health = await checkHealth();
    if (health?.status === 'ok') {
      console.log(`[server] Sandbox healthy (v${health.version}, ${health.sessions_active} sessions active)`);
      return true;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  console.warn('[server] Sandbox not responding after startup — will retry on demand');
  return false;
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

function readBodyBuffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Router ──────────────────────────────────────

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
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

    // ── POST /api/chat — SSE agent stream ──
    if (req.method === 'POST' && path === '/api/chat') {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      await handleChat(parsed, res);
      return;
    }

    // ── GET /api/status — health check ──
    if (req.method === 'GET' && path === '/api/status') {
      await handleStatus(res);
      return;
    }

    // ── GET /api/files/download — file proxy ──
    if (req.method === 'GET' && path === '/api/files/download') {
      await handleFileDownload(parsedUrl, res);
      return;
    }

    // ── POST /api/files/upload — upload proxy ──
    if (req.method === 'POST' && path === '/api/files/upload') {
      const rawBody = await readBodyBuffer(req);
      const ct = req.headers['content-type'] || 'application/octet-stream';
      await handleFileUpload(parsedUrl, rawBody, ct, res);
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
  await startupCheck();
});
