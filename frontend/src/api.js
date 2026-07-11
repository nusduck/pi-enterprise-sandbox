/**
 * HTTP + SSE stream client for the Sandbox API Server.
 */

import { readSSEStream } from './sse.js';
import { isAllowedApiUrl } from './security.js';

export { readSSEStream } from './sse.js';
export { isAllowedApiUrl, safeApiUrl } from './security.js';

const BASE = '/api';
const MAX_RETRIES = 3;
const TOKEN_KEY = 'sandbox_auth_token';

// ── Auth token (localStorage) ───────────────────

export function getAuthToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setAuthToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode / blocked storage */
  }
}

export function clearAuthToken() {
  setAuthToken('');
}

/** Headers with optional Authorization when a token is stored. */
export function authHeaders(extra = {}) {
  const h = { ...extra };
  const token = getAuthToken();
  if (token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

/**
 * Send a chat message and consume the SSE stream.
 * @param {object[]} messages  — full message history including latest user msg
 * @param {function} onEvent   — SSE event handler
 * @param {AbortSignal} signal
 * @param {string} [conversationId]  — persistent conversation ID (reuses workspace)
 * @returns {Promise<number>}  — HTTP status
 */
export async function sendChatMessage(messages, onEvent, signal, conversationId) {
  const body = { messages };
  if (conversationId) body.conversation_id = conversationId;

  const resp = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  }

  await readSSEStream(resp, onEvent, signal);
  return resp.status;
}

/**
 * Get API Server status.
 */
export async function getStatus() {
  const resp = await fetch(`${BASE}/status`);
  if (!resp.ok) throw new Error(`Status check failed: ${resp.status}`);
  return resp.json();
}

// ── Auth ────────────────────────────────────────

/**
 * Register a new user; persists token on success.
 * @param {{ username: string, password: string, display_name?: string }} body
 */
export async function register(body) {
  const resp = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || err.detail || `Register failed: ${resp.status}`);
  }
  const data = await resp.json();
  if (data.token) setAuthToken(data.token);
  return data;
}

/**
 * Login; persists token on success.
 * @param {{ username: string, password: string }} body
 */
export async function login(body) {
  const resp = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || err.detail || `Login failed: ${resp.status}`);
  }
  const data = await resp.json();
  if (data.token) setAuthToken(data.token);
  return data;
}

/**
 * Current user (requires stored token).
 */
export async function me() {
  const resp = await fetch(`${BASE}/auth/me`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || err.detail || `Me failed: ${resp.status}`);
  }
  return resp.json();
}

// ── Conversations ───────────────────────────────

/**
 * List all conversations (newest first).
 * @returns {Promise<object[]>}
 */
export async function listConversations() {
  const resp = await fetch(`${BASE}/conversations`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `List conversations failed: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Get one conversation (includes messages).
 * @param {string} id
 */
export async function getConversation(id) {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Get conversation failed: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Create a new empty conversation.
 * @param {string} [title]
 */
export async function createConversation(title = 'New chat') {
  const resp = await fetch(`${BASE}/conversations`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Create conversation failed: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Delete a conversation.
 * @param {string} id
 */
export async function deleteConversation(id) {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!resp.ok && resp.status !== 204) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Delete conversation failed: ${resp.status}`);
  }
  return true;
}

// ── Artifacts ───────────────────────────────────

/**
 * List artifacts for a sandbox session.
 * @param {string} sessionId
 * @returns {Promise<{ artifacts: object[], total?: number }>}
 */
export async function listArtifacts(sessionId) {
  const q = new URLSearchParams({ session_id: sessionId });
  const resp = await fetch(`${BASE}/artifacts?${q}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `List artifacts failed: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Decide a pending approval (approve | reject).
 * @param {string} approvalId
 * @param {'approve'|'reject'} decision
 */
export async function decideApproval(approvalId, decision) {
  const resp = await fetch(`${BASE}/approvals/${encodeURIComponent(approvalId)}/decide`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ decision }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `Approval failed: ${resp.status}`);
  }
  return resp.json();
}

// ── Files ───────────────────────────────────────

/**
 * Upload a file to the sandbox workspace.
 * @param {string} sessionId
 * @param {File} file
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>} sandbox API response
 */
export async function uploadFile(sessionId, file, signal) {
  const fd = new FormData();
  fd.append('file', file);

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(`${BASE}/files/upload?session_id=${sessionId}`, {
        method: 'POST',
        headers: authHeaders(),
        body: fd,
        signal,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.detail || err.error || `Upload failed (HTTP ${resp.status})`);
      }
      return resp.json();
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === MAX_RETRIES - 1) throw err;
      lastErr = err;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr || new Error('Upload failed after retries');
}

/**
 * Build a download URL for a raw workspace file (e.g. user uploads inspection).
 * Agent deliverables should use getArtifactDownloadUrl instead (P7).
 */
export function getDownloadUrl(sessionId, path) {
  const url = `${BASE}/files/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  return isAllowedApiUrl(url) ? url : null;
}

/**
 * Build a download URL for a registered artifact deliverable (P7).
 */
export function getArtifactDownloadUrl(sessionId, artifactId) {
  const url = `${BASE}/files/artifact-download?session_id=${encodeURIComponent(sessionId)}&artifact_id=${encodeURIComponent(artifactId)}`;
  return isAllowedApiUrl(url) ? url : null;
}
