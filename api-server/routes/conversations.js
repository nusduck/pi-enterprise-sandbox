/**
 * Routes: conversation CRUD proxies → sandbox /conversations
 */
import * as sb from '../services/sandbox-client.js';
import { authFromRequest } from '../services/sandbox-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res, status, message) {
  json(res, status, { error: message });
}

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
    jsonError(res, err.status || 500, err.message || 'Failed to list conversations');
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
    jsonError(res, err.status || 500, err.message || 'Conversation not found');
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
    jsonError(res, err.status || 500, err.message || 'Failed to create conversation');
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
    jsonError(res, err.status || 500, err.message || 'Failed to delete conversation');
  }
}

/**
 * GET /api/conversations/:id/events — last run event stream for recovery UI.
 */
export async function handleGetConversationEvents(id, res, req, query = {}) {
  try {
    const client = sb.createSandboxClient({ auth: authFromRequest(req) });
    const afterSequence = query.after_sequence != null
      ? Number(query.after_sequence)
      : 0;
    const limit = query.limit != null ? Number(query.limit) : undefined;
    const events = await client.listConversationEvents(id, {
      afterSequence: Number.isFinite(afterSequence) ? afterSequence : 0,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    // Include last_run status for UI badge
    let last_run = null;
    try {
      last_run = await client.getLatestAgentRun(id);
    } catch {
      last_run = null;
    }
    json(res, 200, { events, last_run });
  } catch (err) {
    console.error('[conversations] events:', err.message);
    jsonError(res, err.status || 500, err.message || 'Failed to list conversation events');
  }
}
