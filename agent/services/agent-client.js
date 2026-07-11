/**
 * Thin HTTP client used by BFF to talk to the Agent service.
 * Kept in agent/ for symmetry; BFF has its own copy under api-server/services/.
 */
import { config } from '../config.js';

const BASE = process.env.AGENT_BASE_URL || `http://127.0.0.1:${config.PORT}`;

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

export async function createAgentRun(body, { auth, traceId } = {}) {
  const headers = internalHeaders();
  if (auth?.authorization) headers.Authorization = auth.authorization;
  if (auth?.actingUserId) headers['X-Acting-User-Id'] = auth.actingUserId;
  if (auth?.actingOrganizationId) {
    headers['X-Acting-Organization-Id'] = auth.actingOrganizationId;
  }
  if (auth?.actingRole) headers['X-Acting-Role'] = auth.actingRole;
  if (traceId) headers['X-Trace-Id'] = traceId;

  const resp = await fetch(`${BASE}/internal/agent-runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`createAgentRun failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

export async function cancelAgentRun(runId) {
  const resp = await fetch(
    `${BASE}/internal/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', headers: internalHeaders() },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`cancelAgentRun failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

export async function getAgentRun(runId) {
  const resp = await fetch(
    `${BASE}/internal/agent-runs/${encodeURIComponent(runId)}`,
    { headers: internalHeaders() },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`getAgentRun failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

/**
 * Open SSE event stream for a run.
 * @returns {Promise<Response>}
 */
export async function openAgentRunEvents(runId, after = 0, { signal } = {}) {
  const url = `${BASE}/internal/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`;
  const resp = await fetch(url, {
    headers: {
      Accept: 'text/event-stream',
      ...(config.AGENT_INTERNAL_TOKEN
        ? { 'X-Internal-Token': config.AGENT_INTERNAL_TOKEN }
        : {}),
    },
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => resp.statusText);
    throw new Error(`openAgentRunEvents failed (${resp.status}): ${text}`);
  }
  return resp;
}
