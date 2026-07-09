/**
 * Routes: conversation CRUD proxies → sandbox /conversations
 */
import * as sb from '../services/sandbox-client.js';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function jsonError(res, status, message) {
  json(res, status, { error: message });
}

/**
 * GET /api/conversations
 */
export async function handleListConversations(res) {
  try {
    const list = await sb.listConversations();
    json(res, 200, list);
  } catch (err) {
    console.error('[conversations] list:', err.message);
    jsonError(res, err.status || 500, err.message || 'Failed to list conversations');
  }
}

/**
 * GET /api/conversations/:id
 */
export async function handleGetConversation(id, res) {
  try {
    const conv = await sb.getConversation(id);
    json(res, 200, conv);
  } catch (err) {
    console.error('[conversations] get:', err.message);
    jsonError(res, err.status || 500, err.message || 'Conversation not found');
  }
}

/**
 * POST /api/conversations  body: { title? }
 */
export async function handleCreateConversation(body, res) {
  try {
    const title = body?.title || 'New chat';
    const conv = await sb.createConversation(title);
    json(res, 201, conv);
  } catch (err) {
    console.error('[conversations] create:', err.message);
    jsonError(res, err.status || 500, err.message || 'Failed to create conversation');
  }
}

/**
 * DELETE /api/conversations/:id
 */
export async function handleDeleteConversation(id, res) {
  try {
    await sb.deleteConversation(id);
    res.writeHead(204);
    res.end();
  } catch (err) {
    console.error('[conversations] delete:', err.message);
    jsonError(res, err.status || 500, err.message || 'Failed to delete conversation');
  }
}
