/**
 * Route: POST /api/sessions/ensure
 * Create/reuse Conversation + Sandbox Session so uploads can proceed
 * without first sending a chat message.
 */
import { randomUUID } from 'node:crypto';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';
import { resolveConversationAndSession } from '../services/conversation-session-resolver.js';

function json(res, status, body, traceId) {
  const headers = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = String(traceId);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/**
 * POST /api/sessions/ensure
 * Body: { conversation_id?: string }
 * Returns: { conversation_id, session_id, workspace_id, reused_session, trace_id }
 */
export async function handleEnsureSession(body, res, req = null) {
  const traceId =
    (req && (req.headers['x-trace-id'] || req.headers['X-Trace-Id'])) || randomUUID();
  const client = createSandboxClient({
    traceId,
    auth: authFromRequest(req),
  });

  try {
    const conversationId = body?.conversation_id || null;
    const resolved = await resolveConversationAndSession(client, conversationId);
    json(res, 200, {
      conversation_id: resolved.activeConversationId,
      session_id: resolved.sandboxSessionId,
      // Opaque workspace id only (never host physical roots or absolute paths)
      workspace_id: resolved.workspace_id,
      reused_session: resolved.reusedSession,
      trace_id: traceId,
    }, traceId);
  } catch (err) {
    console.error('[sessions] ensure failed:', err.message);
    json(res, err.status || 500, {
      error: err.message || 'Failed to ensure session',
      trace_id: traceId,
    }, traceId);
  }
}
