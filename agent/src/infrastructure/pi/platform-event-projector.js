/**
 * PlatformEventProjector — pure, stateless Pi → platform event mapping.
 *
 * NOT the production event path. `PiRunExecutor` only calls `project()` when
 * `eventProjectionMode` is "session-subscribe", and that mode is replaced by
 * "observability" as soon as an extension bundle is present — which it always
 * is in production. The live projection lives in the observability extension,
 * which maps the same Pi events straight onto the durable recorder.
 *
 * What is kept here, and why: a Run assembled without the enterprise bundle has
 * no observability extension and would otherwise emit nothing at all. Tests use
 * that shape. Anything changed in the observability extension's event mapping
 * needs a matching change here, or the two projections drift.
 *
 * Redaction and summarisation moved to ./event-redaction.js — import from there
 * rather than through this module.
 *
 * Model request lifecycle is NOT projected from agent_start/agent_end (one agent
 * turn may include multiple provider calls). Real model.request.* mapping is the
 * observability extension's provider lifecycle.
 */

import {
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_MAX_STRING,
  extractAssistantTextForUi,
  extractToolCallBlocks,
  redactInlineSecrets,
  redactPayload,
  summarizeAssistantMessage,
  summarizeToolArgs,
  summarizeToolResult,
} from './event-redaction.js';

export const PROJECTOR_EVENT_TYPES = Object.freeze([
  'message.delta',
  'message.completed',
  'thinking.started',
  'thinking.delta',
  'thinking.completed',
  'tool.call.proposed',
  'tool.execution.started',
  'tool.execution.progress',
  'tool.execution.completed',
  'tool.execution.failed',
  'artifact.ready',
  'session.compacted',
  // model.request.* reserved for PR-06 provider lifecycle — not mapped from agent_* here
  'model.request.started',
  'model.request.completed',
  'model.request.failed',
  'error.occurred',
]);

/**
 * Stateless pure projector.
 */
export class PlatformEventProjector {
  /**
   * @param {{ maxString?: number }} [opts]
   */
  constructor(opts = {}) {
    this.maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  }

  /**
   * @param {object | null | undefined} event
   * @param {{
   *   runId?: string | null,
   *   orgId?: string | null,
   *   userId?: string | null,
   *   conversationId?: string | null,
   *   agentSessionId?: string | null,
   *   traceId?: string | null,
   *   spanId?: string | null,
   * }} [ctx]
   * @returns {Array<{ type: string, payload: Record<string, unknown> }>}
   */
  project(event, ctx = {}) {
    if (!event || typeof event !== 'object') return [];
    const type = /** @type {Record<string, unknown>} */ (event).type;
    if (typeof type !== 'string') return [];

    const base = this.#baseContext(ctx);
    const ev = /** @type {Record<string, unknown>} */ (event);

    switch (type) {
      case 'message_update': {
        const ame = /** @type {any} */ (ev).assistantMessageEvent;
        if (ame?.type === 'text_delta') {
          const delta = redactInlineSecrets(String(ame.delta ?? ''));
          return [
            {
              type: 'message.delta',
              payload: {
                ...base,
                role: 'assistant',
                delta: delta.slice(0, this.maxString),
                delta_truncated: delta.length > this.maxString,
              },
            },
          ];
        }
        if (ame?.type === 'thinking_start') {
          return [
            {
              type: 'thinking.started',
              payload: { ...base, role: 'assistant' },
            },
          ];
        }
        if (ame?.type === 'thinking_delta') {
          const delta = redactInlineSecrets(String(ame.delta ?? ''));
          return [
            {
              type: 'thinking.delta',
              payload: {
                ...base,
                role: 'assistant',
                delta: delta.slice(0, this.maxString),
                delta_truncated: delta.length > this.maxString,
              },
            },
          ];
        }
        if (ame?.type === 'thinking_end') {
          const thinking = redactInlineSecrets(String(ame.content ?? ''));
          return [
            {
              type: 'thinking.completed',
              payload: {
                ...base,
                role: 'assistant',
                text: thinking.slice(0, DEFAULT_MAX_RESULT_CHARS),
                text_truncated: thinking.length > DEFAULT_MAX_RESULT_CHARS,
              },
            },
          ];
        }
        return [];
      }

      case 'message_end': {
        const message = /** @type {any} */ (ev).message;
        /** @type {Array<{ type: string, payload: Record<string, unknown> }>} */
        const out = [
          {
            type: 'message.completed',
            payload: {
              ...base,
              role: message?.role ?? 'assistant',
              message: summarizeAssistantMessage(message),
            },
          },
        ];
        for (const tc of extractToolCallBlocks(message)) {
          out.push({
            type: 'tool.call.proposed',
            payload: {
              ...base,
              toolCallId: tc.id,
              toolName: tc.name,
              args: summarizeToolArgs(tc.name, tc.arguments),
            },
          });
        }
        return out;
      }

      case 'tool_execution_start': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        return [
          {
            type: 'tool.execution.started',
            payload: {
              ...base,
              toolCallId,
              toolName,
              args: summarizeToolArgs(toolName, ev.args),
            },
          },
        ];
      }

      case 'tool_execution_update': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        return [
          {
            type: 'tool.execution.progress',
            payload: {
              ...base,
              toolCallId,
              toolName,
              progress: redactPayload(
                ev.partialResult ?? ev.progress ?? ev.update ?? null,
              ),
            },
          },
        ];
      }

      case 'tool_execution_end': {
        const toolCallId = String(ev.toolCallId ?? '');
        const toolName = String(ev.toolName ?? '');
        const isError = Boolean(ev.isError);
        return [
          {
            type: isError ? 'tool.execution.failed' : 'tool.execution.completed',
            payload: {
              ...base,
              toolCallId,
              toolName,
              isError,
              result: summarizeToolResult(ev.result),
            },
          },
        ];
      }

      case 'compaction_end': {
        const errorMessage = ev.errorMessage;
        const aborted = Boolean(ev.aborted);
        const result = ev.result;
        if (!aborted && !errorMessage && result != null) {
          return [
            {
              type: 'session.compacted',
              payload: {
                ...base,
                reason: String(ev.reason ?? ''),
                aborted: false,
                willRetry: Boolean(ev.willRetry),
              },
            },
          ];
        }
        if (errorMessage || aborted) {
          const msg = errorMessage
            ? redactInlineSecrets(String(errorMessage)).slice(0, this.maxString)
            : 'compaction aborted';
          return [
            {
              type: 'error.occurred',
              payload: {
                ...base,
                source: 'compaction',
                reason: String(ev.reason ?? ''),
                message: msg,
                aborted,
              },
            },
          ];
        }
        return [];
      }

      // agent_start / agent_end are NOT mapped to model.request.* —
      // one agent lifecycle may include multiple provider calls (PR-06).
      case 'agent_start':
      case 'agent_end':
        return [];

      default:
        return [];
    }
  }

  /**
   * @param {Iterable<object>} events
   * @param {object} [ctx]
   */
  projectMany(events, ctx = {}) {
    /** @type {Array<{ type: string, payload: Record<string, unknown> }>} */
    const out = [];
    for (const ev of events) {
      out.push(...this.project(ev, ctx));
    }
    return out;
  }

  /**
   * @param {object} ctx
   * @returns {Record<string, unknown>}
   */
  #baseContext(ctx) {
    /** @type {Record<string, unknown>} */
    const base = {};
    if (ctx.runId) base.runId = ctx.runId;
    if (ctx.orgId) base.orgId = ctx.orgId;
    if (ctx.userId) base.userId = ctx.userId;
    if (ctx.conversationId) base.conversationId = ctx.conversationId;
    if (ctx.agentSessionId) base.agentSessionId = ctx.agentSessionId;
    if (ctx.traceId) base.traceId = ctx.traceId;
    if (ctx.spanId) base.spanId = ctx.spanId;
    return base;
  }
}

/**
 * @param {object} event
 * @param {object} [ctx]
 */
export function projectPiEvent(event, ctx = {}) {
  return new PlatformEventProjector().project(event, ctx);
}
