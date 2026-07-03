/**
 * Pi Agent WebUI — Configuration
 *
 * All configuration constants extracted from the monolithic server.js.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Runtime configuration (env-driven) ───────────────────────────────────
export const PORT = parseInt(process.env.AGENT_WEBUI_PORT || "3000", 10);
export const SANDBOX_URL = process.env.SANDBOX_BASE_URL || "http://sandbox:8081";
export const LLMIO_BASE_URL = process.env.LLMIO_BASE_URL || "";
export const LLMIO_API_KEY = process.env.LLMIO_API_KEY || "";
export const MODEL_ID = process.env.PI_MODEL || "deepseek-v4-flash";
export const CHAT_TIMEOUT_MS = 120_000; // 2 min max per chat turn
export const WEBUI_DATA_DIR = process.env.AGENT_WEBUI_DATA_DIR || path.join(__dirname, "..", "sandbox", "data", "webui");
export const CONVERSATIONS_FILE = path.join(WEBUI_DATA_DIR, "conversations.json");

// ── System prompt ────────────────────────────────────────────────────────
export const SYSTEM_PROMPT = [
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

// ── MIME types ───────────────────────────────────────────────────────────
export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── Blocked commands ─────────────────────────────────────────────────────
export const BLOCKED_COMMANDS = [
  "sudo", "su ", "chmod 777", "chown ", "rm -rf /", "rm -rf /*",
  "dd if=", "mkfs.", "fdisk", "> /dev/", "< /dev/",
];

// ── Resolve base URL ─────────────────────────────────────────────────────
/**
 * Resolve the LLMIO base URL from env, models.json, or fallback.
 */
export function resolveBaseUrl() {
  if (LLMIO_BASE_URL) return LLMIO_BASE_URL;
  const modelsPath = path.join(os.homedir(), ".pi", "agent", "models.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
    const llmio = cfg.providers?.llmio;
    if (llmio?.baseUrl) return llmio.baseUrl;
  } catch { /* ignore */ }
  return "https://llm.009100.xyz/openai/v1";
}
