#!/usr/bin/env node
/**
 * Pi Enterprise Sandbox Server — v3
 *
 * BFF (Backend For Frontend) serving:
 *  - Built static files (Vite build -> dist/)
 *  - REST API proxy to Sandbox container
 *  - Conversation management with JSON persistence
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// ── Config ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const SANDBOX_URL = process.env.SANDBOX_BASE_URL || 'http://sandbox:8081';
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const DATA_DIR = process.env.WEBUI_DATA_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CONVERSATIONS_FILE = path.join(DATA_DIR, 'conversations.json');

// ── Sandbox API Client ─────────────────────────────────────────────────

function sandboxFetch(sandboxPath, options) {
  const url = SANDBOX_URL + sandboxPath;
  const headers = { 'Content-Type': 'application/json', ...(options?.headers || {}) };
  return fetch(url, { ...options, headers });
}

// ── Conversation Manager ───────────────────────────────────────────────

const conversations = new Map();

function ensureDataDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function saveConversations() {
  try {
    ensureDataDir();
    const data = Array.from(conversations.values()).map(c => ({
      id: c.id, title: c.title,
      sandboxSessionId: c.sandboxSessionId,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
    }));
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[conv] Failed to save:', err.message);
  }
}

function loadConversations() {
  try {
    ensureDataDir();
    if (!fs.existsSync(CONVERSATIONS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf-8'));
    for (const item of data) {
      conversations.set(item.id, {
        id: item.id, title: item.title || 'New conversation',
        messages: [], sandboxSessionId: item.sandboxSessionId || null,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
      });
    }
    console.log('[conv] Loaded', conversations.size, 'conversations');
  } catch (err) {
    console.error('[conv] Failed to load:', err.message);
  }
}

function createConversation(title) {
  const id = 'conv_' + crypto.randomUUID().slice(0, 8);
  const now = new Date().toISOString();
  const conv = { id, title: title || 'New conversation', messages: [],
    sandboxSessionId: null, createdAt: now, updatedAt: now };
  conversations.set(id, conv);
  saveConversations();
  return conv;
}

// ── MIME types ─────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// ── Route handlers ─────────────────────────────────────────────────────

async function handleStatus(req, res) {
  const healthResp = await sandboxFetch('/health').catch(() => null);
  const health = healthResp?.ok ? await healthResp.json() : { status: 'error', error: 'sandbox unreachable' };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', sandbox: health, conversations: conversations.size, version: '3.0.0' }));
}

async function handleCreateSession(req, res) {
  const body = await readBody(req);
  const resp = await sandboxFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify(body || { caller_id: 'pi-webui' }),
  });
  const data = await resp.json();
  res.writeHead(resp.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleSandboxProxy(req, res, sessionId, subpath, url) {
  const options = { method: req.method, headers: {} };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    if (body) options.body = JSON.stringify(body);
  }
  const targetPath = '/sessions/' + sessionId + '/' + subpath + (url.search || '');
  const resp = await sandboxFetch(targetPath, options);
  const body = await resp.text();
  res.writeHead(resp.status, { 'Content-Type': resp.headers.get('content-type') || 'application/json' });
  res.end(body);
}

async function handleSandboxDirect(req, res, pathname, url) {
  const targetPath = pathname.replace(/^\/api/, '') + (url.search || '');
  const options = { method: req.method, headers: {} };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await readBody(req);
    if (body) options.body = JSON.stringify(body);
  }
  const resp = await sandboxFetch(targetPath, options);
  const data = await resp.text();
  res.writeHead(resp.status, { 'Content-Type': 'application/json' });
  res.end(data);
}

async function handleConversationsAPI(req, res, url) {
  const pathname = url.pathname;
  const parts = pathname.split('/').filter(Boolean);

  // GET /api/conversations — list
  if (parts.length === 2 && req.method === 'GET') {
    const list = Array.from(conversations.values())
      .map(c => ({ id: c.id, title: c.title, messageCount: c.messages.length,
        createdAt: c.createdAt, updatedAt: c.updatedAt }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/conversations — create
  if (parts.length === 2 && req.method === 'POST') {
    const body = await readBody(req);
    const conv = createConversation(body?.title);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(conv));
    return;
  }

  const convId = parts[2];
  const conv = conversations.get(convId);

  if (!conv) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // GET /api/conversations/:id
  if (parts.length === 3 && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: conv.id, title: conv.title,
      sandboxSessionId: conv.sandboxSessionId, createdAt: conv.createdAt, updatedAt: conv.updatedAt }));
    return;
  }

  // DELETE /api/conversations/:id
  if (parts.length === 3 && req.method === 'DELETE') {
    conversations.delete(convId);
    saveConversations();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // PATCH /api/conversations/:id — rename
  if (parts.length === 3 && req.method === 'PATCH') {
    const body = await readBody(req);
    if (body?.title) conv.title = body.title;
    conv.updatedAt = new Date().toISOString();
    saveConversations();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: conv.id, title: conv.title }));
    return;
  }

  // GET /api/conversations/:id/messages
  if (parts.length === 4 && parts[3] === 'messages' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(conv.messages || []));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}

function serveStatic(req, res) {
  let filePath = path.join(DIST_DIR, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }
  try {
    const content = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

// ── Utilities ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve(null);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
    });
    req.on('error', () => resolve(null));
  });
}

// ── Router ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Trace-Id');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  try {
    // Health check
    if (pathname === '/api/status' && req.method === 'GET') {
      return await handleStatus(req, res);
    }

    // Create session
    if (pathname === '/api/sessions' && req.method === 'POST') {
      return await handleCreateSession(req, res);
    }

    // Sandbox session proxy: /api/sessions/:id/...
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
    if (sessionMatch) {
      return await handleSandboxProxy(req, res, sessionMatch[1], sessionMatch[2], url);
    }

    // Sandbox direct proxy: /api/health, /api/skills, /api/sessions (GET list)
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/conversations') && pathname !== '/api/status') {
      return await handleSandboxDirect(req, res, pathname, url);
    }

    // Conversations API
    if (pathname.startsWith('/api/conversations')) {
      return await handleConversationsAPI(req, res, url);
    }

    // Static files
    serveStatic(req, res);

  } catch (err) {
    console.error('[server] Error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────

loadConversations();
server.listen(PORT, '0.0.0.0', () => {
  console.log('[server] Pi Enterprise Sandbox v3');
  console.log('[server] http://0.0.0.0:' + PORT);
  console.log('[server] Sandbox proxy:', SANDBOX_URL);
  console.log('[server] Static:', DIST_DIR);
});

process.on('unhandledRejection', reason => console.error('[server] UNHANDLED REJECTION:', reason));
process.on('uncaughtException', err => console.error('[server] UNCAUGHT EXCEPTION:', err));
process.on('SIGINT', () => { saveConversations(); process.exit(0); });
process.on('SIGTERM', () => { saveConversations(); process.exit(0); });
