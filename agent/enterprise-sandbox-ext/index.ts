/**
 * Enterprise Sandbox Extension for Pi Agent.
 *
 * Replaces Pi's built-in read/write/edit/bash tools with proxies that
 * route execution to the Enterprise Sandbox Service (HTTP API).
 *
 * Architecture:
 *   Pi Agent → Enterprise Sandbox Extension → Sandbox Service (port 8081)
 *
 * The sandbox handles:
 *   - Session & workspace isolation
 *   - Path escape protection (resolve + is_relative_to)
 *   - Non-root execution with safe_env
 *   - Resource limits (timeout, output cap, process group kill)
 *   - Risk-based tool policy (low/medium/high)
 *   - Audit logging + Prometheus metrics
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";

// ── Configuration ────────────────────────────────────────────────────

const SANDBOX_BASE_URL = process.env.SANDBOX_BASE_URL || "http://sandbox:8081";
const SANDBOX_AUTH_TOKEN = process.env.SANDBOX_AUTH_TOKEN || "";

const HEADERS: Record<string, string> = { "Content-Type": "application/json" };
if (SANDBOX_AUTH_TOKEN) HEADERS["X-Auth-Token"] = SANDBOX_AUTH_TOKEN;

const OUTPUT_LIMIT = 50_000;

// ── HTTP helpers ─────────────────────────────────────────────────────

async function sandboxFetch(
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const url = `${SANDBOX_BASE_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: { ...HEADERS, ...(options.headers as Record<string, string>) },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Sandbox API ${resp.status} ${resp.statusText}: ${body}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function truncate(text: string, max = OUTPUT_LIMIT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

function toolContent(text: string) {
  // Pi expects content as array of { type: "text", text }
  // For large output, only include the first portion
  const lines = text.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const note =
    lines.length > 200 ? `\n... [${lines.length - 200} more lines]` : "";
  return [{ type: "text" as const, text: truncate(preview + note) }];
}

// ── Policy check (Agent-side pre-flight) ─────────────────────────────

const BLOCKED_COMMANDS = [
  "sudo", "su ", "chmod 777", "chown ", "rm -rf /", "rm -rf /*",
  "dd if=", "mkfs.", "fdisk", "> /dev/", "< /dev/",
];

function isBlocked(command: string): string | null {
  for (const prefix of BLOCKED_COMMANDS) {
    if (command.trim().startsWith(prefix)) return prefix;
  }
  return null;
}

// ── Extension ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Per-session sandbox session ID
  let sandboxSessionId: string | null = null;
  let sandboxCallerId = "pi-agent";

  // ── Session lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      const session = await sandboxFetch("/sessions", {
        method: "POST",
        body: JSON.stringify({
          caller_id: sandboxCallerId,
          metadata: { source: "pi-enterprise-extension" },
        }),
      });
      sandboxSessionId = session.session_id;
      ctx.ui.notify(
        `Sandbox session created: ${sandboxSessionId}`,
        "info",
      );
    } catch (err: any) {
      ctx.ui.notify(
        `Failed to create sandbox session: ${err.message}`,
        "error",
      );
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    if (sandboxSessionId) {
      try {
        await sandboxFetch(`/sessions/${sandboxSessionId}`, {
          method: "DELETE",
        });
      } catch {
        // best-effort cleanup
      }
      sandboxSessionId = null;
    }
  });

  // ── Tool: read ─────────────────────────────────────────────────

  pi.registerTool({
    name: "read",
    description:
      "Read the contents of a file at the given path within the sandbox workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to workspace)" }),
      offset: Type.Optional(
        Type.Number({ description: "Line number to start from (1-indexed)" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max lines to return" }),
      ),
    }),
    promptGuidelines: [
      "Use read to inspect existing files before editing them.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!sandboxSessionId) throw new Error("No active sandbox session");

      const query = new URLSearchParams({ path: params.path });
      if (params.offset) query.set("offset", String(params.offset));
      if (params.limit) query.set("limit", String(params.limit));

      const result = await sandboxFetch(
        `/sessions/${sandboxSessionId}/files/read?${query}`,
      );
      return {
        content: toolContent(result.content || ""),
        details: {
          size: result.size,
          truncated: result.truncated,
          mime_type: result.mime_type,
        },
      };
    },
  });

  // ── Tool: write ────────────────────────────────────────────────

  pi.registerTool({
    name: "write",
    description:
      "Write content to a file at the given path in the sandbox workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to workspace)" }),
      content: Type.String({ description: "Content to write" }),
    }),
    promptGuidelines: [
      "Use write to create new files or overwrite existing ones.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!sandboxSessionId) throw new Error("No active sandbox session");

      const result = await sandboxFetch(
        `/sessions/${sandboxSessionId}/files/write`,
        {
          method: "POST",
          body: JSON.stringify({
            path: params.path,
            content: params.content,
          }),
        },
      );
      return {
        content: toolContent(
          `Written ${result.size} bytes to ${params.path}`,
        ),
        details: { size: result.size, mime_type: result.mime_type },
      };
    },
  });

  // ── Tool: edit ─────────────────────────────────────────────────

  pi.registerTool({
    name: "edit",
    description:
      "Edit a file by replacing old_string with new_string (targeted find-and-replace).",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to workspace)" }),
      old_string: Type.String({
        description: "Text to find and replace (must be unique in file)",
      }),
      new_string: Type.String({ description: "Replacement text" }),
    }),
    promptGuidelines: [
      "Use edit for targeted changes. Prefer edit over write for small modifications.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!sandboxSessionId) throw new Error("No active sandbox session");

      // Read current content
      const q = new URLSearchParams({ path: params.path });
      const file = await sandboxFetch(
        `/sessions/${sandboxSessionId}/files/read?${q}`,
      );
      const content = file.content || "";

      // Perform replacement (last occurrence for safety)
      const idx = content.lastIndexOf(params.old_string);
      if (idx === -1) {
        throw new Error(
          `old_string not found in ${params.path}. Make sure it matches exactly.`,
        );
      }
      const newContent =
        content.slice(0, idx) +
        params.new_string +
        content.slice(idx + params.old_string.length);

      // Write back
      await sandboxFetch(`/sessions/${sandboxSessionId}/files/write`, {
        method: "POST",
        body: JSON.stringify({ path: params.path, content: newContent }),
      });

      const diffLines = params.new_string.split("\n").length;
      return {
        content: toolContent(
          `Replaced "${params.old_string}" with "${params.new_string}" in ${params.path} (${diffLines} lines changed)`,
        ),
        details: { path: params.path, diff_lines: diffLines },
      };
    },
  });

  // ── Tool: bash ─────────────────────────────────────────────────

  pi.registerTool({
    name: "bash",
    description:
      "Run a shell command inside the sandbox. Use for any terminal operation including grep, find, ls, cat, head, tail, pip, npm, compilation, and testing.",
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to execute",
      }),
      timeout: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 120, max: 300)",
        }),
      ),
      description: Type.Optional(
        Type.String({
          description:
            "A short description of what the command does, for audit purposes",
        }),
      ),
    }),
    promptGuidelines: [
      "Use bash for ALL terminal operations — grep, find, ls, cat, head, tail, compilation, testing, package management.",
    ],
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!sandboxSessionId) throw new Error("No active sandbox session");

      // Pre-flight policy check
      const blocked = isBlocked(params.command);
      if (blocked) {
        return {
          content: toolContent(
            `Command blocked: "${blocked}" prefix is not allowed.`,
          ),
          details: { blocked: true, exit_code: -1 },
          isError: true,
        };
      }

      const body: Record<string, any> = { command: params.command };
      if (params.timeout) body.timeout = params.timeout;

      const result = await sandboxFetch(
        `/sessions/${sandboxSessionId}/executions/command`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
      );

      const isError = result.exit_code != null && result.exit_code !== 0;
      return {
        content: toolContent(
          [
            result.stdout_preview ? `STDOUT:\n${result.stdout_preview}` : "",
            result.stderr_preview ? `STDERR:\n${result.stderr_preview}` : "",
          ]
            .filter(Boolean)
            .join("\n\n") || "(no output)",
        ),
        details: {
          exit_code: result.exit_code,
          duration_ms: result.duration_ms,
          truncated: result.truncated,
        },
        isError,
      };
    },
  });

  // ── Optional Slash Commands ────────────────────────────────────

  pi.registerCommand("sandbox-status", {
    description: "Show sandbox session status",
    handler: async (_args, ctx) => {
      if (!sandboxSessionId) {
        ctx.ui.notify("No active sandbox session", "warning");
        return;
      }
      try {
        const health = await sandboxFetch("/health");
        const session = await sandboxFetch(
          `/sessions/${sandboxSessionId}`,
        );
        ctx.ui.notify(
          [
            `Sandbox: ${health.status}`,
            `Session: ${sandboxSessionId} [${session.status}]`,
            `Runtimes: python=${health.runtimes?.python}, bash=${health.runtimes?.bash}`,
            `Active sessions: ${health.sessions_active}`,
            `Disk free: ${health.disk_free_mb.toFixed(0)} MB`,
          ].join(" | "),
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`Sandbox unreachable: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-reset", {
    description: "Reset sandbox (close current session, create new one)",
    handler: async (_args, ctx) => {
      if (sandboxSessionId) {
        try {
          await sandboxFetch(`/sessions/${sandboxSessionId}`, {
            method: "DELETE",
          });
        } catch {
          // ignore
        }
        sandboxSessionId = null;
      }
      try {
        const session = await sandboxFetch("/sessions", {
          method: "POST",
          body: JSON.stringify({ caller_id: sandboxCallerId }),
        });
        sandboxSessionId = session.session_id;
        ctx.ui.notify(`New sandbox session: ${sandboxSessionId}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed: ${err.message}`, "error");
      }
    },
  });
}
