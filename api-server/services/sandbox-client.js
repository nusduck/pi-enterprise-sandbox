/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 */
import { config, AUTH_HEADER } from '../config.js';

const BASE = config.SANDBOX_BASE_URL;

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    ...AUTH_HEADER,
    ...extra,
  };
}

/**
 * Low-level sandbox fetch helper.
 */
async function sbFetch(path, opts = {}) {
  const url = `${BASE}${path}`;
  const resp = await fetch(url, {
    ...opts,
    headers: { ...headers(), ...(opts.headers || {}) },
  });
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({ detail: resp.statusText }));
    throw new SandboxError(resp.status, detail.detail || resp.statusText, path);
  }
  return resp;
}

export class SandboxError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = 'SandboxError';
    this.status = status;
    this.path = path;
  }
}

// ── Session ─────────────────────────────────────

export async function createSession(callerId = 'pi-coding-agent', extra = {}) {
  const resp = await sbFetch('/sessions', {
    method: 'POST',
    body: JSON.stringify({ caller_id: callerId, ...extra }),
  });
  return resp.json();
}

export async function getSession(sessionId) {
  const resp = await sbFetch(`/sessions/${sessionId}`);
  return resp.json();
}

// ── Conversation ───────────────────────────────

export async function createConversation(title = 'New chat') {
  const resp = await sbFetch('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return resp.json();
}

export async function getConversationWorkspace(conversationId) {
  const resp = await sbFetch(`/conversations/${conversationId}/workspace`);
  return resp.json();
}

// ── Execution ───────────────────────────────────

export async function executeCommand(sessionId, command, timeout = 120) {
  const resp = await sbFetch(`/sessions/${sessionId}/executions/command`, {
    method: 'POST',
    body: JSON.stringify({ command, timeout }),
  });
  return resp.json();
}

// ── Files ───────────────────────────────────────

export async function readFile(sessionId, path) {
  const q = new URLSearchParams({ path });
  const resp = await sbFetch(`/sessions/${sessionId}/files/read?${q}`);
  return resp.json();
}

export async function readFileWithRange(sessionId, path, offset, limit) {
  const q = new URLSearchParams({ path });
  if (offset != null) q.set('offset', '' + offset);
  if (limit != null) q.set('limit', '' + limit);
  const resp = await sbFetch(`/sessions/${sessionId}/files/read?${q}`);
  return resp.json();
}

export async function writeFile(sessionId, path, content) {
  const resp = await sbFetch(`/sessions/${sessionId}/files/write`, {
    method: 'POST',
    body: JSON.stringify({ path, content }),
  });
  return resp.json();
}

export async function listFiles(sessionId, dir = '.') {
  const q = new URLSearchParams({ path: dir });
  const resp = await sbFetch(`/sessions/${sessionId}/files?${q}`);
  return resp.json();
}

export async function downloadFileStream(sessionId, path) {
  return sbFetch(`/sessions/${sessionId}/files/download?path=${encodeURIComponent(path)}`);
}

// ── Artifacts ───────────────────────────────────

export async function registerArtifact(sessionId, name, path, mimeType, sourceExecutionId) {
  const resp = await sbFetch(`/sessions/${sessionId}/artifacts/register`, {
    method: 'POST',
    body: JSON.stringify({ name, path, mime_type: mimeType, source_execution_id: sourceExecutionId }),
  });
  return resp.json();
}

export async function submitArtifact(sessionId, name, path, mimeType) {
  const resp = await sbFetch(`/sessions/${sessionId}/artifacts/submit`, {
    method: 'POST',
    body: JSON.stringify({ name, path, mime_type: mimeType || 'application/octet-stream' }),
  });
  return resp.json();
}

export async function listArtifacts(sessionId) {
  const resp = await sbFetch(`/sessions/${sessionId}/artifacts`);
  return resp.json();
}

// ── Health ──────────────────────────────────────

export async function checkHealth() {
  try {
    const resp = await fetch(`${BASE}/health`, { headers: AUTH_HEADER });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}
