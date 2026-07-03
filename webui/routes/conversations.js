/**
 * Pi Agent WebUI — Conversation API handlers
 *
 * GET    /api/conversations          — list all
 * POST   /api/conversations          — create new
 * GET    /api/conversations/:id      — get details
 * DELETE /api/conversations/:id      — delete
 * PATCH  /api/conversations/:id      — rename
 * GET    /api/conversations/:id/messages — get messages
 */
import crypto from "node:crypto";
import { Conversation, conversations, saveConversations } from "../services/conversation-manager.js";

/**
 * Handle GET (list) and POST (create) on /api/conversations.
 */
export async function handleConversations(req, res) {
  // GET /api/conversations — list all
  if (req.method === "GET") {
    const list = [];
    for (const conv of conversations.values()) {
      list.push(conv.toJSON());
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /api/conversations — create new
  if (req.method === "POST") {
    try {
      const id = crypto.randomUUID();
      const conv = new Conversation(id);
      await conv.init();
      conversations.set(id, conv);
      saveConversations();
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify(conv.toJSON()));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(405);
  res.end();
}

/**
 * Handle operations on a specific conversation: GET/DELETE/PATCH and GET messages.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string[]} urlParts - Parsed URL path segments
 */
export async function handleConversation(req, res, urlParts) {
  const convId = urlParts[2];
  const conv = conversations.get(convId);

  if (!conv) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Conversation not found" }));
    return;
  }

  // DELETE /api/conversations/:id
  if (req.method === "DELETE") {
    await conv.destroy();
    res.writeHead(204);
    res.end();
    return;
  }

  // PATCH /api/conversations/:id — rename
  if (req.method === "PATCH") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.title) {
      conv.title = body.title;
      saveConversations();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(conv.toJSON()));
    return;
  }

  // GET /api/conversations/:id/messages — get message history
  if (req.method === "GET" && urlParts[3] === "messages") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(conv.messages));
    return;
  }

  res.writeHead(405);
  res.end();
}
