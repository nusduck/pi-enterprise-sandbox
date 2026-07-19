/**
 * Conversation CRUD and run/event timeline are both Agent MySQL authority.
 */
import {
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  listAgentRuns,
  listAgentEvents,
} from '../services/agent-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import { loadConversationTimeline } from '../application/conversation-timeline-service.js';
import { sendError, sendJson as json } from '../http/response.js';

/**
 * GET /api/conversations
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleListConversations(res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    const list = await listAgentConversations({ auth, traceId: req?.traceId });
    json(res, 200, list);
  } catch (err) {
    console.error('[conversations] list:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * GET /api/conversations/:id
 */
export async function handleGetConversation(id, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    const conv = await getAgentConversation(id, {
      auth,
      traceId: req?.traceId,
    });
    json(res, 200, conv);
  } catch (err) {
    console.error('[conversations] get:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * POST /api/conversations  body: { title? }
 */
export async function handleCreateConversation(body, res, req) {
  try {
    const title = body?.title || 'New chat';
    const auth = await resolveTrustedAuth(req);
    const conv = await createAgentConversation(
      { title },
      { auth, traceId: req?.traceId },
    );
    json(res, 201, conv);
  } catch (err) {
    console.error('[conversations] create:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/**
 * DELETE /api/conversations/:id
 */
export async function handleDeleteConversation(id, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    await deleteAgentConversation(id, { auth, traceId: req?.traceId });
    res.writeHead(204);
    res.end();
  } catch (err) {
    console.error('[conversations] delete:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/** GET /api/conversations/:id/events — complete persisted run timeline (Agent MySQL). */
export async function handleGetConversationEvents(id, res, req, query = {}) {
  try {
    // Resolve the browser session into trusted Agent owner headers before
    // loading the Agent MySQL run/event timeline.
    const auth = await resolveTrustedAuth(req);
    const traceId = req?.traceId || null;
    const client = {
      listAgentRuns: (q) => listAgentRuns(q, { auth, traceId }),
      listAgentEvents: (runId, q) => listAgentEvents(runId, q, { auth, traceId }),
    };
    const limit = query.limit != null ? Number(query.limit) : undefined;
    const timeline = await loadConversationTimeline(client, id, {
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    json(res, 200, timeline);
  } catch (err) {
    console.error('[conversations] events:', err.message);
    sendError(res, err, req?.traceId);
  }
}
