/**
 * HTTP + SSE stream client for the Sandbox API Server.
 */

const BASE = '/api';
const MAX_RETRIES = 3;

/**
 * Helper: read SSE stream from a fetch Response.
 * @param {Response} resp
 * @param {function} onEvent  — called with parsed event object
 * @param {AbortSignal} [signal]
 */
export async function readSSEStream(resp, onEvent, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const json = line.slice(6).trim();
        if (!json) continue;
        try {
          onEvent(JSON.parse(json));
        } catch (e) {
          console.warn('[api] SSE parse error:', e, line);
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
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
    headers: { 'Content-Type': 'application/json' },
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
 * Build a download URL for a file in the sandbox.
 */
export function getDownloadUrl(sessionId, path) {
  return `${BASE}/files/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
}
