/**
 * Pi Agent WebUI — GET /api/status handler
 */
import { sandboxFetch } from "../services/sandbox-client.js";
import { conversations } from "../services/conversation-manager.js";

/**
 * Handle GET /api/status — report server + sandbox health.
 */
export async function handleStatus(req, res) {
  const result = { status: "ok", conversations: conversations.size };
  try {
    const health = await sandboxFetch("/health");
    result.sandbox = { status: health.status, sessions_active: health.sessions_active };
  } catch {
    result.sandbox = { status: "unreachable" };
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}
