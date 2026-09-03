/**
 * Route: POST /api/sessions/ensure
 * Create/reuse Conversation + Sandbox Session so uploads can proceed
 * without first sending a chat message.
 */
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ensureAgentSession } from '../services/agent-client.js';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';

function json(res: ServerResponse, status: number, body: unknown, traceId?: string | null) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (traceId) headers['X-Trace-Id'] = String(traceId);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

/**
 * POST /api/sessions/ensure
 * Body: { conversation_id?: string }
 * Returns: { conversation_id, session_id, workspace_id, reused_session, trace_id }
 */
export async function handleEnsureSession(
  body: any,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
  const traceId =
    (req && (req.headers['x-trace-id'] || req.headers['X-Trace-Id'])) ||
    randomUUID().replaceAll('-', '');
  try {
    const auth = await resolveTrustedAuth(req);
    const conversationId = body?.conversation_id || body?.conversationId || null;
    const resolved = await ensureAgentSession(conversationId, {
      auth,
      traceId: String(traceId),
    });
    json(res, 200, {
      conversation_id: resolved.conversation_id,
      session_id: resolved.session_id,
      // Opaque workspace id only (never host physical roots or absolute paths)
      workspace_id: resolved.workspace_id,
      reused_session: resolved.reused_session,
      trace_id: traceId,
    }, String(traceId));
  } catch (err: any) {
    console.error('[sessions] ensure failed:', err.message);
    json(res, err.status || 500, {
      error: err.message || 'Failed to ensure session',
      trace_id: traceId,
    }, String(traceId));
  }
}

