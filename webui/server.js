#!/usr/bin/env node
/**
 * Pi Agent WebUI Server v2 — Pi SDK integration
 *
 * Uses @mariozechner/pi-agent-core Agent class directly (no CLI subprocess).
 * Each conversation gets its own Agent + Sandbox session.
 * SSE streaming via Agent events.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

// ── Config ──────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AGENT_WEBUI_PORT || "3000", 10);
const SANDBOX_URL = process.env.SANDBOX_BASE_URL || "http://sandbox:8081";
const LLMIO_BASE_URL = process.env.LLMIO_BASE_URL || "";
const LLMIO_API_KEY = process.env.LLMIO_API_KEY || "";
const MODEL_ID = process.env.PI_MODEL || "deepseek-v4-flash";
const CHAT_TIMEOUT_MS = 120_000; // 2 min max per chat turn
const WEBUI_DATA_DIR = process.env.AGENT_WEBUI_DATA_DIR || path.join(__dirname, "..", "sandbox", "data", "webui");
const CONVERSATIONS_FILE = path.join(WEBUI_DATA_DIR, "conversations.json");
const SYSTEM_PROMPT = [
  "You are an enterprise AI agent running in a secure sandbox environment.",
  "Your role is to help users with development, analysis, and automation tasks.",
  "",
  "## Sandbox Environment",
  "- **Isolated workspace**: All operations run inside an isolated sandbox container.",
  "- **No network access**: The sandbox has NO outbound network access. You cannot install packages from the internet (pip, npm, apt, curl, wget, etc.) unless explicitly pre-approved.",
  "- **Secure**: All file operations and commands execute in a restricted environment. You cannot access files outside the workspace directory.",
  "- **Timeout**: Each command has a maximum execution timeout (default 120s, max 300s). Long-running tasks may be killed.",
  "- **Resources**: Subprocesses are limited in CPU time, memory, and process count. Resource exhaustion is prevented via ulimit enforcement.",
  "",
  "## Available Tools",
  "- **read**: Read file contents from the sandbox workspace. Supports offset and limit for pagination.",
  "- **write**: Write or overwrite content to a file in the sandbox workspace. Creates parent directories automatically.",
  "- **edit**: Edit a file using targeted find-and-replace (old_string → new_string). Useful for making surgical changes without rewriting entire files.",
  "- **bash**: Run shell commands (including Python, Node.js, grep, find, compilation, testing, etc.). This is your primary tool for ALL terminal operations.",
  "",
  "## Output & Artifacts",
  "- Each execution gets its own `output/<execution_id>/` directory where scripts should save output files.",
  "- The `OUTPUT_DIR` environment variable is set to this directory automatically.",
  "- Output files are automatically registered as artifacts for later retrieval.",
  "",
  "## Important Rules",
  "1. All file operations and commands execute inside the sandbox — isolated and secure.",
  "2. Use **bash** for ALL terminal operations: Python scripts, Node.js, compilation, testing, grep, find, ls, cat, etc.",
  "3. Output files go under the workspace directory — use `$OUTPUT_DIR` or the `output/<execution_id>/` path for results.",
  "4. Do NOT attempt to access files outside the workspace.",
  "5. Do NOT run raw network requests or install packages without being asked — network is blocked by default.",
  "6. For data analysis tasks, use Python via bash.",
  "7. When writing code, be thorough: include error handling and tests.",
  "8. After completing a task, summarize what was done and where files were saved.",
  "",
  "## Skills",
  "Skills are available for reference and can be used to guide your work. You can invoke skill_view() to load proven workflows for common tasks.",
].join("\n");

// Detect llmio base URL: try env, or construct from models.json conventions
function resolveBaseUrl() {
  if (LLMIO_BASE_URL) return LLMIO_BASE_URL;
  // Fallback: read from models.json if present
  const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
    const llmio = cfg.providers?.llmio;
    if (llmio?.baseUrl) return llmio.baseUrl;
  } catch { /* ignore */ }
  return "https://llm.009100.xyz/openai/v1";
}
import os from "node:os";

const LLMIO_URL = resolveBaseUrl();

// ── Model factory ───────────────────────────────────────────────────────
function createModel() {
  return {
    id: MODEL_ID,
    name: MODEL_ID,
    api: "openai-completions",
    provider: "llmio",
    baseUrl: LLMIO_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
    headers: LLMIO_API_KEY ? { Authorization: `Bearer ${LLMIO_API_KEY}` } : undefined,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresAssistantAfterToolResult: false,
    },
  };
}

// ── Sandbox HTTP helpers ────────────────────────────────────────────────
const SANDBOX_HEADERS = { "Content-Type": "application/json" };
if (process.env.SANDBOX_AUTH_TOKEN) {
  SANDBOX_HEADERS["X-Auth-Token"] = process.env.SANDBOX_AUTH_TOKEN;
}

async function sandboxFetch(path, options = {}) {
  const url = `${SANDBOX_URL}${path}`;
  const { traceId, ...fetchOptions } = options;
  const traceHeaders = traceId ? { "X-Trace-Id": traceId } : {};
  const resp = await fetch(url, {
    ...fetchOptions,
    headers: { ...SANDBOX_HEADERS, ...traceHeaders, ...(fetchOptions.headers || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Sandbox API ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

function toolContent(text) {
  const lines = text.split("\n");
  const preview = lines.slice(0, 250).join("\n");
  const note = lines.length > 250 ? `\n... [${lines.length - 250} more lines]` : "";
  const truncated = (preview + note).slice(0, 50000);
  return [{ type: "text", text: truncated }];
}

// ── Sandbox Tool Factory ────────────────────────────────────────────────
const BLOCKED_COMMANDS = [
  "sudo", "su ", "chmod 777", "chown ", "rm -rf /", "rm -rf /*",
  "dd if=", "mkfs.", "fdisk", "> /dev/", "< /dev/",
];

function isBlocked(command) {
  for (const prefix of BLOCKED_COMMANDS) {
    if (command.trim().startsWith(prefix)) return prefix;
  }
  return null;
}

function createSandboxTools(sandboxSessionId, getTraceId = () => null) {
  const sid = sandboxSessionId;

  return [
    {
      name: "read",
      label: "Read file",
      description: "Read the contents of a file at the given path within the sandbox workspace.",
      parameters: Type.Object({
        path: Type.String({ description: "File path (relative to workspace)" }),
        offset: Type.Optional(Type.Number({ description: "Line number to start from (1-indexed)" })),
        limit: Type.Optional(Type.Number({ description: "Max lines to return" })),
      }),
      async execute(_toolCallId, params) {
        const q = new URLSearchParams({ path: params.path });
        if (params.offset != null) q.set("offset", String(params.offset));
        if (params.limit != null) q.set("limit", String(params.limit));
        const result = await sandboxFetch(`/sessions/${sid}/files/read?${q}`, { traceId: getTraceId() });
        return {
          content: toolContent(result.content || ""),
          details: { size: result.size, truncated: result.truncated, mime_type: result.mime_type },
        };
      },
    },
    {
      name: "write",
      label: "Write file",
      description: "Write content to a file at the given path in the sandbox workspace.",
      parameters: Type.Object({
        path: Type.String({ description: "File path (relative to workspace)" }),
        content: Type.String({ description: "Content to write" }),
      }),
      async execute(_toolCallId, params) {
        const result = await sandboxFetch(`/sessions/${sid}/files/write`, {
          traceId: getTraceId(),
          method: "POST",
          body: JSON.stringify({ path: params.path, content: params.content }),
        });
        return {
          content: toolContent(`Written ${result.size} bytes to ${params.path}`),
          details: { size: result.size },
        };
      },
    },
    {
      name: "edit",
      label: "Edit file",
      description: "Edit a file by replacing old_string with new_string (targeted find-and-replace).",
      parameters: Type.Object({
        path: Type.String({ description: "File path (relative to workspace)" }),
        old_string: Type.String({ description: "Text to find and replace (must match exactly)" }),
        new_string: Type.String({ description: "Replacement text" }),
      }),
      async execute(_toolCallId, params) {
        // Read current content
        const q = new URLSearchParams({ path: params.path });
        const file = await sandboxFetch(`/sessions/${sid}/files/read?${q}`, { traceId: getTraceId() });
        const content = file.content || "";

        // Perform replacement
        const idx = content.lastIndexOf(params.old_string);
        if (idx === -1) {
          throw new Error(`old_string not found in ${params.path}. Make sure it matches exactly.`);
        }
        const newContent =
          content.slice(0, idx) + params.new_string + content.slice(idx + params.old_string.length);

        await sandboxFetch(`/sessions/${sid}/files/write`, {
          traceId: getTraceId(),
          method: "POST",
          body: JSON.stringify({ path: params.path, content: newContent }),
        });

        const diffLines = params.new_string.split("\n").length;
        return {
          content: toolContent(`Replaced "${params.old_string}" with "${params.new_string}" in ${params.path} (${diffLines} lines changed)`),
          details: { path: params.path, diff_lines: diffLines },
        };
      },
    },
    {
      name: "bash",
      label: "Run command",
      description: "Run a shell command inside the sandbox. Use for any terminal operation including Python, Node.js, grep, find, ls, cat, compilation, and testing.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
        timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 120, max: 300)" })),
        description: Type.Optional(Type.String({ description: "Short description for audit" })),
      }),
      async execute(_toolCallId, params) {
        // Pre-flight policy check
        const blocked = isBlocked(params.command);
        if (blocked) {
          return {
            content: toolContent(`Command blocked: "${blocked}" prefix is not allowed.`),
            details: { blocked: true, exit_code: -1 },
            isError: true,
          };
        }

        const body = { command: params.command };
        if (params.timeout) body.timeout = params.timeout;

        const result = await sandboxFetch(`/sessions/${sid}/executions/command`, {
          traceId: getTraceId(),
          method: "POST",
          body: JSON.stringify(body),
        });

        const isError = result.exit_code != null && result.exit_code !== 0;
        const output = [
          result.stdout_preview ? `STDOUT:\n${result.stdout_preview}` : "",
          result.stderr_preview ? `STDERR:\n${result.stderr_preview}` : "",
        ].filter(Boolean).join("\n\n") || "(no output)";

        return {
          content: toolContent(output),
          details: {
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            truncated: result.truncated,
          },
          isError,
        };
      },
    },
  ];
}

// ── Conversation Manager ────────────────────────────────────────────────
const conversations = new Map(); // Map<id, Conversation>

function ensureDataDir() {
  fs.mkdirSync(WEBUI_DATA_DIR, { recursive: true });
}

function saveConversations() {
  ensureDataDir();
  const payload = [...conversations.values()].map((conv) => conv.toPersistedJSON());
  fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(payload, null, 2));
}

async function loadConversations() {
  try {
    if (!fs.existsSync(CONVERSATIONS_FILE)) return;
    const payload = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, "utf-8"));
    for (const item of payload) {
      const conv = Conversation.fromPersistedJSON(item);
      await conv.init({ restore: true });
      conversations.set(conv.id, conv);
    }
  } catch (err) {
    console.error("Failed to load persisted conversations:", err);
  }
}

class Conversation {
  constructor(id, persisted = {}) {
    this.id = id;
    this.title = persisted.title || "New conversation";
    this.createdAt = persisted.createdAt || Date.now();
    this.agent = null;
    this.sandboxSessionId = persisted.sandboxSessionId || null;
    this.messages = persisted.messages || []; // kept for frontend
    this.currentTraceId = null;
    this._sandboxCreated = Boolean(persisted.sandboxSessionId);
  }

  async init(options = {}) {
    // 1. Create or restore sandbox session
    if (options.restore && this.sandboxSessionId) {
      try {
        const existing = await sandboxFetch(`/sessions/${this.sandboxSessionId}`);
        this.sandboxSessionId = existing.session_id;
      } catch {
        this.sandboxSessionId = null;
      }
    }

    if (!this.sandboxSessionId) {
      const session = await sandboxFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({
          agent_session_id: this.id,
          enterprise_session_id: this.id,
          caller_id: "agent-webui",
          metadata: { source: "webui", conversation_id: this.id },
        }),
      });
      this.sandboxSessionId = session.session_id;
      this._sandboxCreated = true;
    }

    // 2. Create Pi Agent with API key resolver
    const agent = new Agent({
      getApiKey: (provider) => {
        if (provider === "llmio") return LLMIO_API_KEY || undefined;
        return undefined;
      },
    });
    agent.setModel(createModel());
    agent.setTools(createSandboxTools(this.sandboxSessionId, () => this.currentTraceId));
    agent.setSystemPrompt(SYSTEM_PROMPT);
    this.agent = agent;

    return this;
  }

  async destroy() {
    // Cleanup sandbox session
    if (this.sandboxSessionId && this._sandboxCreated) {
      try {
        await sandboxFetch(`/sessions/${this.sandboxSessionId}`, { method: "DELETE" });
      } catch { /* best effort */ }
    }
    this.agent?.abort();
    conversations.delete(this.id);
    saveConversations();
  }

  toJSON() {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      sandboxSessionId: this.sandboxSessionId,
      messageCount: this.messages.length,
    };
  }

  toPersistedJSON() {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      sandboxSessionId: this.sandboxSessionId,
      messages: this.messages,
    };
  }

  static fromPersistedJSON(item) {
    return new Conversation(item.id, item);
  }
}

// ── API handlers ────────────────────────────────────────────────────────

async function handleConversations(req, res) {
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

async function handleConversation(req, res, urlParts) {
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

async function handleChat(req, res, urlParts) {
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

// ── MIME types ──────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, filePath);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(content);
}

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
    const result = { status: "ok", conversations: conversations.size };
    try {
      const health = await sandboxFetch("/health");
      result.sandbox = { status: health.status, sessions_active: health.sessions_active };
    } catch {
      result.sandbox = { status: "unreachable" };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  // /api/conversations (list / create)
  if (pathname === "/api/conversations") {
    return handleConversations(req, res);
  }

  // /api/conversations/:id ...
  if (parts[0] === "api" && parts[1] === "conversations" && parts[2]) {
    if (parts[3] === "chat" && parts.length === 4) {
      return handleChat(req, res, parts);
    }
    // Without sub-path: GET/DELETE/PATCH conversation metadata
    // With /messages: GET messages
    return handleConversation(req, res, parts);
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
