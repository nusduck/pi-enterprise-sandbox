/* ── Pi Agent WebUI · API client module ──────────────────────────────── */

/**
 * Generic fetch wrapper with JSON Content-Type and error handling.
 */
export async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp;
}

/**
 * Fetch all conversations from the server.
 * @returns {Promise<Array>} List of conversation objects
 */
export async function fetchConversations() {
  const resp = await api("/api/conversations");
  return resp.json();
}

/**
 * Create a new conversation.
 * @returns {Promise<Object>} The new conversation object
 */
export async function createConversation() {
  const resp = await api("/api/conversations", { method: "POST" });
  return resp.json();
}

/**
 * Delete a conversation by ID.
 * @param {string} id
 */
export async function deleteConversation(id) {
  await api(`/api/conversations/${id}`, { method: "DELETE" });
}

/**
 * Rename a conversation.
 * @param {string} id
 * @param {string} title
 */
export async function renameConversation(id, title) {
  await api(`/api/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ title }),
  });
}

/**
 * Fetch messages for a conversation.
 * @param {string} id
 * @returns {Promise<Array>} List of message objects
 */
export async function fetchMessages(id) {
  const resp = await api(`/api/conversations/${id}/messages`);
  return resp.json();
}

/**
 * Check server health / status.
 * @returns {Promise<Object|null>} Status data or null on failure
 */
export async function checkHealth() {
  try {
    const resp = await api("/api/status");
    return resp.json();
  } catch {
    return null;
  }
}

/**
 * Stream a chat message via SSE. Calls the provided callbacks as events arrive.
 *
 * @param {string}   convId   - Active conversation ID
 * @param {string}   message  - User message text
 * @param {AbortSignal} signal - Optional AbortSignal for cancellation
 * @param {object}   callbacks
 * @param {function} callbacks.onToken      - Called with (tokenText) on each token
 * @param {function} callbacks.onToolStart  - Called with (toolName) when a tool starts
 * @param {function} callbacks.onToolEnd    - Called with (toolName, isError) when a tool completes
 * @param {function} callbacks.onError      - Called with (errorMsg) on stream error
 * @param {function} callbacks.onDone       - Called with (fullText) when stream ends
 * @returns {Promise<void>}
 */
export async function streamChat(convId, message, signal, callbacks = {}) {
  const {
    onToken = () => {},
    onToolStart = () => {},
    onToolEnd = () => {},
    onError = () => {},
    onDone = () => {},
  } = callbacks;

  const resp = await fetch(`/api/conversations/${convId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value);
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        switch (data.type) {
          case "token":
            fullText += data.text;
            onToken(fullText);
            break;
          case "tool_start":
            onToolStart(data.toolName);
            break;
          case "tool_end":
            onToolEnd(data.toolName, data.isError);
            break;
          case "error":
            onError(data.text);
            break;
        }
      } catch {
        /* skip malformed lines */
      }
    }
  }

  onDone(fullText.trim());
}
