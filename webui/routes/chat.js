/**
 * Pi Agent WebUI — Chat SSE handler
 *
 * POST /api/conversations/:id/chat — SSE streaming chat endpoint.
 */
import crypto from "node:crypto";
import { conversations, saveConversations } from "../services/conversation-manager.js";
import { CHAT_TIMEOUT_MS } from "../config.js";

/**
 * Handle POST /api/conversations/:id/chat — SSE stream.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string[]} urlParts - Parsed URL path segments
 */
export async function handleChat(req, res, urlParts) {
  const convId = urlParts[2];
  const conv = conversations.get(convId);

  if (!conv) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Conversation not found" }));
    return;
  }

  // POST /api/conversations/:id/chat — SSE stream
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  // Read body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const { message } = body;
  if (!message || !message.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "message is required" }));
    return;
  }

  // Auto-title: use first message as title
  if (conv.messages.length === 0) {
    conv.title = message.slice(0, 60) + (message.length > 60 ? "…" : "");
  }

  // Push user message
  const traceId = `trace_${crypto.randomUUID().replaceAll("-", "")}`;
  conv.currentTraceId = traceId;
  conv.messages.push({ role: "user", content: message, timestamp: Date.now(), trace_id: traceId });
  saveConversations();

  // SSE setup
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const abortController = new AbortController();
  let assistantText = "";
  let done = false;

  // Forward Agent events → SSE
  const unsubscribe = conv.agent.subscribe((event) => {
    try {
      switch (event.type) {
        case "turn_start":
          res.write(`data: ${JSON.stringify({ type: "turn_start", trace_id: traceId })}\n\n`);
          break;

        case "message_update": {
          const ae = event.assistantMessageEvent;
          if (ae.type === "text_delta") {
            assistantText += ae.delta;
            res.write(`data: ${JSON.stringify({ type: "token", text: ae.delta })}\n\n`);
          }
          break;
        }

        case "message_end":
          // finalize text
          break;

        case "tool_execution_start":
          res.write(
            `data: ${JSON.stringify({ type: "tool_start", toolName: event.toolName, args: event.args })}\n\n`
          );
          break;

        case "tool_execution_end":
          res.write(
            `data: ${JSON.stringify({
              type: "tool_end",
              toolName: event.toolName,
              isError: event.isError,
            })}\n\n`
          );
          break;

        case "agent_start":
          assistantText = "";
          break;

        case "agent_end":
          // Conversation complete
          break;

        case "turn_end":
          break;
      }
    } catch { /* SSE write failed — client likely disconnected */ }
  });

  // Cleanup on client disconnect
  req.on("close", () => {
    abortController.abort();
    conv.agent.abort();
    unsubscribe();
    if (!done) {
      // Still save partial result
      if (assistantText.trim()) {
        conv.messages.push({
          role: "assistant",
          content: assistantText.trim(),
          trace_id: traceId,
          timestamp: Date.now(),
        });
        saveConversations();
      }
    }
  });

  try {
    // Run the agent prompt with timeout
    const timeoutId = setTimeout(() => {
      abortController.abort();
      conv.agent.abort();
    }, CHAT_TIMEOUT_MS);

    await conv.agent.prompt(message, [], abortController.signal);
    clearTimeout(timeoutId);
    done = true;

    // Save assistant message
    const trimmed = assistantText.trim();
    if (trimmed) {
      conv.messages.push({ role: "assistant", content: trimmed, trace_id: traceId, timestamp: Date.now() });
      saveConversations();
    }

    res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
  } catch (err) {
    if (err.name === "AbortError") return;
    res.write(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`);
  } finally {
    conv.currentTraceId = null;
    unsubscribe();
    res.end();
  }
}
