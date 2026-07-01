#!/usr/bin/env node
/**
 * Agent WebUI Server
 *
 * Serves a chat interface for Pi Agent.
 * For each prompt, spawns `pi --print` and streams the response.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.AGENT_WEBUI_PORT || "3000", 10);
const PI_BIN = process.env.PI_BIN || "pi";
const PI_MODEL = process.env.PI_MODEL || "llmio:deepseek-v4-flash";
const PI_PROVIDER = process.env.PI_PROVIDER || "";
const SANDBOX_URL = process.env.SANDBOX_BASE_URL || "http://sandbox:8081";

// ── Shared sandbox session (created once, reused across all turns) ─
let sandboxSessionId = null;

async function ensureSandboxSession() {
  if (sandboxSessionId) return sandboxSessionId;
  try {
    const resp = await fetch(`${SANDBOX_URL}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caller_id: "agent-webui", metadata: { source: "webui" } }),
    });
    const session = await resp.json();
    sandboxSessionId = session.session_id;
    console.log(`[sandbox] Session created: ${sandboxSessionId}`);
  } catch (err) {
    console.error(`[sandbox] Failed to create session: ${err.message}`);
  }
  return sandboxSessionId;
}

async function destroySandboxSession() {
  if (!sandboxSessionId) return;
  try {
    await fetch(`${SANDBOX_URL}/sessions/${sandboxSessionId}`, { method: "DELETE" });
    console.log(`[sandbox] Session deleted: ${sandboxSessionId}`);
  } catch (err) {
    console.error(`[sandbox] Failed to delete session: ${err.message}`);
  }
  sandboxSessionId = null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Run Pi with a prompt ────────────────────────────────────────────
function runPi(prompt, history = []) {
  // Build a self-contained prompt with history context
  let fullPrompt = prompt;
  if (history.length > 0) {
    const ctx = history
      .slice(-10) // last 10 exchanges
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");
    fullPrompt = `Previous conversation:\n${ctx}\n\nUser: ${prompt}`;
  }

  const args = ["--print", "--no-session"];
  if (PI_PROVIDER) args.push("--provider", PI_PROVIDER);
  if (PI_MODEL) args.push("--model", PI_MODEL);
  args.push(fullPrompt);

  const env = {
    ...process.env,
    SANDBOX_SESSION_ID: sandboxSessionId || "",
  };

  return spawn(PI_BIN, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
}

// ── Serve static files ──────────────────────────────────────────────
function serveStatic(req, res) {
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, filePath);

  // Security: prevent path traversal
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

// ── Health check ────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const proc = spawn(PI_BIN, ["--list-models"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    const output = await new Promise((resolve) => {
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("close", () => resolve(out));
    });
    return { status: "ok", models: output.trim().split("\n").slice(0, 5) };
  } catch {
    return { status: "error", models: [] };
  }
}

// ── HTTP Server ─────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── API: Health ────────────────────────────────────────────────
  if (req.url === "/api/health" && req.method === "GET") {
    const health = await healthCheck();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(health));
    return;
  }

  // ── API: Sandbox Health proxy ────────────────────────────────
  if (req.url === "/api/sandbox-health" && req.method === "GET") {
    try {
      const resp = await fetch("http://sandbox:8081/health");
      const data = await resp.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unreachable" }));
    }
    return;
  }

  // ── API: Chat (SSE stream) ─────────────────────────────────────
  if (req.url === "/api/chat" && req.method === "POST") {
    // Ensure a shared sandbox session exists (created once, reused for all turns)
    await ensureSandboxSession();

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const { message, history = [] } = body;

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const child = runPi(message, history);
    let fullOutput = "";

    child.stdout.on("data", (data) => {
      const text = data.toString();
      fullOutput += text;
      // SSE: send each chunk
      res.write(`data: ${JSON.stringify({ type: "token", text })}\n\n`);
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      // Only send non-trivial stderr
      if (text.trim() && !text.includes("node:syscall") && !text.includes("ExperimentalWarning")) {
        res.write(`data: ${JSON.stringify({ type: "stderr", text })}\n\n`);
      }
    });

    child.on("close", (code) => {
      res.write(`data: ${JSON.stringify({ type: "done", exitCode: code })}\n\n`);
      res.end();
    });

    child.on("error", (err) => {
      res.write(`data: ${JSON.stringify({ type: "error", text: err.message })}\n\n`);
      res.end();
    });

    // Cleanup on client disconnect
    req.on("close", () => {
      child.kill();
    });
    return;
  }

  // ── Static files ───────────────────────────────────────────────
  serveStatic(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[agent-webui] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[agent-webui] Pi binary: ${PI_BIN}`);
  console.log(`[agent-webui] Sandbox URL: ${SANDBOX_URL}`);
});

// Cleanup sandbox session on shutdown
const handleShutdown = async () => {
  console.log("[agent-webui] Shutting down...");
  await destroySandboxSession();
  process.exit(0);
};
process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
