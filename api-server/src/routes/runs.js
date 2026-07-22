/**
 * Run control routes (ADR §4.7 / §10 / plan §18 PR-10):
 *   POST /api/runs
 *   POST /api/conversations/:conversationId/runs
 *   GET  /api/runs/:id
 *   GET  /api/runs/:id/events  (SSE proxy — Agent MySQL+Redis replay)
 *   POST /api/runs/:id/steer|follow-up|cancel
 *
 * BFF: auth, ownership, idempotency key passthrough, SSE cursor, DTO.
 * Agent MySQL is Run/event fact source; Redis is live notify only.
 * Sandbox is not Run authority.
 */
import {
  createAgentRun,
  openAgentRunEvents,
  steerAgentRun,
  followUpAgentRun,
  createConversationFollowUp,
  cancelAgentRun,
  getAgentRun,
  getAgentRunTrace,
  resumeAgentRunApproval,
  respondAgentInteraction,
  listAgentRuns,
  listAgentToolExecutions,
} from '../services/agent-client.js';
import { authorizeRunRequest, resolveTrustedAuth } from '../application/run-access-service.js';
import {
  parseSseResumeCursor,
  presentCreateRunAccepted,
} from '../application/event-replay-service.js';
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
  body.started_at =
    toIsoTimestamp(liveObj?.started_at) ??
    toIsoTimestamp(liveObj?.startedAt) ??
    toIsoTimestamp(base.started_at);
  const completedAt =
    toIsoTimestamp(liveObj?.completed_at) ??
    toIsoTimestamp(liveObj?.completedAt) ??
    toIsoTimestamp(liveObj?.finished_at) ??
    toIsoTimestamp(base.completed_at) ??
    toIsoTimestamp(base.finished_at);
  body.completed_at = completedAt;
  body.finished_at = completedAt;
  // Agent's durable failure reason is exposed as status_reason/statusReason.
  // The frontend Run detail contract uses `error`, so preserve the reason
  // rather than replacing a real provider/runtime failure with "Run failed".
  body.error =
    body.error ??
    liveObj?.status_reason ??
    liveObj?.statusReason ??
    base.status_reason ??
    base.statusReason ??
    null;
  return body;
}

/**
 * Read Idempotency-Key from request headers (required for create/cancel).
 * @param {import('node:http').IncomingMessage | null} req
 * @returns {string|null}
 */
export function readIdempotencyKeyHeader(req) {
  const h =
    req?.headers?.['idempotency-key'] ||
    req?.headers?.['Idempotency-Key'] ||
    req?.headers?.['x-idempotency-key'] ||
    null;
  if (h == null) return null;
  const s = String(h).trim();
  return s || null;
}

/**
 * Normalize create body. Supports plan §18.3 `message.content[]` and legacy
 * `messages[]`. Optional conversationId binds the run to a conversation.
 *
 * @param {object} body
 * @param {{ conversationId?: string|null }} [opts]
 * @returns {{ messages: unknown[], conversation_id: string|null, agent_profile_id?: string, budget?: unknown } | { error: string }}
 */
export function normalizeCreateRunBody(body, opts = {}) {
  let messages = body?.messages;
  if ((!Array.isArray(messages) || messages.length === 0) && body?.message) {
    const msg = body.message;
    if (typeof msg === 'string' && msg.trim()) {
      messages = [{ role: 'user', content: msg.trim() }];
    } else if (msg && typeof msg === 'object') {
      const content = msg.content ?? msg.text;
      if (typeof content === 'string' && content.trim()) {
        messages = [{ role: 'user', content: content.trim() }];
      } else if (Array.isArray(content) && content.length > 0) {
        const textParts = content
          .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
          .map((p) => String(p.text || ''))
          .filter(Boolean);
        const text = textParts.join('\n').trim();
        if (text) messages = [{ role: 'user', content: text }];
      }
    }
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: 'messages array is required (or message.content text)' };
  }
  const conversationId =
    opts.conversationId ||
    body.conversation_id ||
    body.conversationId ||
    null;
  return {
    messages,
    conversation_id: conversationId,
    agent_profile_id: body.agent_profile_id || body.agentProfileId || undefined,
    budget: body.budget || undefined,
  };
}

export async function handleCreateRun(body, res, req = null, routeOpts = {}) {
  const normalized = normalizeCreateRunBody(body, routeOpts);
  if (normalized.error) {
    json(res, 400, { error: normalized.error });
    return;
  }
  const traceId = req?.traceId || null;
  const idempotencyKey = readIdempotencyKeyHeader(req);
  if (!idempotencyKey) {
    json(res, 400, {
      error: 'Idempotency-Key header is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    return;
  }
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await createAgentRun(
      {
        messages: normalized.messages,
        conversation_id: normalized.conversation_id,
        trace_id: traceId,
        agent_profile_id: normalized.agent_profile_id,
        budget: normalized.budget,
      },
      {
        auth,
        traceId,
        idempotencyKey,
      },
    );
    if (traceId) res.setHeader('X-Trace-Id', traceId);
    // Agent persists before 202 — never 201 (run not yet durable). plan §18.3
    json(res, 202, presentCreateRunAccepted(result));
  } catch (err) {
    sendError(res, err, traceId);
  }
}

export async function handleListRuns(parsedUrl, res, req = null) {
  const conversationId = parsedUrl.searchParams.get('conversation_id') || undefined;
  const status = parsedUrl.searchParams.get('status') || undefined;
  try {
    // Agent MySQL owner-scoped list — Sandbox agent_runs is not the fact source.
    const auth = await resolveTrustedAuth(req);
    const result = await listAgentRuns(
      { conversationId, status },
      { auth, traceId: req?.traceId },
    );
    json(res, 200, result);
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

/**
 * Abort-aware wait for Node HTTP response drain.
 * Resolves on drain | close | error | abort; always removes listeners.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {{ signal?: AbortSignal | null, isClosed?: () => boolean }} [opts]
 * @returns {Promise<'drained' | 'closed' | 'aborted'>}
 */
export function waitForResponseDrain(res, opts = {}) {
  const signal = opts.signal ?? null;
  const isClosed =
    opts.isClosed ??
    (() => Boolean(res.writableEnded || res.destroyed || res.closed));

  if (signal?.aborted) return Promise.resolve('aborted');
  if (isClosed()) return Promise.resolve('closed');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onDrain = () => finish('drained');
    const onClose = () => finish('closed');
    const onError = () => finish('closed');
    const onAbort = () => finish('aborted');

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (signal) signal.addEventListener('abort', onAbort);

    // Race: already closed / aborted after attach.
    if (signal?.aborted) finish('aborted');
    else if (isClosed()) finish('closed');
  });
}

/**
 * Proxy an upstream SSE ReadableStream body onto a Node ServerResponse with
 * backpressure and disconnect cleanup. Does **not** cancel the Agent Run —
 * only cancels this HTTP subscription's body reader.
 *
 * Exported for unit tests.
 *
 * @param {{
 *   reader: { read: Function, cancel?: Function, releaseLock?: Function },
 *   res: import('node:http').ServerResponse,
 *   signal?: AbortSignal | null,
 * }} opts
 * @returns {Promise<void>}
 */
export async function proxySseUpstream({ reader, res, signal = null }) {
  const isClosed = () =>
    Boolean(res.writableEnded || res.destroyed || res.closed || signal?.aborted);

  try {
    while (true) {
      if (isClosed()) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (isClosed()) break;
      let ok = true;
      try {
        ok = res.write(value);
      } catch {
        break;
      }
      if (ok === false) {
        const outcome = await waitForResponseDrain(res, { signal, isClosed });
        if (outcome !== 'drained' || isClosed()) break;
      }
    }
  } finally {
    // Cancel upstream body (subscription only — not the Run) and drop lock.
    try {
      if (typeof reader.cancel === 'function') {
        await reader.cancel();
      }
    } catch {
      /* ignore */
    }
    try {
      reader.releaseLock?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * GET /api/runs/:id/events — ownership check then proxy Agent hybrid SSE.
 * Cursor: afterSequence / after_sequence / after + Last-Event-ID (seq or ULID).
 * Disconnect aborts only the proxy — never cancels the Run (plan §12.4).
 */
export async function handleRunEvents(runId, parsedUrl, res, req = null) {
  const cursor = parseSseResumeCursor({
    searchParams: parsedUrl.searchParams,
    headers: req?.headers || {},
  });
  const controller = new AbortController();
  const onClose = () => {
    try {
      controller.abort();
    } catch {
      /* ignore */
    }
  };
  req?.on('close', onClose);
  res?.on?.('close', onClose);
  res?.on?.('error', onClose);

  /** @type {{ read: Function, cancel?: Function, releaseLock?: Function } | null} */
  let reader = null;
  try {
    // Fail-closed ownership before any stream headers (403/404 via Agent).
    const { auth } = await authorizeRunRequest(runId, req);
    const upstream = await openAgentRunEvents(runId, cursor.afterSequence, {
      signal: controller.signal,
      auth,
      traceId: req?.traceId,
      lastEventId: cursor.lastEventId,
    });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reader = upstream.body.getReader();
    await proxySseUpstream({
      reader,
      res,
      signal: controller.signal,
    });
    reader = null; // proxySseUpstream already cancelled/released
    if (!res.writableEnded) res.end();
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (!res.headersSent) sendError(res, err, req?.traceId);
    else if (!res.writableEnded) res.end();
  } finally {
    req?.off?.('close', onClose);
    res?.off?.('close', onClose);
    res?.off?.('error', onClose);
    if (reader) {
      try {
        await reader.cancel?.();
      } catch {
        /* ignore */
      }
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
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
  const idempotencyKey = readIdempotencyKeyHeader(req);
  if (!idempotencyKey) {
    json(res, 400, {
      error: 'Idempotency-Key header is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await steerAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    }, { auth, traceId: req?.traceId, idempotencyKey });
    json(res, 202, result);
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
  const idempotencyKey = readIdempotencyKeyHeader(req);
  if (!idempotencyKey) {
    json(res, 400, {
      error: 'Idempotency-Key header is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await followUpAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    }, { auth, traceId: req?.traceId, idempotencyKey });
    json(res, 202, result);
  } catch (err) {
    console.error('[runs] follow-up:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/** POST /api/conversations/:id/follow-ups — canonical plan §18.7 path. */
export async function handleConversationFollowUp(
  conversationId,
  body,
  res,
  req = null,
) {
  const text = body?.text;
  if (!conversationId) {
    json(res, 400, { error: 'conversation id is required' });
    return;
  }
  if (typeof text !== 'string' || !text.trim()) {
    json(res, 400, { error: 'text is required' });
    return;
  }
  const idempotencyKey = readIdempotencyKeyHeader(req);
  if (!idempotencyKey) {
    json(res, 400, {
      error: 'Idempotency-Key header is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    return;
  }
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await createConversationFollowUp(
      conversationId,
      { text: text.trim(), agent_id: body.agent_id || null },
      {
        auth,
        traceId: req?.traceId,
        idempotencyKey,
      },
    );
    json(res, 202, result);
  } catch (err) {
    console.error('[runs] conversation follow-up:', err.message);
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
  // plan §18.5 — Idempotency-Key required on cancel (protocol contract).
  // Agent CancelRunService is first-writer durable intent; full response replay
  // via idempotency_records is not claimed here (deferred).
  const idempotencyKey = readIdempotencyKeyHeader(req);
  if (!idempotencyKey) {
    json(res, 400, {
      error: 'Idempotency-Key header is required',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const result = await cancelAgentRun(runId, {
      auth,
      traceId: req?.traceId,
      idempotencyKey,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] cancel:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/runs/:id
 * Agent MySQL is the fact source (owner-scoped). Sandbox is not consulted for status.
 */
export async function handleGetRun(runId, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    const live = await getAgentRun(runId, { auth, traceId: req?.traceId });
    json(res, 200, presentRunDetail(null, live, true));
  } catch (err) {
    console.error('[runs] get:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/runs/:id/trace — owner-scoped durable trace tree.
 * Agent MySQL materializes the projection from restart-safe Run facts.
 */
export async function handleGetRunTrace(runId, res, req = null) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  if (req?.traceId) res.setHeader('X-Trace-Id', String(req.traceId));
  try {
    const { auth } = await authorizeRunRequest(runId, req);
    let limit = 1000;
    let cursor = null;
    if (req?.url) {
      const query = new URL(req.url, 'http://bff.invalid').searchParams;
      const requestedLimit = Number(query.get('limit'));
      if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        limit = Math.min(1000, Math.trunc(requestedLimit));
      }
      cursor = query.get('cursor') || null;
    }
    const result = await getAgentRunTrace(runId, {
      auth,
      traceId: req?.traceId,
      limit,
      cursor,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] trace:', err.message);
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
    const result = await listAgentToolExecutions(runId, {
      auth,
      traceId: req?.traceId,
    });
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
