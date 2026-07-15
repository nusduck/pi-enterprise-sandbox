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

function requestHeaders({ auth = null, traceId = null, extra = {} } = {}) {
  const headers = internalHeaders(extra);
  if (auth?.authorization) headers.Authorization = auth.authorization;
  if (auth?.actingUserId) headers['X-Acting-User-Id'] = auth.actingUserId;
  if (auth?.actingOrganizationId) {
    headers['X-Acting-Organization-Id'] = auth.actingOrganizationId;
  }
  if (auth?.actingRole) headers['X-Acting-Role'] = auth.actingRole;
  if (traceId) headers['X-Trace-Id'] = traceId;
  return headers;
}

/**
 * @param {{ messages: unknown[], conversation_id?: string|null, trace_id?: string|null }} body
 * @param {{ auth?: object|null, traceId?: string|null }} [opts]
 */
export async function createAgentRun(body, { auth = null, traceId = null } = {}) {
  const headers = requestHeaders({ auth, traceId });

  const resp = await fetch(`${config.AGENT_BASE_URL}/internal/agent-runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Preserve the raw response text for non-JSON Agent failures.
    }
    const message =
      typeof body?.error === 'string'
        ? body.error
        : `Agent create run failed (${resp.status}): ${text}`;
    const err = new Error(message);
    err.status = resp.status;
    if (typeof body?.code === 'string' && body.code) err.code = body.code;
    throw err;
  }
  return resp.json();
}

export async function getAgentExtensionDiagnostics(profileId = 'coding-agent') {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/extensions/diagnostics`);
  url.searchParams.set('profile_id', profileId);
  const resp = await fetch(url, { headers: internalHeaders() });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const error = new Error(`Agent diagnostics failed (${resp.status}): ${text}`);
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

/**
 * @param {string} runId
 */
export async function cancelAgentRun(runId, { auth = null, traceId = null } = {}) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST', headers: requestHeaders({ auth, traceId }) },
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
 * POST /internal/agent-runs/:id/steer
 * @param {string} runId
 * @param {{ text: string, conversation_id?: string|null }} body
 */
export async function steerAgentRun(runId, body, { auth = null, traceId = null } = {}) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/steer`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId }),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent steer failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * POST /internal/agent-runs/:id/follow-up
 * @param {string} runId
 * @param {{ text: string, conversation_id?: string|null }} body
 */
export async function followUpAgentRun(runId, body, { auth = null, traceId = null } = {}) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/follow-up`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId }),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent follow-up failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * POST /internal/agent-runs/:id/resume-approval
 * @param {string} runId
 * @param {object} body
 */
export async function resumeAgentRunApproval(
  runId,
  body = {},
  { auth = null, traceId = null } = {},
) {
  const headers = requestHeaders({ auth, traceId });
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/resume-approval`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent resume-approval failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function respondAgentInteraction(
  runId,
  interactionId,
  body,
  { auth = null, traceId = null } = {},
) {
  const headers = requestHeaders({ auth, traceId });
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}` +
      `/interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent interaction response failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * Notify agent of an approval decision (wakes waiter / resumes run).
 * @param {string} approvalId
 * @param {{ decision: string, run_id?: string, reason?: string }} body
 */
export async function decideAgentApproval(
  approvalId,
  body,
  { auth = null, traceId = null } = {},
) {
  const headers = requestHeaders({ auth, traceId });
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent approval decide failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * @param {string} runId
 */
export async function getAgentRun(runId, { auth = null, traceId = null } = {}) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}`,
    { headers: requestHeaders({ auth, traceId }) },
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
export async function openAgentRunEvents(
  runId,
  after = 0,
  { signal, auth = null, traceId = null } = {},
) {
  const url = `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/events?after=${after}`;
  const headers = requestHeaders({
    auth,
    traceId,
    extra: { Accept: 'text/event-stream' },
  });
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
