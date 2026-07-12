/**
 * Compatibility adapter: legacy /chat SSE events → RuntimeEvent envelopes.
 * Keeps F1 chat streaming working until run-centric API fully lands.
 */
import type { RuntimeEvent } from '../schemas/events';
import { makeRuntimeEvent } from '../schemas/events';
import type { SSEEvent } from './parser';

export type LegacyAdapterState = {
  runId: string;
  sessionId: string | null;
  conversationId: string | null;
  sequence: number;
  /** Active streaming message id for token deltas. */
  messageId: string | null;
  /** Map tool index / id → tool execution id. */
  toolIds: string[];
};

export function createLegacyAdapterState(
  partial: Partial<LegacyAdapterState> & { runId: string },
): LegacyAdapterState {
  return {
    sessionId: null,
    conversationId: null,
    sequence: 0,
    messageId: null,
    toolIds: [],
    ...partial,
  };
}

function nextSeq(state: LegacyAdapterState): number {
  state.sequence += 1;
  return state.sequence;
}

function eventId(state: LegacyAdapterState, seq: number): string {
  return `legacy_${state.runId}_${seq}`;
}

/**
 * Convert one legacy chat SSE event into zero or more RuntimeEvents.
 * Mutates adapter state (sequence cursor, message/tool ids).
 */
export function legacyEventToRuntime(
  state: LegacyAdapterState,
  ev: SSEEvent,
): RuntimeEvent[] {
  const type = String(ev.type || '');
  const out: RuntimeEvent[] = [];
  const base = {
    run_id: state.runId,
    session_id: state.sessionId,
  };

  switch (type) {
    case 'trace':
      // No entity change; skip envelope noise
      break;

    case 'session': {
      if (ev.session_id) state.sessionId = String(ev.session_id);
      if (ev.conversation_id) state.conversationId = String(ev.conversation_id);
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.started',
          payload: {
            conversation_id: state.conversationId,
            session_id: state.sessionId,
            ...(ev.trace_id ? { trace_id: String(ev.trace_id) } : {}),
          },
        }),
      );
      break;
    }

    case 'token': {
      if (!state.messageId) {
        const startSeq = nextSeq(state);
        state.messageId = `msg_${state.runId}`;
        out.push(
          makeRuntimeEvent({
            ...base,
            event_id: eventId(state, startSeq),
            sequence: startSeq,
            session_id: state.sessionId,
            type: 'message.started',
            payload: {
              message_id: state.messageId,
              role: 'assistant',
            },
          }),
        );
      }
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'message.delta',
          payload: {
            message_id: state.messageId,
            text: String(ev.text || ''),
          },
        }),
      );
      break;
    }

    case 'tool_start': {
      const toolId =
        ev.id != null ? String(ev.id) : `tool_${state.runId}_${state.toolIds.length}`;
      state.toolIds.push(toolId);
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'tool.started',
          payload: {
            tool_call_id: toolId,
            name: String(ev.name || 'tool'),
            args: ev.args ?? {},
          },
        }),
      );
      break;
    }

    case 'tool_end': {
      const toolId =
        ev.id != null
          ? String(ev.id)
          : state.toolIds[state.toolIds.length - 1] || `tool_${state.runId}_end`;
      const seq = nextSeq(state);
      const failed = Boolean(ev.isError);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: failed ? 'tool.failed' : 'tool.completed',
          payload: {
            tool_call_id: toolId,
            result: ev.result,
            is_error: failed,
          },
        }),
      );
      break;
    }

    case 'file_ready': {
      const seq = nextSeq(state);
      const artifactId =
        ev.artifact_id != null
          ? String(ev.artifact_id)
          : `art_${state.runId}_${seq}`;
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'artifact.created',
          payload: {
            artifact_id: artifactId,
            name: ev.name != null ? String(ev.name) : undefined,
            path: ev.path != null ? String(ev.path) : undefined,
            mime_type: ev.mime_type != null ? String(ev.mime_type) : undefined,
            size: typeof ev.size === 'number' ? ev.size : undefined,
            session_id: state.sessionId,
          },
        }),
      );
      break;
    }

    case 'approval_required': {
      const approvalId = String(ev.approval_id || ev.id || '');
      if (!approvalId) break;
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'tool.approval_required',
          payload: {
            approval_id: approvalId,
            reason: String(ev.reason || ev.command || ''),
            command: ev.command != null ? String(ev.command) : undefined,
            tool_call_id: ev.tool_call_id != null ? String(ev.tool_call_id) : undefined,
          },
        }),
      );
      break;
    }

    case 'error': {
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.failed',
          payload: {
            message: String(ev.message || ev.text || 'Unknown error'),
          },
        }),
      );
      break;
    }

    case 'done': {
      if (state.messageId) {
        const doneMsgSeq = nextSeq(state);
        out.push(
          makeRuntimeEvent({
            ...base,
            event_id: eventId(state, doneMsgSeq),
            sequence: doneMsgSeq,
            session_id: state.sessionId,
            type: 'message.completed',
            payload: { message_id: state.messageId },
          }),
        );
      }
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.completed',
          payload: {},
        }),
      );
      break;
    }

    case 'session_closed': {
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.status_changed',
          payload: { status: 'cancelled' },
        }),
      );
      break;
    }

    case 'budget_warning': {
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'budget.warning',
          payload: {
            usage: ev.usage ?? null,
            limits: ev.limits ?? null,
            message: ev.message != null ? String(ev.message) : undefined,
          },
        }),
      );
      break;
    }

    case 'budget_exceeded': {
      const seq = nextSeq(state);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq),
          sequence: seq,
          session_id: state.sessionId,
          type: 'budget.exceeded',
          payload: {
            usage: ev.usage ?? null,
            limits: ev.limits ?? null,
            reason: ev.reason != null ? String(ev.reason) : undefined,
            message:
              ev.message != null
                ? String(ev.message)
                : ev.reason != null
                  ? String(ev.reason)
                  : 'Budget exceeded',
          },
        }),
      );
      break;
    }

    default:
      // Unknown legacy types ignored
      break;
  }

  return out;
}

/**
 * Convenience: map a list of legacy events through the adapter.
 */
export function adaptLegacyStream(
  runId: string,
  events: SSEEvent[],
  seed: Partial<LegacyAdapterState> = {},
): { events: RuntimeEvent[]; state: LegacyAdapterState } {
  const state = createLegacyAdapterState({ runId, ...seed });
  const all: RuntimeEvent[] = [];
  for (const ev of events) {
    all.push(...legacyEventToRuntime(state, ev));
  }
  return { events: all, state };
}
