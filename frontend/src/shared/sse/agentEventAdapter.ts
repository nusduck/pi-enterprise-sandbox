/**
 * Agent wire-event adapter: sequenced Agent SSE / persisted event payloads
 * → normalized RuntimeEvent envelopes consumed by the EntityStore reducer.
 */
import type { RuntimeEvent } from '../schemas/events';
import { makeRuntimeEvent } from '../schemas/events';
import type { SSEEvent } from './parser';

export type AgentEventAdapterState = {
  runId: string;
  sessionId: string | null;
  conversationId: string | null;
  workspaceId: string | null;
  modelId: string | null;
  sequence: number;
  /** Active streaming message id for token deltas. */
  messageId: string | null;
  /** Map tool index / id → tool execution id. */
  toolIds: string[];
  /** Terminal status already emitted for this run stream. */
  terminalStatus: 'succeeded' | 'failed' | 'cancelled' | 'budget_exceeded' | null;
  suspendedStatus: 'waiting_approval' | 'waiting_input' | null;
};

export function createAgentEventAdapterState(
  partial: Partial<AgentEventAdapterState> & { runId: string },
): AgentEventAdapterState {
  return {
    sessionId: null,
    conversationId: null,
    workspaceId: null,
    modelId: null,
    sequence: 0,
    messageId: null,
    toolIds: [],
    terminalStatus: null,
    suspendedStatus: null,
    ...partial,
  };
}

/**
 * Prefer durable history sequence when present (conversation event projection
 * after refresh). Synthesize only for live Agent streams that omit sequence.
 * Multi-output wire events (e.g. token → started+delta) pass `ev` only to the
 * first nextSeq call so a single durable sequence is not double-applied.
 */
/** Wire event bags (SSEEvent / history rows) carry optional durable fields. */
type WireEventFields = Record<string, unknown> | null | undefined;

function nextSeq(state: AgentEventAdapterState, ev?: WireEventFields): number {
  const seqRaw = ev?.sequence;
  const persistedRaw = ev?.persisted_sequence;
  const durable =
    typeof seqRaw === 'number'
      ? seqRaw
      : typeof persistedRaw === 'number'
        ? persistedRaw
        : null;
  if (durable != null && Number.isFinite(durable) && durable >= 0) {
    state.sequence = Math.max(state.sequence, durable);
    return durable;
  }
  state.sequence += 1;
  return state.sequence;
}

function durableEventId(
  state: AgentEventAdapterState,
  seq: number,
  ev?: WireEventFields,
): string {
  for (const candidate of [ev?.event_id, ev?.eventId, ev?.persisted_event_id]) {
    if (candidate != null && String(candidate).length > 0) {
      return String(candidate);
    }
  }
  return `agent_${state.runId}_${seq}`;
}

function eventId(
  state: AgentEventAdapterState,
  seq: number,
  ev?: WireEventFields,
): string {
  return durableEventId(state, seq, ev);
}

/**
 * Convert one Agent wire event into zero or more RuntimeEvents.
 * Mutates adapter state (sequence cursor, message/tool ids).
 */
export function agentEventToRuntime(
  state: AgentEventAdapterState,
  ev: SSEEvent,
): RuntimeEvent[] {
  const type = String(ev.type || '');
  const out: RuntimeEvent[] = [];
  const base = {
    run_id: state.runId,
    session_id: state.sessionId,
  };

  switch (type) {
    case 'trace': {
      if (!ev.trace_id) break;
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          type: 'run.trace',
          payload: { trace_id: String(ev.trace_id) },
        }),
      );
      break;
    }

    case 'session': {
      if (ev.session_id) state.sessionId = String(ev.session_id);
      if (ev.conversation_id) state.conversationId = String(ev.conversation_id);
      if (ev.workspace_id) state.workspaceId = String(ev.workspace_id);
      if (ev.model_id) state.modelId = String(ev.model_id);
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.started',
          payload: {
            conversation_id: state.conversationId,
            session_id: state.sessionId,
            workspace_id: state.workspaceId,
            model_id: state.modelId,
            ...(ev.trace_id ? { trace_id: String(ev.trace_id) } : {}),
          },
        }),
      );
      break;
    }

    case 'agent_session': {
      const agentSessionId = String(ev.agent_session_id || '');
      if (!agentSessionId) break;
      if (ev.conversation_id) state.conversationId = String(ev.conversation_id);
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'session.restored',
          payload: {
            agent_session_id: agentSessionId,
            conversation_id: state.conversationId,
            sandbox_session_id: state.sessionId,
            workspace_id:
              ev.workspace_id != null ? String(ev.workspace_id) : state.workspaceId,
            model_id:
              ev.model_id != null ? String(ev.model_id) : state.modelId,
            restored: Boolean(ev.restored),
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
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
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
      const seq = nextSeq(state, ev);
      const failed = Boolean(ev.isError);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
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
      const seq = nextSeq(state, ev);
      const artifactId =
        ev.artifact_id != null
          ? String(ev.artifact_id)
          : `art_${state.runId}_${seq}`;
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
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
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'tool.approval_required',
          payload: {
            approval_id: approvalId,
            idempotency_key: ev.idempotency_key != null ? String(ev.idempotency_key) : undefined,
            reason: String(ev.reason || ev.command || ''),
            command: ev.command != null ? String(ev.command) : undefined,
            tool_call_id: ev.tool_call_id != null ? String(ev.tool_call_id) : undefined,
          },
        }),
      );
      state.suspendedStatus = 'waiting_approval';
      break;
    }

    case 'interaction_requested': {
      state.suspendedStatus = 'waiting_input';
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.status_changed',
          payload: {
            status: 'waiting_input',
            interaction_id: ev.interaction_id,
            interaction_type: ev.interaction_type,
            title: ev.title,
            message: ev.message,
            options: ev.options,
          },
        }),
      );
      break;
    }

    case 'interaction_resolved': {
      state.suspendedStatus = null;
      const seq = nextSeq(state, ev);
      out.push(makeRuntimeEvent({
        ...base,
        event_id: eventId(state, seq, ev),
        sequence: seq,
        session_id: state.sessionId,
        type: 'run.status_changed',
        payload: { status: 'running', interaction_id: ev.interaction_id },
      }));
      break;
    }

    case 'context_stats':
    case 'context_warning': {
      const seq = nextSeq(state, ev);
      out.push(makeRuntimeEvent({
        ...base,
        event_id: eventId(state, seq, ev),
        sequence: seq,
        session_id: state.sessionId,
        type: 'run.context_updated',
        payload: { ...ev, warning: ev.type === 'context_warning' },
      }));
      break;
    }

    case 'task_plan_updated': {
      const seq = nextSeq(state, ev);
      out.push(makeRuntimeEvent({
        ...base,
        event_id: eventId(state, seq, ev),
        sequence: seq,
        session_id: state.sessionId,
        type: 'run.task_plan_updated',
        payload: { tasks: ev.tasks },
      }));
      break;
    }

    case 'compaction_started':
    case 'compaction_completed':
    case 'compaction_failed': {
      const seq = nextSeq(state, ev);
      out.push(makeRuntimeEvent({
        ...base,
        event_id: eventId(state, seq, ev),
        sequence: seq,
        session_id: state.sessionId,
        type: 'run.compaction_updated',
        payload: {
          status: ev.type === 'compaction_started'
            ? 'running'
            : ev.type === 'compaction_completed'
              ? 'completed'
              : 'failed',
          error: ev.error,
          reason: ev.reason,
        },
      }));
      break;
    }

    case 'run_status': {
      const status = String(ev.status || '');
      if (status === 'waiting_approval' || status === 'waiting_input') {
        state.suspendedStatus = status;
      } else if (status === 'running') {
        state.suspendedStatus = null;
      }
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.status_changed',
          payload: { ...ev, status },
        }),
      );
      break;
    }

    case 'error': {
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.failed',
          payload: {
            message: String(ev.message || ev.text || 'Unknown error'),
          },
        }),
      );
      state.terminalStatus = 'failed';
      break;
    }

    case 'done': {
      // Durable history sequences apply only to the first synthetic emit.
      let durableConsumed = false;
      const takeSeq = () => {
        if (!durableConsumed) {
          durableConsumed = true;
          return nextSeq(state, ev);
        }
        return nextSeq(state);
      };
      if (state.messageId) {
        const doneMsgSeq = takeSeq();
        out.push(
          makeRuntimeEvent({
            ...base,
            event_id: eventId(state, doneMsgSeq, durableConsumed ? null : ev),
            sequence: doneMsgSeq,
            session_id: state.sessionId,
            type: 'message.completed',
            payload: { message_id: state.messageId },
          }),
        );
      }
      if (!state.terminalStatus) {
        const seq = takeSeq();
        const rawStatus = String(ev.status || '');
        const status =
          rawStatus === 'cancelled'
            ? 'cancelled'
            : rawStatus === 'budget_exceeded'
              ? 'budget_exceeded'
              : rawStatus === 'rejected' || rawStatus === 'failed'
                ? 'failed'
                : 'succeeded';
        out.push(
          makeRuntimeEvent({
            ...base,
            event_id: eventId(state, seq, state.messageId ? null : ev),
            sequence: seq,
            session_id: state.sessionId,
            type: status === 'succeeded' ? 'run.completed' : 'run.status_changed',
            payload: { status },
          }),
        );
        state.terminalStatus = status;
      }
      break;
    }

    case 'session_closed': {
      // Normal streams emit done before session_closed. Never let the lifecycle
      // tail overwrite an already terminal run (especially succeeded → cancelled).
      if (state.terminalStatus) break;
      if (state.suspendedStatus) break;
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
          sequence: seq,
          session_id: state.sessionId,
          type: 'run.status_changed',
          payload: { status: 'cancelled' },
        }),
      );
      state.terminalStatus = 'cancelled';
      break;
    }

    case 'budget_warning': {
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
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
      const seq = nextSeq(state, ev);
      out.push(
        makeRuntimeEvent({
          ...base,
          event_id: eventId(state, seq, ev),
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
      state.terminalStatus = 'budget_exceeded';
      break;
    }

    default:
      // Unknown extension events are intentionally ignored by this projection.
      break;
  }

  return out;
}

/**
 * Convenience: map a list of Agent events through the adapter.
 */
export function adaptAgentEventStream(
  runId: string,
  events: SSEEvent[],
  seed: Partial<AgentEventAdapterState> = {},
): { events: RuntimeEvent[]; state: AgentEventAdapterState } {
  const state = createAgentEventAdapterState({ runId, ...seed });
  const all: RuntimeEvent[] = [];
  for (const ev of events) {
    all.push(...agentEventToRuntime(state, ev));
  }
  return { events: all, state };
}
