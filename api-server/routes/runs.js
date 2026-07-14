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
    const { run } = await authorizeRunRequest(runId, req);
    json(res, 200, run);
  } catch (err) {
    console.error('[runs] get:', err.message);
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
