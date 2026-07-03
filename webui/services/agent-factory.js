/**
 * Pi Agent WebUI — Agent Factory
 *
 * Creates the Pi model config and sandbox tool definitions.
 */
import { Type } from "@sinclair/typebox";
import { Agent } from "@mariozechner/pi-agent-core";
import {
  MODEL_ID,
  LLMIO_API_KEY,
  resolveBaseUrl,
  SYSTEM_PROMPT,
} from "../config.js";
import { sandboxFetch, isBlocked, toolContent } from "./sandbox-client.js";

const LLMIO_URL = resolveBaseUrl();

/**
 * Create the Pi model configuration object.
 * @returns {object} Model config.
 */
export function createModel() {
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

/**
 * Create the sandbox tool definitions for a Pi Agent.
 *
 * @param {string} sandboxSessionId - The sandbox session ID.
 * @param {Function} getTraceId - Callback to retrieve the current trace ID.
 * @returns {Array<object>} Array of tool definitions.
 */
export function createSandboxTools(sandboxSessionId, getTraceId = () => null) {
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
