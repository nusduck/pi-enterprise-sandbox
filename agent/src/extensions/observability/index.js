/**
 * observability Extension (PR-06 slice 1).
 *
 * Uses Pi 0.80.3 public ExtensionAPI hooks only:
 * - before_provider_request / after_provider_response → model.request.*
 * - message_* / tool_execution_* / session_compact → platform events
 *
 * agent_start / agent_end MUST NOT be mapped to model.request.* (one agent
 * loop may contain multiple provider calls).
 *
 * Never persists raw prompt, provider payload, headers, or secrets.
 * Durable writes go exclusively through injected FencedRunEventRecorder.
 */

import {
  redactPayload,
  summarizeToolArgs,
  summarizeToolResult,
  summarizeAssistantMessage,
  extractToolCallBlocks,
  redactInlineSecrets,
} from '../../infrastructure/pi/platform-event-projector.js';
import { SANDBOX_TOOL_NAMES } from '../sandbox-bridge/constants.js';

/** Sandbox-bridge tool names only — MCP/other tools cannot spoof UNKNOWN. */
const SANDBOX_BRIDGE_TOOL_NAME_SET = new Set(SANDBOX_TOOL_NAMES);

/**
 * True only when a sandbox-bridge tool result carries the exact transport
 * UNKNOWN marker (`details.outcomeUnknown === true` and
 * `details.code === 'TOOL_OUTCOME_UNKNOWN'`). Rejects spoofed MCP results
 * and string/number truthy fakes.
 *
 * @param {string} toolName
 * @param {unknown} result
 * @returns {boolean}
 */
export function isSandboxBridgeOutcomeUnknown(toolName, result) {
  if (typeof toolName !== 'string' || !SANDBOX_BRIDGE_TOOL_NAME_SET.has(toolName)) {
    return false;
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return false;
  }
  const details = /** @type {Record<string, unknown>} */ (result).details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return false;
  }
  const d = /** @type {Record<string, unknown>} */ (details);
  return (
    d.outcomeUnknown === true &&
    d.code === 'TOOL_OUTCOME_UNKNOWN'
  );
}

/**
 * Extract safe usage/cost summary from assistant message_end when present.
 * Unknown fields are omitted (never invented).
 *
 * @param {unknown} message
 * @returns {Record<string, unknown> | null}
 */
export function extractUsageSummary(message) {
  if (!message || typeof message !== 'object') return null;
  const usage = /** @type {Record<string, unknown>} */ (message).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = /** @type {Record<string, unknown>} */ (usage);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'cacheWrite1h',
    'reasoning',
    'totalTokens',
  ]) {
    if (typeof u[key] === 'number' && Number.isFinite(u[key])) {
      out[key] = u[key];
    }
  }
  if (u.cost && typeof u.cost === 'object' && !Array.isArray(u.cost)) {
    const c = /** @type {Record<string, unknown>} */ (u.cost);
    /** @type {Record<string, unknown>} */
    const cost = {};
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      if (typeof c[key] === 'number' && Number.isFinite(c[key])) {
        cost[key] = c[key];
      }
    }
    if (Object.keys(cost).length) out.cost = cost;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * @param {{
 *   runContext: {
 *     orgId: string,
 *     userId: string,
 *     conversationId: string,
 *     agentSessionId: string,
 *     runId: string,
 *     sandboxSessionId?: string | null,
 *     traceId: string,
 *   },
 *   deps?: {
 *     recorder?: {
 *       record: (input: object) => Promise<object | null>,
 *       enqueue?: (fn: () => Promise<void>) => Promise<void>,
 *     } | null,
 *     onSessionStart?: (event: object, ctx: object) => void | Promise<void>,
 *     onSessionShutdown?: (event: object, ctx: object) => void | Promise<void>,
 *     governanceRecorder?: {
 *       recordToolStarted?: Function,
 *       recordToolEnded?: Function,
 *       recordToolUnknown?: Function,
 *       enqueue?: Function,
 *     } | null,
 *     now?: () => Date,
 *   },
 * }} options
 * @returns {import('@earendil-works/pi-coding-agent').ExtensionFactory}
 */
export function createObservabilityExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};
  const recorder = deps.recorder ?? null;
  const now = deps.now ?? (() => new Date());

  /**
   * Sequential provider correlation stack (one session processes requests
   * in order; concurrent overlapping calls still pair FIFO).
   * @type {Array<{ correlationId: string, startedAt: number }>}
   */
  const providerStack = [];
  let providerSeq = 0;
  /** Per-session monotonic sequence for stable message identities. */
  let messageSeq = 0;

  /**
   * @param {string} type
   * @param {Record<string, unknown>} data
   * @param {{ dedupeKey?: string, spanId?: string | null }} [meta]
   */
  async function emit(type, data, meta = {}) {
    if (!recorder || typeof recorder.record !== 'function') return;
    const write = async () => {
      await recorder.record({
        type,
        data,
        dedupeKey: meta.dedupeKey,
        spanId: meta.spanId ?? null,
      });
    };
    if (typeof recorder.enqueue === 'function') {
      await recorder.enqueue(write);
    } else {
      await write();
    }
  }

  /**
   * Stable identity for message.completed — never role-only.
   * Prefers responseId / timestamp when present; always includes per-session seq.
   * @param {any} message
   * @param {string} role
   */
  function messageDedupeKey(message, role) {
    messageSeq += 1;
    const responseId =
      typeof message?.responseId === 'string' && message.responseId
        ? message.responseId
        : '';
    const ts =
      message?.timestamp != null && message.timestamp !== ''
        ? String(message.timestamp)
        : '';
    // Include seq so empty responseId+timestamp cannot collide across messages.
    return `message.completed:${role}:seq${messageSeq}:rid=${responseId}:ts=${ts}`;
  }

  /**
   * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
   */
  function observabilityExtension(pi) {
    // session_start / session_shutdown: hook/diagnostic only.
    // plan §15.2 has no session.started / session.shutdown platform type —
    // do not invent durable event types.
    pi.on('session_start', async (event, ctx) => {
      if (typeof deps.onSessionStart === 'function') {
        await deps.onSessionStart(event, ctx);
      }
    });
    pi.on('session_shutdown', async (event, ctx) => {
      if (typeof deps.onSessionShutdown === 'function') {
        await deps.onSessionShutdown(event, ctx);
      }
    });

    // ── Provider lifecycle (model.request.*) — NOT agent_start/end ──────
    pi.on('before_provider_request', async (_event) => {
      providerSeq += 1;
      const correlationId = `prov:${runContext.runId}:${providerSeq}`;
      const startedAt = now().getTime();
      providerStack.push({ correlationId, startedAt });
      // Never persist payload / headers / prompt.
      await emit(
        'model.request.started',
        {
          correlationId,
          // Safe metadata only
        },
        { dedupeKey: `model.request.started:${correlationId}` },
      );
      return undefined;
    });

    pi.on('after_provider_response', async (event) => {
      const frame = providerStack.pop();
      const correlationId =
        frame?.correlationId ?? `prov:${runContext.runId}:orphan:${providerSeq + 1}`;
      const status =
        typeof event?.status === 'number' ? event.status : Number(event?.status);
      const ok = Number.isFinite(status) && status >= 200 && status < 400;
      const durationMs =
        frame?.startedAt != null
          ? Math.max(0, now().getTime() - frame.startedAt)
          : undefined;
      // Never persist headers or body.
      if (ok) {
        await emit(
          'model.request.completed',
          {
            correlationId,
            status: Number.isFinite(status) ? status : undefined,
            ...(durationMs != null ? { durationMs } : {}),
          },
          { dedupeKey: `model.request.completed:${correlationId}` },
        );
      } else {
        await emit(
          'model.request.failed',
          {
            correlationId,
            status: Number.isFinite(status) ? status : undefined,
            ...(durationMs != null ? { durationMs } : {}),
          },
          { dedupeKey: `model.request.failed:${correlationId}` },
        );
      }
    });

    // agent_start / agent_end intentionally ignored for model.request.*

    // ── Messages ────────────────────────────────────────────────────────
    pi.on('message_update', async (event) => {
      const ame = event?.assistantMessageEvent;
      if (ame?.type === 'text_delta') {
        const delta = redactInlineSecrets(String(ame.delta ?? ''));
        await emit('message.delta', {
          role: 'assistant',
          delta: delta.slice(0, 512),
          delta_truncated: delta.length > 512,
        });
      }
    });

    pi.on('message_end', async (event) => {
      const message = event?.message;
      const role = message?.role ?? 'unknown';
      const usage = extractUsageSummary(message);
      const dedupeKey = messageDedupeKey(message, role);
      await emit(
        'message.completed',
        {
          role,
          message: summarizeAssistantMessage(message),
          ...(usage ? { usage } : {}),
          _obsSeq: messageSeq,
        },
        { dedupeKey },
      );
      if (role === 'assistant') {
        for (const tc of extractToolCallBlocks(message)) {
          await emit(
            'tool.call.proposed',
            {
              toolCallId: tc.id,
              toolName: tc.name,
              args: summarizeToolArgs(tc.name, tc.arguments),
            },
            { dedupeKey: `tool.call.proposed:${tc.id}` },
          );
        }
      }
    });

    // ── Tools ───────────────────────────────────────────────────────────
    // When governanceRecorder is injected, it is the sole durability owner for
    // tool.execution.started/completed/failed (+ tool_executions ledger).
    // Progress remains event-only (no schema progress columns).
    const governance = deps.governanceRecorder ?? null;

    pi.on('tool_execution_start', async (event) => {
      const toolCallId = String(event?.toolCallId ?? '');
      const toolName = String(event?.toolName ?? '');
      const args = summarizeToolArgs(toolName, event?.args);
      if (governance && typeof governance.recordToolStarted === 'function') {
        // Direct call — enqueue would swallow ConflictError into promise-tail.
        await governance.recordToolStarted({
          toolCallId,
          toolName,
          args: event?.args,
        });
        return;
      }
      await emit(
        'tool.execution.started',
        {
          toolCallId,
          toolName,
          args,
        },
        { dedupeKey: `tool.execution.started:${toolCallId}` },
      );
    });

    pi.on('tool_execution_update', async (event) => {
      const toolCallId = String(event?.toolCallId ?? '');
      const toolName = String(event?.toolName ?? '');
      // Progress: event-only (schema has no progress columns).
      await emit('tool.execution.progress', {
        toolCallId,
        toolName,
        progress: redactPayload(
          event?.partialResult ?? event?.progress ?? event?.update ?? null,
        ),
      });
    });

    pi.on('tool_execution_end', async (event) => {
      const toolCallId = String(event?.toolCallId ?? '');
      const toolName = String(event?.toolName ?? '');
      const isError = Boolean(event?.isError);
      const result = event?.result;

      if (governance) {
        // Ambiguous sandbox-bridge outcome only: exact marker + sandbox tool
        // name. Never invent UNKNOWN from ordinary timeout/bind/MCP spoof.
        if (
          typeof governance.recordToolUnknown === 'function' &&
          isSandboxBridgeOutcomeUnknown(toolName, result)
        ) {
          await governance.recordToolUnknown({
            toolCallId,
            toolName,
            // Fixed result envelope — do not forward arbitrary tool details.
            result: Object.freeze({
              unknown: true,
              reason: 'TOOL_OUTCOME_UNKNOWN',
            }),
            errorCode: 'TOOL_OUTCOME_UNKNOWN',
          });
          // Must not fall through to recordToolEnded (would solidify FAILED).
          return;
        }
        if (typeof governance.recordToolEnded === 'function') {
          await governance.recordToolEnded({
            toolCallId,
            toolName,
            isError,
            result,
          });
          return;
        }
      }
      await emit(
        isError ? 'tool.execution.failed' : 'tool.execution.completed',
        {
          toolCallId,
          toolName,
          isError,
          result: summarizeToolResult(result),
        },
        {
          dedupeKey: `tool.execution.${isError ? 'failed' : 'completed'}:${toolCallId}`,
        },
      );
    });

    // ── Compaction ──────────────────────────────────────────────────────
    pi.on('session_compact', async (event) => {
      await emit(
        'session.compacted',
        {
          reason: event?.reason != null ? String(event.reason) : '',
          willRetry: Boolean(event?.willRetry),
          fromExtension: Boolean(event?.fromExtension),
        },
        {
          dedupeKey: `session.compacted:${event?.reason ?? ''}:${event?.timestamp ?? ''}`,
        },
      );
    });
  }

  observabilityExtension.extensionName = 'observability';
  observabilityExtension.extensionMetadata = Object.freeze({
    name: 'observability',
    role: 'trace-events-audit',
    slice: 1,
    ownsModelRequestEvents: true,
    ownsMessageToolCompactionEvents: true,
  });
  return observabilityExtension;
}
