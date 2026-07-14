/**
 * Routes: conversation CRUD proxies → sandbox /conversations
 */
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { loadConversationTimeline } from '../application/conversation-timeline-service.js';
import { sendError, sendJson as json } from '../http/response.js';

/**
 * GET /api/conversations
 * @param {import('node:http').ServerResponse} res
 * @param {import('node:http').IncomingMessage} [req]
 */
export async function handleListConversations(res, req) {
  try {
    const list = await sb.listConversations(authFromRequest(req));
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
    const conv = await sb.getConversation(id, authFromRequest(req));
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
    const conv = await sb.createConversation(title, authFromRequest(req));
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
    await sb.deleteConversation(id, authFromRequest(req));
    res.writeHead(204);
    res.end();
  } catch (err) {
    console.error('[conversations] delete:', err.message);
    sendError(res, err, req?.traceId);
  }
}

/** GET /api/conversations/:id/events — complete persisted run timeline. */
export async function handleGetConversationEvents(id, res, req, query = {}) {
  try {
    const client = sb.createSandboxClient({ auth: authFromRequest(req) });
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
