/**
 * Pi Agent WebUI — Sandbox HTTP Client
 *
 * Helpers for communicating with the sandbox API.
 */
import { SANDBOX_URL, BLOCKED_COMMANDS } from "../config.js";

// ── Request headers ──────────────────────────────────────────────────────
export const SANDBOX_HEADERS = { "Content-Type": "application/json" };
if (process.env.SANDBOX_AUTH_TOKEN) {
  SANDBOX_HEADERS["X-Auth-Token"] = process.env.SANDBOX_AUTH_TOKEN;
}

// ── Fetch wrapper ────────────────────────────────────────────────────────
/**
 * Make a request to the sandbox API. Accepts an options object that may
 * include a `traceId` property (passed as X-Trace-Id header).
 *
 * @param {string} path - API path (e.g. "/health", "/sessions/...")
 * @param {object} options - { traceId, method, body, headers, ...fetchOptions }
 * @returns {object|null} Parsed JSON response, or null for empty body.
 */
export async function sandboxFetch(path, options = {}) {
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

// ── Command safety check ─────────────────────────────────────────────────
/**
 * Check if a command is blocked by policy.
 *
 * @param {string} command - The shell command to check.
 * @returns {string|null} The matched blocked prefix, or null if allowed.
 */
export function isBlocked(command) {
  for (const prefix of BLOCKED_COMMANDS) {
    if (command.trim().startsWith(prefix)) return prefix;
  }
  return null;
}

// ── Tool content helper ──────────────────────────────────────────────────
/**
 * Wrap text content for tool results, truncating to a reasonable size.
 *
 * @param {string} text - Raw output text.
 * @returns {Array<{type: string, text: string}>} Pi-agent content array.
 */
export function toolContent(text) {
  const lines = text.split("\n");
  const preview = lines.slice(0, 250).join("\n");
  const note = lines.length > 250 ? `\n... [${lines.length - 250} more lines]` : "";
  const truncated = (preview + note).slice(0, 50000);
  return [{ type: "text", text: truncated }];
}
