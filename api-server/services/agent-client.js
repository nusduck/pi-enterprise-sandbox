/**
 * BFF → Agent service HTTP client.
 * Creates runs, streams sequenced SSE events, and cancels.
 */
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import {
  boundRequestTraceContext,
  normalizeTraceId,
  normalizeTracestate,
  traceCarrierHeaders,
} from '../application/trace-context.js';

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
 * Build a W3C traceparent with non-zero random span-id (8 bytes / 16 hex).
 * All-zero span-id is illegal per W3C Trace Context.
 * @param {string} traceId32 — lowercase 32-hex non-zero
 * @returns {string}
 */
export function buildTraceparent(traceId32) {
  const tid = String(traceId32).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(tid) || tid === '0'.repeat(32)) {
    throw new Error('traceId must be 32 non-zero hex chars');
  }
  let span = randomBytes(8).toString('hex');
  // Extremely unlikely all-zero; regenerate once.
  if (span === '0'.repeat(16)) span = randomBytes(8).toString('hex');
  return `00-${tid}-${span}-01`;
}

function requestHeaders({
  auth = null,
  traceId = null,
  traceContext = null,
  traceparent = null,
  tracestate = null,
  idempotencyKey = null,
  extra = {},
} = {}) {
  const headers = internalHeaders(extra);
  if (auth?.authorization) headers.Authorization = auth.authorization;
  if (auth?.actingUserId) headers['X-Acting-User-Id'] = auth.actingUserId;
  if (auth?.actingOrganizationId) {
    headers['X-Acting-Organization-Id'] = auth.actingOrganizationId;
  }
  if (auth?.actingRole) headers['X-Acting-Role'] = auth.actingRole;
  const requestId =
    typeof auth?.requestId === 'string' && auth.requestId.trim()
      ? auth.requestId.trim()
      : null;
  if (requestId) headers['X-Request-Id'] = requestId;
  // Prefer the request's bound W3C carrier. This preserves both the parent
  // span and tracestate across every BFF → Agent call, while retaining the
  // generated-child fallback for direct unit callers and legacy X-Trace-Id.
  const bound =
    traceContext ||
    (traceparent || tracestate
      ? { traceId, spanId: null, traceparent, tracestate }
      : boundRequestTraceContext(auth));
  if (bound?.traceparent && typeof bound.traceparent === 'string') {
    const tid = normalizeTraceId(bound.traceId || traceId);
    if (tid) {
      headers.traceparent = String(bound.traceparent);
      headers['X-Trace-Id'] = tid;
      const state = normalizeTracestate(bound.tracestate || tracestate);
      if (state) headers.tracestate = state;
    }
  } else if (bound?.spanId && bound?.traceId) {
    try {
      Object.assign(headers, traceCarrierHeaders(bound));
    } catch {
      // Fall through to the generated-child path below.
    }
  } else if (traceId && /^[0-9a-fA-F]{32}$/.test(String(traceId))) {
    const tid = String(traceId).toLowerCase();
    if (tid !== '0'.repeat(32)) {
      try {
        headers.traceparent = buildTraceparent(tid);
      } catch {
        // Fall through to X-Trace-Id only.
      }
      headers['X-Trace-Id'] = tid;
    }
  } else if (traceId) {
    headers['X-Trace-Id'] = String(traceId);
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = String(idempotencyKey);
  }
  return headers;
}

/**
 * @param {{ messages: unknown[], conversation_id?: string|null, trace_id?: string|null }} body
 * @param {{ auth?: object|null, traceId?: string|null, idempotencyKey?: string|null }} [opts]
 */
export async function createAgentRun(
  body,
  { auth = null, traceId = null, idempotencyKey = null } = {},
) {
  const headers = requestHeaders({ auth, traceId, idempotencyKey });

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

export async function getAgentExtensionDiagnostics(
  profileId = 'coding-agent',
  { auth = null, traceId = null } = {},
) {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/extensions/diagnostics`);
  url.searchParams.set('profile_id', profileId);
  const resp = await fetch(url, { headers: requestHeaders({ auth, traceId }) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const error = new Error(`Agent diagnostics failed (${resp.status}): ${text}`);
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

async function requestAgentA2aAdmin(
  path,
  { method = 'GET', body = null, auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/a2a/${path.replace(/^\/+/, '')}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent A2A admin request failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

export async function getAgentA2aConfig(
  agentId = null,
  { auth = null, traceId = null } = {},
) {
  const query = agentId
    ? `config?agent_id=${encodeURIComponent(agentId)}`
    : 'config';
  return requestAgentA2aAdmin(query, { auth, traceId });
}

export async function issueAgentA2aCredential(
  body,
  { auth = null, traceId = null } = {},
) {
  return requestAgentA2aAdmin('credentials', {
    method: 'POST',
    body,
    auth,
    traceId,
  });
}

export async function rotateAgentA2aCredential(
  credentialId,
  body,
  { auth = null, traceId = null } = {},
) {
  return requestAgentA2aAdmin(
    `credentials/${encodeURIComponent(credentialId)}/rotate`,
    { method: 'POST', body, auth, traceId },
  );
}

export async function revokeAgentA2aCredential(
  credentialId,
  { auth = null, traceId = null } = {},
) {
  return requestAgentA2aAdmin(
    `credentials/${encodeURIComponent(credentialId)}/revoke`,
    { method: 'POST', body: {}, auth, traceId },
  );
}

async function requestAgentConversation(
  path,
  { method = 'GET', body = null, auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/conversations${path}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent conversation request failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export async function listAgentConversations(
  { auth = null, traceId = null } = {},
) {
  return requestAgentConversation('', { auth, traceId });
}

export async function getAgentConversation(
  conversationId,
  { auth = null, traceId = null } = {},
) {
  return requestAgentConversation(`/${encodeURIComponent(conversationId)}`, {
    auth,
    traceId,
  });
}

export async function createAgentConversation(
  body,
  { auth = null, traceId = null } = {},
) {
  return requestAgentConversation('', {
    method: 'POST',
    body,
    auth,
    traceId,
  });
}

export async function deleteAgentConversation(
  conversationId,
  { auth = null, traceId = null } = {},
) {
  await requestAgentConversation(`/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    auth,
    traceId,
  });
}

export async function ensureAgentSession(
  conversationId = null,
  { auth = null, traceId = null } = {},
) {
  const body = conversationId ? { conversation_id: conversationId } : {};
  const resp = await fetch(`${config.AGENT_BASE_URL}/internal/sessions/ensure`, {
    method: 'POST',
    headers: requestHeaders({ auth, traceId }),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent session ensure failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

/**
 * Resolve one SandboxSession through Agent's external-identity mapping.
 * The response contains internal owner ULIDs and must remain server-side.
 */
export async function resolveAgentSandboxSession(
  sandboxSessionId,
  { auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/sessions/${encodeURIComponent(sandboxSessionId)}`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent session access failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

/**
 * List runs for the trusted acting owner (Agent MySQL owner scope).
 * @param {{ conversationId?: string, status?: string, limit?: number }} [query]
 * @param {{ auth?: object|null, traceId?: string|null }} [opts]
 */
export async function listAgentRuns(
  query = {},
  { auth = null, traceId = null } = {},
) {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/agent-runs`);
  if (query.conversationId) {
    url.searchParams.set('conversation_id', query.conversationId);
  }
  if (query.status) url.searchParams.set('status', query.status);
  if (query.limit) url.searchParams.set('limit', String(query.limit));
  const resp = await fetch(url, {
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent list runs failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * @param {string} runId
 * @param {{ auth?: object|null, traceId?: string|null, idempotencyKey?: string|null }} [opts]
 */
export async function cancelAgentRun(
  runId,
  { auth = null, traceId = null, idempotencyKey = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
    },
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
export async function steerAgentRun(
  runId,
  body,
  { auth = null, traceId = null, idempotencyKey = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/steer`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
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
export async function followUpAgentRun(
  runId,
  body,
  { auth = null, traceId = null, idempotencyKey = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/follow-up`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
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
 * POST /internal/conversations/:id/follow-ups
 * @param {string} conversationId
 * @param {{ text: string, agent_id?: string|null }} body
 */
export async function createConversationFollowUp(
  conversationId,
  body,
  { auth = null, traceId = null, idempotencyKey = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/conversations/${encodeURIComponent(conversationId)}/follow-ups`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(
      `Agent conversation follow-up failed (${resp.status}): ${text}`,
    );
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

async function requestAgentApproval(
  path,
  { auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/approvals${path}`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent approval request failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

/** List owner-scoped durable approvals from Agent MySQL. */
export async function listAgentApprovals(
  { status = null, limit = null } = {},
  { auth = null, traceId = null } = {},
) {
  const query = new URLSearchParams();
  if (status) query.set('status', String(status));
  if (limit != null) query.set('limit', String(limit));
  const suffix = query.size ? `?${query}` : '';
  return requestAgentApproval(suffix, { auth, traceId });
}

/** Load one owner-scoped durable approval from Agent MySQL. */
export async function getAgentApproval(
  approvalId,
  { auth = null, traceId = null } = {},
) {
  return requestAgentApproval(`/${encodeURIComponent(approvalId)}`, {
    auth,
    traceId,
  });
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

/** Load the owner-scoped durable trace projection for one Run. */
export async function getAgentRunTrace(
  runId,
  { auth = null, traceId = null, limit = null, cursor = null } = {},
) {
  const url = new URL(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/trace`,
  );
  if (limit != null) url.searchParams.set('limit', String(limit));
  if (cursor != null && String(cursor).trim()) {
    url.searchParams.set('cursor', String(cursor).trim());
  }
  const resp = await fetch(url, {
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent trace request failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

/**
 * List the owner-scoped durable ToolExecution ledger from Agent MySQL.
 * @param {string} runId
 * @param {{ auth?: object|null, traceId?: string|null }} [opts]
 */
export async function listAgentToolExecutions(
  runId,
  { auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/tools`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(
      `Agent list tool executions failed (${resp.status}): ${text}`,
    );
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function requestAgentProcess(
  path,
  { method = 'GET', body = null, auth = null, traceId = null } = {},
) {
  const resp = await fetch(
    `${config.AGENT_BASE_URL}/internal/processes${path}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}));
    const err = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent process request failed (${resp.status})`,
    );
    err.status = resp.status;
    if (typeof payload.code === 'string') err.code = payload.code;
    throw err;
  }
  return resp.json();
}

export async function listAgentProcesses(query = {}, opts = {}) {
  const params = new URLSearchParams();
  if (query.runId) params.set('run_id', query.runId);
  if (query.sessionId) params.set('session_id', query.sessionId);
  if (query.status) params.set('status', query.status);
  if (query.limit) params.set('limit', query.limit);
  const qs = params.toString();
  return requestAgentProcess(qs ? `?${qs}` : '', opts);
}

export async function getAgentProcess(processId, opts = {}) {
  return requestAgentProcess(`/${encodeURIComponent(processId)}`, opts);
}

export async function getAgentProcessLogs(processId, query = {}, opts = {}) {
  const params = new URLSearchParams();
  if (query.offset != null) params.set('offset', query.offset);
  if (query.limit != null) params.set('limit', query.limit);
  const qs = params.toString();
  return requestAgentProcess(
    `/${encodeURIComponent(processId)}/logs${qs ? `?${qs}` : ''}`,
    opts,
  );
}

export async function readAgentProcess(processId, query = {}, opts = {}) {
  const params = new URLSearchParams();
  if (query.stream) params.set('stream', query.stream);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit != null) params.set('limit', query.limit);
  const qs = params.toString();
  return requestAgentProcess(
    `/${encodeURIComponent(processId)}/read${qs ? `?${qs}` : ''}`,
    opts,
  );
}

export async function writeAgentProcessStdin(processId, body, opts = {}) {
  return requestAgentProcess(`/${encodeURIComponent(processId)}/stdin`, {
    ...opts,
    method: 'POST',
    body,
  });
}

export async function signalAgentProcess(processId, body, opts = {}) {
  return requestAgentProcess(`/${encodeURIComponent(processId)}/signal`, {
    ...opts,
    method: 'POST',
    body,
  });
}

export async function cancelAgentProcess(processId, opts = {}) {
  return requestAgentProcess(`/${encodeURIComponent(processId)}/cancel`, {
    ...opts,
    method: 'POST',
    body: {},
  });
}

/**
 * List historical run events as JSON (Agent MySQL authority).
 * Uses GET .../events?format=json — not Sandbox agent_runs dual path.
 *
 * @param {string} runId
 * @param {{ afterSequence?: number, limit?: number }} [query]
 * @param {{ auth?: object|null, traceId?: string|null }} [opts]
 */
export async function listAgentEvents(
  runId,
  query = {},
  { auth = null, traceId = null } = {},
) {
  const url = new URL(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/events`,
  );
  url.searchParams.set('format', 'json');
  const after = Math.max(0, Number(query.afterSequence) || 0);
  if (after > 0) {
    url.searchParams.set('after', String(after));
    url.searchParams.set('afterSequence', String(after));
  }
  if (query.limit != null && Number.isFinite(Number(query.limit))) {
    url.searchParams.set('limit', String(query.limit));
  }
  const resp = await fetch(url, { headers: requestHeaders({ auth, traceId }) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent list events failed (${resp.status}): ${text}`);
    err.status = resp.status;
    throw err;
  }
  const page = await resp.json();
  // Normalize to array for timeline consumers (page.events or raw array).
  if (Array.isArray(page)) return page;
  if (Array.isArray(page?.events)) return page.events;
  return [];
}

/**
 * Open SSE event stream for a run (sequenced envelopes).
 * Agent owns MySQL history + Redis live cutover (PR-10). BFF proxies bytes.
 *
 * @param {string} runId
 * @param {number} [after]
 * @param {{
 *   signal?: AbortSignal,
 *   auth?: object|null,
 *   traceId?: string|null,
 *   lastEventId?: string|null,
 * }} [opts]
 * @returns {Promise<Response>}
 */
export async function openAgentRunEvents(
  runId,
  after = 0,
  { signal, auth = null, traceId = null, lastEventId = null } = {},
) {
  const qs = new URLSearchParams();
  const afterSeq = Math.max(0, Number(after) || 0);
  if (afterSeq > 0) {
    qs.set('after', String(afterSeq));
    qs.set('afterSequence', String(afterSeq));
  }
  const q = qs.toString();
  const url =
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/events` +
    (q ? `?${q}` : '');
  const extra = { Accept: 'text/event-stream' };
  if (lastEventId && String(lastEventId).trim()) {
    extra['Last-Event-ID'] = String(lastEventId).trim();
  }
  const headers = requestHeaders({
    auth,
    traceId,
    extra,
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
