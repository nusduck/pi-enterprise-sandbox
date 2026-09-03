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

/**
 * One BFF → Agent request, bounded by AGENT_REQUEST_TIMEOUT_MS.
 *
 * `fetch` has no default timeout: an upstream that accepts the connection and
 * never answers holds the caller — and the browser request behind it — open
 * indefinitely. Every non-streaming call goes through here so a stuck Agent
 * degrades into 504s instead of exhausted sockets. The SSE relay is the
 * deliberate exception: it is long-lived by design and is bounded by the
 * client connection's own signal.
 *
 * @param {string | URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function agentFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const timeoutMs = config.AGENT_REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (timeout.aborted && !init.signal?.aborted) {
      const error: any = new Error(
        `Agent request timed out after ${timeoutMs}ms: ${new URL(String(url)).pathname}`,
      );
      error.status = 504;
      error.code = 'AGENT_TIMEOUT';
      error.cause = err;
      throw error;
    }
    throw err;
  }
}

function internalHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
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
export function buildTraceparent(traceId32: string): string {
  const tid = String(traceId32).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(tid) || tid === '0'.repeat(32)) {
    throw new Error('traceId must be 32 non-zero hex chars');
  }
  let span = randomBytes(8).toString('hex');
  // Extremely unlikely all-zero; regenerate once.
  if (span === '0'.repeat(16)) span = randomBytes(8).toString('hex');
  return `00-${tid}-${span}-01`;
}

export interface RequestHeadersOptions {
  auth?: any;
  traceId?: string | null;
  traceContext?: any;
  traceparent?: string | null;
  tracestate?: string | null;
  idempotencyKey?: string | null;
  extra?: Record<string, string>;
}

export function requestHeaders({
  auth = null,
  traceId = null,
  traceContext = null,
  traceparent = null,
  tracestate = null,
  idempotencyKey = null,
  extra = {},
}: RequestHeadersOptions = {}): Record<string, string> {
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
 * @param {{ messages: unknown[], conversation_id?: string|null, trace_id?: string|null, model_id?: string|null }} body
 * @param {{ auth?: object|null, traceId?: string|null, idempotencyKey?: string|null }} [opts]
 */
export async function createAgentRun(
  body: any,
  { auth = null, traceId = null, idempotencyKey = null }: { auth?: any; traceId?: string | null; idempotencyKey?: string | null } = {},
): Promise<any> {
  const headers = requestHeaders({ auth, traceId, idempotencyKey });

  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/agent-runs`, {
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
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = resp.status;
    if (typeof body?.code === 'string' && body.code) err.code = body.code;
    throw err;
  }
  return resp.json();
}

export async function getAgentExtensionDiagnostics(
  profileId: string = 'coding-agent',
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/extensions/diagnostics`);
  url.searchParams.set('profile_id', profileId);
  const resp = await agentFetch(url, { headers: requestHeaders({ auth, traceId }) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const error = new Error(`Agent diagnostics failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    error.status = resp.status;
    throw error;
  }
  return resp.json();
}

export async function mutateAgentSkill(
  name: string,
  action: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  if (action !== 'enable' && action !== 'disable') {
    throw new Error('Skill action must be enable or disable');
  }
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/skills/${encodeURIComponent(name)}/${action}`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId }),
    },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent Skill mutation failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

export async function uploadAgentSkillDraft(
  body: any,
  filename: string,
  { auth = null, traceId = null, signal = null }: { auth?: any; traceId?: string | null; signal?: AbortSignal | null } = {},
): Promise<any> {
  const extra = {
    'X-Filename': String(filename || 'skill.zip'),
    'Content-Type': 'application/octet-stream',
  };
  const headers = requestHeaders({ auth, traceId, extra });
  const isStream = body && typeof body.pipe === 'function';
  const fetchOpts: RequestInit = {
    method: 'POST',
    headers,
    body,
    signal,
  };
  if (isStream) {
    (fetchOpts as any).duplex = 'half';
  }
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/skills/drafts`,
    fetchOpts,
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent Skill draft upload failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

async function requestAgentA2aAdmin(
  path: string,
  { method = 'GET', body = null, auth = null, traceId = null }: { method?: string; body?: any; auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/a2a/${path.replace(/^\/+/, '')}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  agentId: string | null = null,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = agentId
    ? `config?agent_id=${encodeURIComponent(agentId)}`
    : 'config';
  return requestAgentA2aAdmin(query, { auth, traceId });
}

export async function issueAgentA2aCredential(
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentA2aAdmin('credentials', {
    method: 'POST',
    body,
    auth,
    traceId,
  });
}

export async function rotateAgentA2aCredential(
  credentialId: string,
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentA2aAdmin(
    `credentials/${encodeURIComponent(credentialId)}/rotate`,
    { method: 'POST', body, auth, traceId },
  );
}

export async function revokeAgentA2aCredential(
  credentialId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentA2aAdmin(
    `credentials/${encodeURIComponent(credentialId)}/revoke`,
    { method: 'POST', body: {}, auth, traceId },
  );
}

async function requestAgentConversation(
  path: string,
  { method = 'GET', body = null, auth = null, traceId = null }: { method?: string; body?: any; auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/conversations${path}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentConversation('', { auth, traceId });
}

export async function getAgentConversation(
  conversationId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentConversation(`/${encodeURIComponent(conversationId)}`, {
    auth,
    traceId,
  });
}

export async function createAgentConversation(
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentConversation('', {
    method: 'POST',
    body,
    auth,
    traceId,
  });
}

export async function deleteAgentConversation(
  conversationId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<void> {
  await requestAgentConversation(`/${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
    auth,
    traceId,
  });
}

export async function ensureAgentSession(
  conversationId: string | null = null,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const body = conversationId ? { conversation_id: conversationId } : {};
  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/sessions/ensure`, {
    method: 'POST',
    headers: requestHeaders({ auth, traceId }),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  sandboxSessionId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/sessions/${encodeURIComponent(sandboxSessionId)}`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  query: Record<string, any> = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/agent-runs`);
  if (query.conversationId) {
    url.searchParams.set('conversation_id', query.conversationId);
  }
  if (query.status) url.searchParams.set('status', query.status);
  if (query.limit) url.searchParams.set('limit', String(query.limit));
  const resp = await agentFetch(url, {
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent list runs failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function requestAgentCron(
  path: string,
  { method = 'GET', body = null, auth = null, traceId = null }: { method?: string; body?: any; auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/cron-jobs${path}`,
    {
      method,
      headers: requestHeaders({ auth, traceId }),
      body: body == null ? undefined : JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent cron request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  if (resp.status === 204) return null;
  return resp.json();
}


export async function listAgentCronJobs(
  { limit }: { limit?: number | string } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return requestAgentCron(query, { auth, traceId });
}

export async function createAgentCronJob(body: any, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<any> {
  return requestAgentCron('', { method: 'POST', body, auth, traceId });
}

export async function getAgentCronJob(cronJobId: string, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<any> {
  return requestAgentCron(`/${encodeURIComponent(cronJobId)}`, { auth, traceId });
}

export async function updateAgentCronJob(cronJobId: string, body: any, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<any> {
  return requestAgentCron(`/${encodeURIComponent(cronJobId)}`, {
    method: 'PATCH', body, auth, traceId,
  });
}

export async function deleteAgentCronJob(cronJobId: string, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<void> {
  await requestAgentCron(`/${encodeURIComponent(cronJobId)}`, {
    method: 'DELETE', auth, traceId,
  });
}

export async function runAgentCronJob(cronJobId: string, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<any> {
  return requestAgentCron(`/${encodeURIComponent(cronJobId)}/run`, {
    method: 'POST', body: {}, auth, traceId,
  });
}

export async function listAgentCronJobRuns(
  cronJobId: string,
  { limit }: { limit?: number | string } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return requestAgentCron(`/${encodeURIComponent(cronJobId)}/runs${query}`, {
    auth, traceId,
  });
}

/**
 * @param {string} runId
 * @param {{ auth?: object|null, traceId?: string|null, idempotencyKey?: string|null }} [opts]
 */
export async function cancelAgentRun(
  runId: string,
  { auth = null, traceId = null, idempotencyKey = null }: { auth?: any; traceId?: string | null; idempotencyKey?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent cancel failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
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
  runId: string,
  body: any,
  { auth = null, traceId = null, idempotencyKey = null }: { auth?: any; traceId?: string | null; idempotencyKey?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/steer`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent steer failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
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
  conversationId: string,
  body: any,
  { auth = null, traceId = null, idempotencyKey = null }: { auth?: any; traceId?: string | null; idempotencyKey?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/conversations/${encodeURIComponent(conversationId)}/follow-ups`,
    {
      method: 'POST',
      headers: requestHeaders({ auth, traceId, idempotencyKey }),
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err: any = new Error(
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
  runId: string,
  body: any = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const headers = requestHeaders({ auth, traceId });
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/resume-approval`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent resume-approval failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

export async function respondAgentInteraction(
  runId: string,
  interactionId: string,
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const headers = requestHeaders({ auth, traceId });
  const resp = await agentFetch(
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
    const err = new Error(`Agent interaction response failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
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
  approvalId: string,
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const headers = requestHeaders({ auth, traceId });
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent approval decide failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

async function requestAgentApproval(
  path: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/approvals${path}`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  { status = null, limit = null }: { status?: string | null; limit?: number | string | null } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = new URLSearchParams();
  if (status) query.set('status', String(status));
  if (limit != null) query.set('limit', String(limit));
  const suffix = query.size ? `?${query}` : '';
  return requestAgentApproval(suffix, { auth, traceId });
}

/** Load one owner-scoped durable approval from Agent MySQL. */
export async function getAgentApproval(
  approvalId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentApproval(`/${encodeURIComponent(approvalId)}`, {
    auth,
    traceId,
  });
}

/**
 * @param {string} runId
 */
export async function getAgentRun(runId: string, { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {}): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent get run failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/** Load the owner-scoped durable trace projection for one Run. */
export async function getAgentRunTrace(
  runId: string,
  { auth = null, traceId = null, limit = null, cursor = null }: { auth?: any; traceId?: string | null; limit?: number | string | null; cursor?: string | null } = {},
): Promise<any> {
  const url = new URL(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/trace`,
  );
  if (limit != null) url.searchParams.set('limit', String(limit));
  if (cursor != null && String(cursor).trim()) {
    url.searchParams.set('cursor', String(cursor).trim());
  }
  const resp = await agentFetch(url, {
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const err: any = new Error(
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
  runId: string,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/tools`,
    { headers: requestHeaders({ auth, traceId }) },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err: any = new Error(
      `Agent list tool executions failed (${resp.status}): ${text}`,
    );
    err.status = resp.status;
    throw err;
  }
  return resp.json();
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
  runId: string,
  query: { afterSequence?: number; limit?: number } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const url = new URL(
    `${config.AGENT_BASE_URL}/internal/agent-runs/${encodeURIComponent(runId)}/events`,
  );
  url.searchParams.set('format', 'json');
  const after = Math.max(0, Number(query.afterSequence) || 0);
  if (after > 0) {
    url.searchParams.set('after', String(after));
    url.searchParams.set('afterSequence', String(after));
  }
  // Default page size matches Agent query-service max so a single page covers
  // more history; conversation-timeline still paginates when needed.
  const limit =
    query.limit != null && Number.isFinite(Number(query.limit))
      ? Number(query.limit)
      : 500;
  url.searchParams.set('limit', String(limit));
  const resp = await agentFetch(url, { headers: requestHeaders({ auth, traceId }) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => resp.statusText);
    const err = new Error(`Agent list events failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  const page: any = await resp.json();
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
  runId: string,
  after: number = 0,
  { signal, auth = null, traceId = null, lastEventId = null }: { signal?: AbortSignal; auth?: any; traceId?: string | null; lastEventId?: string | null } = {},
): Promise<Response> {
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
  const extra: Record<string, string> = { Accept: 'text/event-stream' };
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
    const err = new Error(`Agent events failed (${resp.status}): ${text}`) as Error & { status?: number; code?: string };
    err.status = resp.status;
    throw err;
  }
  return resp;
}

/**
 * Agent service liveness probe.
 * @returns {Promise<object|null>}
 */
export async function checkAgentHealth(): Promise<any> {
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
