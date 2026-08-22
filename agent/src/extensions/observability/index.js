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
} from '../../infrastructure/pi/event-redaction.js';
import { SANDBOX_TOOL_NAMES } from '../sandbox-bridge/constants.js';
import { startSpan, SpanKind } from '../../infrastructure/telemetry.js';
import { getProcessProviderGate } from '../../infrastructure/provider-gate.js';

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
 * Normalize `ExtensionContext.getContextUsage()` into a durable payload.
 *
 * `tokens`/`percent` are legitimately null right after a compaction, before the
 * next assistant response re-estimates them. Null is preserved rather than
 * coerced to 0 — "unknown" and "empty context" are different states, and a UI
 * that renders 0% for the first is worse than one that renders nothing.
 *
 * @param {unknown} usage
 * @returns {{ tokens: number|null, contextWindow: number|null, percent: number|null } | null}
 */
export function normalizeContextUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const u = /** @type {Record<string, unknown>} */ (usage);
  const num = (value) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const contextWindow = num(u.contextWindow);
  const tokens = num(u.tokens);
  if (contextWindow == null && tokens == null) return null;
  const percent =
    num(u.percent) ??
    (tokens != null && contextWindow != null && contextWindow > 0
      ? Math.round((tokens / contextWindow) * 10_000) / 100
      : null);
  return { tokens, contextWindow, percent };
}

/**
 * Coerce a truncation limit to a positive integer, falling back to the
 * default when absent/invalid.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * First usable positive integer from deps then env, else undefined so the
 * provider gate keeps its own documented defaults.
 *
 * @param {unknown} depValue
 * @param {string | undefined} envValue
 * @returns {number | undefined}
 */
function positiveIntOr(depValue, envValue) {
  for (const candidate of [depValue, envValue]) {
    if (candidate == null || String(candidate).trim() === '') continue;
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
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
 *     isDurableInteractionPending?: (toolCallId: string) => boolean,
 *     now?: () => Date,
 *     modelId?: string | null,
 *     provider?: string | null,
 *     deltaTruncateLimit?: number,
 *     thinkingTruncateLimit?: number,
 *     otel?: boolean,
 *     providerGate?: { acquire: Function, observe: Function } | null,
 *     providerMaxConcurrent?: number,
 *     providerCooldownMs?: number,
 *   },
 * }} options
 * @returns {import('@earendil-works/pi-coding-agent').ExtensionFactory}
 */
export function createObservabilityExtension(options) {
  const runContext = options?.runContext;
  const deps = options?.deps ?? {};
  // Audit-content truncation limits. Defaults keep the historical sizes;
  // operators raising AGENT_OBS_DELTA_TRUNCATE / AGENT_OBS_THINKING_TRUNCATE
  // accept larger run_events rows in exchange for fuller audit fidelity.
  const deltaTruncateLimit = positiveLimit(deps.deltaTruncateLimit, 512);
  const thinkingTruncateLimit = positiveLimit(deps.thinkingTruncateLimit, 2048);
  const recorder = deps.recorder ?? null;
  const isDurableInteractionPending =
    typeof deps.isDurableInteractionPending === 'function'
      ? deps.isDurableInteractionPending
      : null;
  const now = deps.now ?? (() => new Date());
  const modelId =
    typeof deps.modelId === 'string' && deps.modelId.trim()
      ? deps.modelId.trim().slice(0, 255)
      : null;
  const provider =
    typeof deps.provider === 'string' && deps.provider.trim()
      ? deps.provider.trim().slice(0, 255)
      : null;
  // Provider concurrency gate + 429 cooldown. Deliberately the *process*
  // gate, not a per-Run one: this extension is built once per Run, so a gate
  // owned here would only ever throttle a single already-serial prompt loop.
  // deps.providerGate is the test seam.
  const providerGate =
    deps.providerGate && typeof deps.providerGate.acquire === 'function'
      ? deps.providerGate
      : getProcessProviderGate({
          maxConcurrent: positiveIntOr(
            deps.providerMaxConcurrent,
            process.env.AGENT_PROVIDER_MAX_CONCURRENT,
          ),
          cooldownMs: positiveIntOr(
            deps.providerCooldownMs,
            process.env.AGENT_PROVIDER_COOLDOWN_MS,
          ),
        });
  const providerKey = () => String(modelId || provider || 'default');
  // OTel tool spans stay off unless the container saw an OTLP endpoint, so a
  // deployment without a collector keeps the cheap NoopSpanProcessor path.
  const otelEnabled = deps.otel === true;

  const modelMetadata = () => ({
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {}),
  });

  /**
   * Sequential provider correlation stack (one session processes requests
   * in order; concurrent overlapping calls still pair FIFO).
   * @type {Array<{ correlationId: string, startedAt: number }>}
   */
  const providerStack = [];
  let providerSeq = 0;
  /** Per-session counter for `context` (one per assembled LLM call). */
  let contextSeq = 0;
  /** Last emitted usage, so an unchanged context does not re-emit on retry. */
  let lastContextUsageKey = null;
  /** Per-session monotonic sequence for stable message identities. */
  let messageSeq = 0;
  /** Separate assistant stream identity; one model turn can emit many messages. */
  let assistantMessageSeq = 0;
  let activeAssistantMessageId = null;

  function nextAssistantMessageId() {
    assistantMessageSeq += 1;
    return `assistant:${runContext.runId}:seq${assistantMessageSeq}`;
  }

  function activeAssistantMessage() {
    if (!activeAssistantMessageId) {
      activeAssistantMessageId = nextAssistantMessageId();
    }
    return activeAssistantMessageId;
  }

  function finishAssistantMessage() {
    const messageId = activeAssistantMessageId || nextAssistantMessageId();
    activeAssistantMessageId = null;
    return messageId;
  }

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
      // An aborted Run (cancel, deadline, lost lease) can leave a provider
      // call or a tool execution without its paired end event. The process
      // gate outlives this Run, so an unreleased slot would shrink the cap for
      // every later Run in this worker — release here, unconditionally.
      while (providerStack.length > 0) {
        const frame = providerStack.pop();
        if (typeof frame?.release === 'function') frame.release();
      }
      for (const toolCallId of [...activeToolSpans.keys()]) {
        endToolSpan(toolCallId, true, 'RUN_ENDED_BEFORE_TOOL_RESULT');
      }
      if (typeof deps.onSessionShutdown === 'function') {
        await deps.onSessionShutdown(event, ctx);
      }
    });

    // ── Context pressure ────────────────────────────────────────────────
    // `context` fires as each LLM call is assembled, which is the only point
    // where how full the window is can be observed *before* compaction acts on
    // it. Without this the UI learns about context pressure only after the
    // fact, from session.compacted.
    pi.on('context', async (_event, ctx) => {
      const usage = normalizeContextUsage(ctx?.getContextUsage?.());
      if (!usage) return;
      // Pi retries a failed provider call with the same assembled context;
      // emitting once per distinct context keeps the stream readable.
      const key = `${usage.tokens}:${usage.contextWindow}`;
      if (key === lastContextUsageKey) return;
      lastContextUsageKey = key;
      contextSeq += 1;
      await emit(
        'context.usage',
        {
          ...usage,
          ...modelMetadata(),
          sequence: contextSeq,
        },
        { dedupeKey: `context.usage:${runContext.runId}:${contextSeq}` },
      );
      // `context` must not alter the messages Pi assembled.
      return undefined;
    });

    // ── Provider lifecycle (model.request.*) — NOT agent_start/end ──────
    pi.on('before_provider_request', async (event) => {
      providerSeq += 1;
      const correlationId = `prov:${runContext.runId}:${providerSeq}`;
      const startedAt = now().getTime();
      const frame = { correlationId, startedAt, release: null };
      providerStack.push(frame);
      // Acquire a provider slot BEFORE the request goes out. The release is
      // parked on this frame so after_provider_response can always find it
      // even when the event pairing is lossy; a degraded acquire hands back a
      // no-op, so the gate can never be over-released.
      frame.release = await providerGate.acquire(providerKey(), event?.signal);
      // Never persist payload / headers / prompt.
      await emit(
        'model.request.started',
        {
          correlationId,
          ...modelMetadata(),
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
      // Release the slot and record/clear this provider's 429 cooldown.
      if (typeof frame?.release === 'function') frame.release();
      providerGate.observe(providerKey(), status);
      // Never persist headers or body.
      if (ok) {
        await emit(
          'model.request.completed',
          {
            correlationId,
            ...modelMetadata(),
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
            ...modelMetadata(),
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
          messageId: activeAssistantMessage(),
          delta: delta.slice(0, deltaTruncateLimit),
          delta_truncated: delta.length > deltaTruncateLimit,
        });
      } else if (ame?.type === 'thinking_start') {
        await emit('thinking.started', {
          role: 'assistant',
          messageId: activeAssistantMessage(),
        });
      } else if (ame?.type === 'thinking_delta') {
        const delta = redactInlineSecrets(String(ame.delta ?? ''));
        await emit('thinking.delta', {
          role: 'assistant',
          messageId: activeAssistantMessage(),
          delta: delta.slice(0, deltaTruncateLimit),
          delta_truncated: delta.length > deltaTruncateLimit,
        });
      } else if (ame?.type === 'thinking_end') {
        const thinking = redactInlineSecrets(String(ame.content ?? ''));
        await emit('thinking.completed', {
          role: 'assistant',
          messageId: activeAssistantMessage(),
          text: thinking.slice(0, thinkingTruncateLimit),
          text_truncated: thinking.length > thinkingTruncateLimit,
        });
      }
    });

    pi.on('message_end', async (event) => {
      const message = event?.message;
      const role = message?.role ?? 'unknown';
      const usage = extractUsageSummary(message);
      const dedupeKey = messageDedupeKey(message, role);
      const messageId = role === 'assistant' ? finishAssistantMessage() : null;
      await emit(
        'message.completed',
        {
          role,
          ...(messageId ? { messageId } : {}),
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

    // ── OTel tool spans ─────────────────────────────────────────────────
    // One CLIENT span per tool execution, parented to whatever run span is
    // active (run-worker's agent.run.execute). Exported by the process-level
    // OTLP exporter in telemetry.js; a NoopSpanProcessor otherwise. Span
    // bookkeeping must never break execution, so every call is guarded.
    /** @type {Map<string, { end: (error?: unknown) => void }>} */
    const activeToolSpans = new Map();
    const startToolSpan = (toolCallId, toolName) => {
      if (!otelEnabled || !toolCallId) return;
      try {
        activeToolSpans.set(
          toolCallId,
          startSpan(`agent.tool.${toolName || 'unknown'}`, {
            kind: SpanKind.CLIENT,
            attributes: {
              'agent.tool.name': toolName,
              'agent.tool.call_id': toolCallId,
              'agent.run.id': String(runContext.runId),
            },
          }),
        );
      } catch {
        // Observability must never break execution.
      }
    };
    // errorCode is the tool result's own stable code (never its message), so
    // the span records why without carrying redacted output into the trace.
    const endToolSpan = (toolCallId, isError, errorCode) => {
      const handle = activeToolSpans.get(toolCallId);
      if (!handle) return;
      activeToolSpans.delete(toolCallId);
      try {
        handle.end(
          isError ? new Error(String(errorCode || 'tool failed')) : null,
        );
      } catch {
        // Ignore span-end failures.
      }
    };

    pi.on('tool_execution_start', async (event) => {
      const toolCallId = String(event?.toolCallId ?? '');
      const toolName = String(event?.toolName ?? '');
      startToolSpan(toolCallId, toolName);
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
      endToolSpan(toolCallId, isError, isError ? result?.details?.code : null);

      // Pi converts a thrown durable ask_user suspension into an ordinary
      // error ToolResult and drops custom Error fields before this event. The
      // executor's per-Run predicate is the authoritative, exact signal that
      // this particular ask_user call is parked in WAITING_INPUT.
      if (
        toolName === 'ask_user' &&
        isDurableInteractionPending?.(toolCallId) === true
      ) {
        return;
      }

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
      // SessionCompactEvent has no `timestamp`; the compaction entry's id is
      // the stable unique key. Keying on reason alone silently dropped a second
      // threshold compaction in the same Run.
      const entry = event?.compactionEntry ?? null;
      const compactionId = entry?.id != null ? String(entry.id) : '';
      await emit(
        'session.compacted',
        {
          reason: event?.reason != null ? String(event.reason) : '',
          willRetry: Boolean(event?.willRetry),
          fromExtension: Boolean(event?.fromExtension),
          compactionId: compactionId || null,
          firstKeptEntryId:
            entry?.firstKeptEntryId != null ? String(entry.firstKeptEntryId) : null,
          tokensBefore:
            Number.isFinite(entry?.tokensBefore) ? Number(entry.tokensBefore) : null,
        },
        {
          dedupeKey: compactionId
            ? `session.compacted:${compactionId}`
            : // No entry id: fall back to a per-emit unique key so the event is
              // recorded rather than deduped against an unrelated compaction.
              `session.compacted:${event?.reason ?? ''}:${now().toISOString()}`,
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
    ownsContextUsageEvents: true,
  });
  return observabilityExtension;
}
