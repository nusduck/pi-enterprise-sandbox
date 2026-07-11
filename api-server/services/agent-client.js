/**
 * BFF → Agent service HTTP client.
 * Creates runs, streams sequenced SSE events, and cancels.
 */
import { config } from '../config.js';

function internalHeaders(extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    ...extra,
  };
  if (config.AGENT_INTERNAL_TOKEN) {
    h['X-Internal-Token'] = config.AGENT_INTERNAL_TOKEN;
  }
  return h;
}

/**
 * @param {{ messages: unknown[], conversation_id?: string|null, trace_id?: string|null }} body
 * @param {{ auth?: object|null, traceId?: string|null }} [opts]
 */
export async function createAgentRun(body, { auth = null, traceId = null } = {}) {
  const headers = internalHeaders();
  if (auth?.authorization) headers.Authorization = auth.authorization;
  if (auth?.actingUserId) headers['X-Acting-User-Id'] = auth.actingUserId;
  if (auth?.actingOrganizationId) {
    headers['X-Acting-Organization-Id'] = auth.actingOrganizationId;
  }
  if (auth?.actingRole) headers['X-Acting-Role'] = auth.actingRole;
  if (traceId) headers['X-Trace-Id'] = traceId;

  const resp = await fetch(`${config.AGENT_BASE_URL}/internal/agent-runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent create run failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * @param {string} runId
 */
export async function cancelAgentRun(runId) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', headers: internalHeaders() },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent cancel failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * @param {string} runId
 */
export async function getAgentRun(runId) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}`,
    { headers: internalHeaders() },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent get run failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * Open SSE event stream for a run (sequenced envelopes).
 * @param {string} runId
 * @param {number} [after]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Response>}
 */
export async function openAgentRunEvents(runId, after = 0, { signal } = {}) {
  const url = `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`;
  const headers = {
    Accept: 'text/event-stream',
  };
  if (config.AGENT_INTERNAL_TOKEN) {
    headers['X-Internal-Token'] = config.AGENT_INTERNAL_TOKEN;
  }
  const resp = await fetch(url, { headers, signal });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent events failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp;
}

/**
 * Agent service liveness probe.
 * @returns {Promise<object|null>}
 */
export async function checkAgentHealth() {
  try {
    const resp = await fetch(`${config.AGENT_BASE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    return resp.json();
  } catch {
    return null;
  }
}
