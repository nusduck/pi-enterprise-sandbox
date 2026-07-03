#!/usr/bin/env node
/**
 * Pi Agent WebUI Server v2 — Modular Entry Point
 *
 * Thin HTTP server that delegates routing to modular handlers.
 */
import http from "node:http";
import { PORT, SANDBOX_URL, MODEL_ID } from "./config.js";
import { conversations, loadConversations, saveConversations } from "./services/conversation-manager.js";
import { handleStatus } from "./routes/status.js";
import { handleConversations, handleConversation } from "./routes/conversations.js";
import { handleChat } from "./routes/chat.js";
import { serveStatic } from "./routes/static.js";
import { handleSessionFiles, handleSessionFileDownload, handleSessionArtifacts } from "./routes/files.js";
import { handleConversationSandbox } from "./routes/conversations.js";

// ── Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const parts = pathname.split("/").filter(Boolean);

  // ── API routes ──

  // GET /api/status
  if (pathname === "/api/status" && req.method === "GET") {
    return handleStatus(req, res);
  }

  // /api/conversations (list / create)
  if (pathname === "/api/conversations") {
    return handleConversations(req, res);
  }

  // GET /api/conversations/:id/sandbox — get sandbox session ID
  // NOTE: must be BEFORE the catch-all /api/conversations/:id handler below
  if (parts[0] === "api" && parts[1] === "conversations" && parts[2] && parts[3] === "sandbox" && parts.length === 4 && req.method === "GET") {
    return handleConversationSandbox(req, res, parts[2]);
  }

  // /api/conversations/:id ... (catch-all: chat, messages, metadata)
  if (parts[0] === "api" && parts[1] === "conversations" && parts[2]) {
    if (parts[3] === "chat" && parts.length === 4) {
      return handleChat(req, res, parts);
    }
    // Without sub-path: GET/DELETE/PATCH conversation metadata
    // With /messages: GET messages
    return handleConversation(req, res, parts);
  }

  // ── Sandbox file/artifact proxy (for WebUI to browse & download outputs) ──

  // GET /api/sessions/:id/files — list files in session workspace
  if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "files" && parts.length === 4 && req.method === "GET") {
    const sessionId = parts[2];
    const subpath = url.searchParams.get("path") || ".";
    return handleSessionFiles(req, res, sessionId, subpath);
  }

  // GET /api/sessions/:id/files/download?path=... — download a file
  if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "files" && parts[4] === "download" && req.method === "GET") {
    const sessionId = parts[2];
    const filepath = url.searchParams.get("path") || "";
    return handleSessionFileDownload(req, res, sessionId, filepath);
  }

  // GET /api/sessions/:id/artifacts — list artifacts
  if (parts[0] === "api" && parts[1] === "sessions" && parts[3] === "artifacts" && parts.length === 4 && req.method === "GET") {
    const sessionId = parts[2];
    return handleSessionArtifacts(req, res, sessionId);
  }

  // ── Static files ──
  serveStatic(req, res);
});

// ── Start ───────────────────────────────────────────────────────────────
await loadConversations();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent-webui] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[agent-webui] Sandbox URL: ${SANDBOX_URL}`);
  console.log(`[agent-webui] Model: llmio:${MODEL_ID}`);
});

// Global error logging — prevent silent failures
process.on("unhandledRejection", (reason) => {
  console.error("[agent-webui] UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[agent-webui] UNCAUGHT EXCEPTION:", err);
});

// Graceful shutdown — persist conversations and keep sandbox sessions recoverable
const handleShutdown = async () => {
  console.log("[agent-webui] Shutting down, preserving sandbox sessions for recovery...");
  saveConversations();
  for (const conv of conversations.values()) {
    conv.agent?.abort();
  }
  process.exit(0);
};
process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
