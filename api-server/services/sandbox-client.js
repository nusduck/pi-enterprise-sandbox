/**
 * Sandbox HTTP Client — typed wrapper around fetch to the sandbox FastAPI service.
 *
 * Supports end-to-end tracing via X-Trace-Id (module-level, per-request set/reset).
 */
import { randomUUID } from 'node:crypto';
import { config, AUTH_HEADER } from '../config.js';

const BASE = config.SANDBOX_BASE_URL;

/** Active trace id for sandbox calls (set at the start of each chat turn). */
let _traceId = null;

export function setTraceId(id) {
  _traceId = id || null;
  return _traceId;
}

export function getTraceId() {
  return _traceId;
}

/**
 * Ensure a trace id exists (generate UUID if missing) and return it.
 */
export function ensureTraceId(preferred) {
  if (preferred) {
    _traceId = preferred;
    return _traceId;
  }
  if (!_traceId) {
    _traceId = randomUUID();
  }
  return _traceId;
}

function headers(extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    ...AUTH_HEADER,
    ...extra,
  };
  const tid = _traceId || extra['X-Trace-Id'];
  if (tid) {
    h['X-Trace-Id'] = tid;
  } else {
    // Auto-generate so every sandbox call is always traced
    const generated = randomUUID();
    _traceId = generated;
    h['X-Trace-Id'] = generated;
  }
  return h;
}

/**
 * Low-level sandbox fetch helper.
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string,string> }} [opts]
 */
async function sbFetch(path, opts = {}) {
  const url = `${BASE}${path}`;
  const { headers: extraHeaders, ...rest } = opts;
  const resp = await fetch(url, {
    ...rest,
    headers: headers(extraHeaders || {}),
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

export async function listConversations() {
  const resp = await sbFetch('/conversations');
  return resp.json();
}

export async function createConversation(title = 'New chat') {
  const resp = await sbFetch('/conversations', {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return resp.json();
}

export async function getConversation(conversationId) {
  const resp = await sbFetch(`/conversations/${conversationId}`);
  return resp.json();
}

export async function getConversationWorkspace(conversationId) {
  const resp = await sbFetch(`/conversations/${conversationId}/workspace`);
  return resp.json();
}

/**
 * Partial update of a conversation (messages, sandbox_session_id, title, …).
 */
export async function updateConversation(conversationId, patch = {}) {
  const resp = await sbFetch(`/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return resp.json();
}

export async function deleteConversation(conversationId) {
  const resp = await sbFetch(`/conversations/${conversationId}`, {
    method: 'DELETE',
  });
  // 204 No Content
  if (resp.status === 204) return { ok: true };
  const text = await resp.text();
  return text ? JSON.parse(text) : { ok: true };
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

/** Sandbox path for downloading a registered artifact by id. */
export function artifactDownloadPath(sessionId, artifactId) {
  return `/sessions/${sessionId}/artifacts/${encodeURIComponent(artifactId)}/download`;
}

export async function downloadArtifactStream(sessionId, artifactId) {
  return sbFetch(artifactDownloadPath(sessionId, artifactId));
}

// ── Approvals ───────────────────────────────────

/**
 * Policy check before high-risk tools.
 * @returns {{ status, approval_id?, risk_level, reason }}
 */
export async function approvalCheck(sessionId, body) {
  const resp = await sbFetch(`/sessions/${sessionId}/executions/approval-check`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return resp.json();
}

/** Poll approval status. */
export async function getApproval(approvalId) {
  const resp = await sbFetch(`/approvals/${encodeURIComponent(approvalId)}`);
  return resp.json();
}

/**
 * Decide a pending approval (sandbox POST /approve).
 * @param {string} approvalId
 * @param {'approve'|'reject'} decision
 */
export async function decideApproval(approvalId, decision) {
  const resp = await sbFetch('/approve', {
    method: 'POST',
    body: JSON.stringify({ approval_id: approvalId, decision }),
  });
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
