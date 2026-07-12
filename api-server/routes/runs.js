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
  steerAgentRun,
  followUpAgentRun,
  cancelAgentRun,
  getAgentRun,
  resumeAgentRunApproval,
} from '../services/agent-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * POST /api/runs/:id/steer  body: { text, conversation_id? }
 */
export async function handleSteerRun(runId, body, res) {
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
    const result = await steerAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] steer:', err.message);
    json(res, err.status || 500, { error: err.message || 'Steer failed' });
  }
}

/**
 * POST /api/runs/:id/follow-up  body: { text, conversation_id? }
 */
export async function handleFollowUpRun(runId, body, res) {
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
    const result = await followUpAgentRun(runId, {
      text: text.trim(),
      conversation_id: body.conversation_id || null,
    });
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] follow-up:', err.message);
    json(res, err.status || 500, { error: err.message || 'Follow-up failed' });
  }
}

/**
 * POST /api/runs/:id/cancel
 */
export async function handleCancelRun(runId, res) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const result = await cancelAgentRun(runId);
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] cancel:', err.message);
    json(res, err.status || 500, { error: err.message || 'Cancel failed' });
  }
}

/**
 * GET /api/runs/:id
 */
export async function handleGetRun(runId, res) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const result = await getAgentRun(runId);
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] get:', err.message);
    json(res, err.status || 500, { error: err.message || 'Get run failed' });
  }
}

/**
 * POST /api/runs/:id/resume-approval  body: { decision, reason? }
 * Usually triggered automatically after approve/reject; exposed for recovery.
 */
export async function handleResumeApproval(runId, body, res) {
  if (!runId) {
    json(res, 400, { error: 'run id is required' });
    return;
  }
  try {
    const result = await resumeAgentRunApproval(runId, body || {});
    json(res, 200, result);
  } catch (err) {
    console.error('[runs] resume-approval:', err.message);
    json(res, err.status || 500, { error: err.message || 'Resume failed' });
  }
}
