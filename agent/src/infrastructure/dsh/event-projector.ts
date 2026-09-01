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
  extractAssistantThinkingForUi,
  extractToolCallBlocks,
  redactInlineSecrets,
  redactPayload,
  summarizeAssistantMessage,
  summarizeToolArgs,
  summarizeToolResult,
} from '../../lib/event-redaction.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

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
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  maxString: Loose;

  constructor(opts: { maxString?: number } = {}) {
    this.maxString = opts.maxString ?? DEFAULT_MAX_STRING;
  }

  /**
   * @param event
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
  project(event: Record<string, any> | null | undefined, ctx: { runId?: string | null, orgId?: string | null, userId?: string | null, conversationId?: string | null, agentSessionId?: string | null, traceId?: string | null, spanId?: string | null, } = {}) {
    if (!event || typeof event !== 'object') return [];
    const type = (event as Record<string, unknown>).type;
    if (typeof type !== 'string') return [];

    const base = this.#baseContext(ctx);
    const ev = (event as Record<string, unknown>);

    switch (type) {
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent;
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
        const message = (ev as any).message;
        const out: Array<{ type: string, payload: Record<string, unknown> }> = [];
        const thinking = extractAssistantThinkingForUi(message);
        if (thinking) {
          out.push({
            type: 'thinking.completed',
            payload: {
              ...base,
              role: 'assistant',
              text: thinking.slice(0, DEFAULT_MAX_RESULT_CHARS),
              text_truncated: thinking.length > DEFAULT_MAX_RESULT_CHARS,
            },
          });
        }
        out.push({
          type: 'message.completed',
          payload: {
            ...base,
            role: message?.role ?? 'assistant',
            message: summarizeAssistantMessage(message),
          },
        });
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

  projectMany(events: Iterable<Record<string, any>>, ctx: Record<string, any> = {}) {
    const out: Array<{ type: string, payload: Record<string, unknown> }> = [];
    for (const ev of events) {
      out.push(...this.project(ev, ctx));
    }
    return out;
  }

  /**
   * @param ctx
   * @returns {Record<string, unknown>}
   */
  #baseContext(ctx: Record<string, any>) {
    const base: Record<string, unknown> = {};
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

export function projectPiEvent(event: Record<string, any>, ctx: Record<string, any> = {}) {
  return new PlatformEventProjector().project(event, ctx);
}
