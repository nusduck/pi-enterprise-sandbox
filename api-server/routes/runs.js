/**
 * Run control routes (ADR §4.7 / §10):
 *   POST /api/runs/:id/steer
 *   POST /api/runs/:id/follow-up
 *   POST /api/runs/:id/cancel  (optional thin wrapper)
 *   GET  /api/runs/:id
 *
 * BFF proxies to Agent internal APIs. Conversation scoping is enforced
 * by the Agent run-manager (rejects mismatched conversation_id).
 */
import {
  createAgentRun,
  openAgentRunEvents,
  steerAgentRun,
  followUpAgentRun,
  cancelAgentRun,
  getAgentRun,
  resumeAgentRunApproval,
  respondAgentInteraction,
} from '../services/agent-client.js';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';
import { authorizeRunRequest, resolveTrustedAuth } from '../application/run-access-service.js';
import { sendError, sendJson as json } from '../http/response.js';

/**
 * Coerce a timestamp to an ISO 8601 string for the public wire contract.
 * Accepts epoch milliseconds (Agent live runs), ISO strings (Sandbox rows),
 * or Date. Returns null when the value is missing or unusable.
 * @param {unknown} value
 * @returns {string|null}
 */
export function toIsoTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return null;
}

/**
 * Merge persisted Sandbox run detail with optional Agent live snapshot.
 * Ensures created_at / updated_at are always ISO strings or null so the
 * frontend RunDetailSchema never sees Agent epoch-ms numbers.
 * @param {object|null|undefined} persisted
 * @param {object|null|undefined} live
 * @param {boolean} runtimeAvailable
 */
export function presentRunDetail(persisted, live, runtimeAvailable) {
  const base = persisted && typeof persisted === 'object' ? persisted : {};
  const liveObj = live && typeof live === 'object' ? live : null;
  const body = liveObj
    ? { ...base, ...liveObj, runtime_available: runtimeAvailable }
    : { ...base, runtime_available: runtimeAvailable };
  body.created_at =
    toIsoTimestamp(liveObj?.created_at) ?? toIsoTimestamp(base.created_at);
  body.updated_at =
    toIsoTimestamp(liveObj?.updated_at) ?? toIsoTimestamp(base.updated_at);
  return body;
}

export async function handleCreateRun(body, res, req = null) {
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    json(res, 400, { error: 'messages array is required' });
    return;
  }
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await createAgentRun(
      {
        messages: body.messages,
        conversation_id: body.conversation_id || null,
        trace_id: traceId,
        agent_profile_id: body.agent_profile_id || undefined,
        budget: body.budget || undefined,
      },
      { auth, traceId },
    );
    if (traceId) res.setHeader('X-Trace-Id', traceId);
    json(res, 201, result);
  } catch (err) {
    sendError(res, err, traceId);
  }
}

export async function handleListRuns(parsedUrl, res, req = null) {
  const conversationId = parsedUrl.searchParams.get('conversation_id') || undefined;
  const status = parsedUrl.searchParams.get('status') || undefined;
  try {
    const client = createSandboxClient({ auth: authFromRequest(req) });
    const result = await client.listAgentRuns({ conversationId, status });
    json(res, 200, result);
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleRunEvents(runId, parsedUrl, res, req = null) {
  const after = Number.parseInt(
    parsedUrl.searchParams.get('after_sequence') ||
      parsedUrl.searchParams.get('after') ||
      req?.headers?.['last-event-id'] ||
      '0',
    10,
  ) || 0;
  const controller = new AbortController();
  req?.on('close', () => controller.abort());
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const upstream = await openAgentRunEvents(runId, after, {
      signal: controller.signal,
      auth,
      traceId: req?.traceId,
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
    }
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!res.headersSent) sendError(res, err, req?.traceId);
    else if (!res.writableEnded) res.end();
  }
}

/**
 * POST /api/runs/:id/steer  body: { text, conversation_id? }
 */
export async function handleSteerRun(runId, body, res, req = null) {
  const text = body?.text;
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  if (typeof text !== 'string' || !text.trim()) {
    json(res, 400, { error: 'text is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await steerAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    }, { auth, traceId: req?.traceId });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] steer:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/runs/:id/follow-up  body: { text, conversation_id? }
 */
export async function handleFollowUpRun(runId, body, res, req = null) {
  const text = body?.text;
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  if (typeof text !== 'string' || !text.trim()) {
    json(res, 400, { error: 'text is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await followUpAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    }, { auth, traceId: req?.traceId });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] follow-up:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/runs/:id/cancel
 */
export async function handleCancelRun(runId, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await cancelAgentRun(runId, { auth, traceId: req?.traceId });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] cancel:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/runs/:id
 */
export async function handleGetRun(runId, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const { auth, run } = await authorizeRunRequest(runId, req);
    try {
      const live = await getAgentRun(runId, { auth, traceId: req?.traceId });
      json(res, 200, presentRunDetail(run, live, true));
    } catch {
      // A durable run remains inspectable after the Agent evicts its bounded
      // live log or restarts. Returning the persisted row avoids a false 404;
      // the frontend then restores tools from the append-only event timeline.
      json(res, 200, presentRunDetail(run, null, false));
    }
  } catch (err) {
    console.error('[runs] get:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/runs/:id/tools — authoritative durable tool ledger snapshot.
 * Used after SSE reconnect exhaustion; unlike a closed stream this endpoint
 * never infers success from transport state.
 */
export async function handleListRunTools(runId, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const client = createSandboxClient({ auth });
    const result = await client.listToolExecutions({ runId });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] list tools:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/runs/:id/resume-approval  body: { decision, reason? }
 * Usually triggered automatically after approve/reject; exposed for recovery.
 */
export async function handleResumeApproval(runId, body, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await resumeAgentRunApproval(runId, body || {}, {
      auth,
      traceId: req?.traceId,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] resume-approval:', err.message);
    sendError(res, err, req?.traceId);
  }
}

export async function handleInteractionResponse(runId, interactionId, body, res, req = null) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'response')) {
    json(res, 400, { error: 'response is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await respondAgentInteraction(runId, interactionId, body, {
      auth,
      traceId: req?.traceId,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] interaction response:', err.message);
    sendError(res, err, req?.traceId);
  }
}
