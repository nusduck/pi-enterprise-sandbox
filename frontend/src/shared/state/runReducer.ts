/**
 * Run Event Reducer — applies RuntimeEvents to the normalized EntityStore.
 * Pure: no I/O or DOM mutation (F2 / ADR 0003 §13–15).
 */
import type { EntityStore, RunEntity, RunStatus } from '../../entities/types';
import {
  createAgentSession,
  createApproval,
  createArtifact,
  createMessage,
  createProcess,
  createRun,
  createToolExecution,
  isTerminalRunStatus,
  setActiveConversation,
  upsertApproval,
  upsertAgentSession,
  upsertArtifact,
  upsertMessage,
  upsertProcess,
  upsertRun,
  upsertToolExecution,
} from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import { parseRuntimeEvent } from '../schemas/events';

export type ReduceOutcome =
  | 'applied'
  | 'duplicate'
  | 'out_of_order'
  | 'gap'
  | 'ignored'
  | 'invalid';

export type ReduceResult = {
  store: EntityStore;
  outcome: ReduceOutcome;
  /** True when sequence jumped ahead of lastSequence + 1. */
  sequenceGap: boolean;
  appliedSequence: number | null;
  eventId: string | null;
};

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
}

function ensureRun(
  store: EntityStore,
  runId: string,
  ev: RuntimeEvent,
): EntityStore {
  if (store.runsById[runId]) return store;
  return upsertRun(
    store,
    createRun({
      id: runId,
      conversationId: str(ev.payload.conversation_id) || null,
      agentSessionId: str(ev.payload.agent_session_id) || null,
      sandboxSessionId: str(ev.session_id) || str(ev.payload.session_id) || null,
      status: 'queued',
      createdAt: ev.timestamp || null,
    }),
  );
}

function touchRun(
  store: EntityStore,
  runId: string,
  patch: Partial<ReturnType<typeof createRun>>,
): EntityStore {
  const run = store.runsById[runId];
  if (!run) return store;
  return upsertRun(store, {
    ...run,
    ...patch,
    updatedAt: patch.updatedAt ?? patch.finishedAt ?? patch.startedAt ?? run.updatedAt,
  });
}

function advanceCursor(
  store: EntityStore,
  runId: string,
  sequence: number,
  eventId: string,
): EntityStore {
  const run = store.runsById[runId];
  if (!run) return store;
  return upsertRun(store, {
    ...run,
    lastSequence: sequence,
    lastEventId: eventId,
    updatedAt: run.updatedAt,
  });
}

/**
 * Check sequence / dedupe before applying.
 * - duplicate: same event_id already applied OR sequence <= lastSequence
 * - out_of_order: sequence < lastSequence (and not same event)
 * - gap: sequence > lastSequence + 1 (still applied; caller may backfill)
 */
export function classifyEvent(
  store: EntityStore,
  ev: RuntimeEvent,
  seenEventIds?: Set<string>,
): ReduceOutcome {
  if (!ev.event_id || !ev.run_id || typeof ev.sequence !== 'number') {
    return 'invalid';
  }
  if (seenEventIds?.has(ev.event_id)) return 'duplicate';

  const run = store.runsById[ev.run_id];
  if (!run) return 'applied'; // new run — will be created

  if (run.lastEventId === ev.event_id) return 'duplicate';
  if (ev.sequence <= run.lastSequence) {
    // Already past this sequence — treat as duplicate/out-of-order
    return ev.sequence < run.lastSequence ? 'out_of_order' : 'duplicate';
  }
  if (ev.sequence > run.lastSequence + 1) return 'gap';
  return 'applied';
}

/**
 * Apply one RuntimeEvent to the entity store.
 * Does NOT mutate nested message content in place — each delta produces a new MessageEntity snapshot.
 */
export function reduceRuntimeEvent(
  store: EntityStore,
  raw: RuntimeEvent | unknown,
  opts: { seenEventIds?: Set<string>; applyOutOfOrder?: boolean } = {},
): ReduceResult {
  const ev = parseRuntimeEvent(raw) ?? (raw as RuntimeEvent | null);
  if (
    !ev ||
    typeof ev !== 'object' ||
    !ev.event_id ||
    !ev.run_id ||
    typeof ev.sequence !== 'number'
  ) {
    return {
      store,
      outcome: 'invalid',
      sequenceGap: false,
      appliedSequence: null,
      eventId: null,
    };
  }

  const outcome = classifyEvent(store, ev, opts.seenEventIds);
  if (outcome === 'duplicate' || outcome === 'invalid') {
    return {
      store,
      outcome,
      sequenceGap: false,
      appliedSequence: null,
      eventId: ev.event_id,
    };
  }
  if (outcome === 'out_of_order' && !opts.applyOutOfOrder) {
    return {
      store,
      outcome: 'out_of_order',
      sequenceGap: false,
      appliedSequence: null,
      eventId: ev.event_id,
    };
  }

  const sequenceGap = outcome === 'gap';
  let next = ensureRun(store, ev.run_id, ev);
  const runId = ev.run_id;
  const payload = ev.payload || {};
  const ts = ev.timestamp || null;

  switch (ev.type) {
    case 'run.created': {
      next = touchRun(next, runId, {
        status: (str(payload.status, 'queued') as RunStatus) || 'queued',
        conversationId:
          str(payload.conversation_id) || next.runsById[runId]?.conversationId || null,
        agentSessionId:
          str(payload.agent_session_id) || next.runsById[runId]?.agentSessionId || null,
        sandboxSessionId:
          str(ev.session_id) ||
          str(payload.session_id) ||
          next.runsById[runId]?.sandboxSessionId ||
          null,
        createdAt: ts || next.runsById[runId]?.createdAt,
      });
      break;
    }

    case 'run.started': {
      const conversationId =
        str(payload.conversation_id) ||
        next.runsById[runId]?.conversationId ||
        null;
      next = touchRun(next, runId, {
        status: 'running',
        conversationId,
        startedAt: ts || next.runsById[runId]?.startedAt,
        sandboxSessionId:
          str(ev.session_id) ||
          str(payload.session_id) ||
          next.runsById[runId]?.sandboxSessionId ||
          null,
        traceId:
          str(payload.trace_id) || next.runsById[runId]?.traceId || null,
      });
      if (
        conversationId &&
        (next.activeRunId === runId || next.activeConversationId == null)
      ) {
        next = setActiveConversation(next, conversationId, { activeRunId: runId });
      }
      break;
    }

    case 'run.trace': {
      next = touchRun(next, runId, {
        traceId: str(payload.trace_id) || next.runsById[runId]?.traceId || null,
      });
      break;
    }

    case 'run.status_changed': {
      const status = str(payload.status) as RunStatus;
      if (status) {
        next = touchRun(next, runId, {
          status,
          error:
            str(payload.error || payload.message) ||
            next.runsById[runId]?.error ||
            null,
          ...(isTerminalRunStatus(status)
            ? { finishedAt: ts || next.runsById[runId]?.finishedAt }
            : {}),
        });
      }
      break;
    }

    case 'run.completed': {
      next = touchRun(next, runId, {
        status: 'succeeded',
        finishedAt: ts,
      });
      // Complete any streaming messages
      const run = next.runsById[runId];
      if (run) {
        for (const mid of run.messageIds) {
          const msg = next.messagesById[mid];
          if (msg && msg.status === 'streaming') {
            next = upsertMessage(next, { ...msg, status: 'complete', updatedAt: ts });
          }
        }
      }
      break;
    }

    case 'run.failed': {
      next = touchRun(next, runId, {
        status: 'failed',
        error: str(payload.message || payload.error, 'Run failed'),
        finishedAt: ts,
      });
      break;
    }

    case 'message.started': {
      const messageId = str(payload.message_id || payload.id, `msg_${runId}_${ev.sequence}`);
      next = upsertMessage(
        next,
        createMessage({
          id: messageId,
          runId,
          conversationId: next.runsById[runId]?.conversationId || null,
          role: (str(payload.role, 'assistant') as 'assistant') || 'assistant',
          text: str(payload.text),
          status: 'streaming',
          createdAt: ts,
        }),
      );
      break;
    }

    case 'message.delta': {
      const messageId = str(payload.message_id || payload.id);
      const delta = str(payload.text || payload.delta);
      if (messageId && next.messagesById[messageId]) {
        const msg = next.messagesById[messageId];
        next = upsertMessage(next, {
          ...msg,
          text: msg.text + delta,
          status: 'streaming',
          updatedAt: ts,
        });
      } else {
        // Implicit start: create streaming message if missing
        const id = messageId || `msg_${runId}_stream`;
        const existing = next.messagesById[id];
        next = upsertMessage(
          next,
          createMessage({
            id,
            runId,
            conversationId: next.runsById[runId]?.conversationId || null,
            role: 'assistant',
            text: (existing?.text || '') + delta,
            status: 'streaming',
            createdAt: existing?.createdAt || ts,
            updatedAt: ts,
          }),
        );
      }
      break;
    }

    case 'message.completed': {
      const messageId = str(payload.message_id || payload.id);
      if (messageId && next.messagesById[messageId]) {
        const msg = next.messagesById[messageId];
        const finalText =
          payload.text != null ? str(payload.text) : msg.text;
        next = upsertMessage(next, {
          ...msg,
          text: finalText,
          status: 'complete',
          updatedAt: ts,
        });
      }
      break;
    }

    case 'tool.prepared':
    case 'tool.started': {
      const toolId = str(payload.tool_call_id || payload.id || payload.tool_id);
      if (!toolId) break;
      const existing = next.toolExecutionsById[toolId];
      next = upsertToolExecution(
        next,
        createToolExecution({
          id: toolId,
          runId,
          name: str(payload.name || existing?.name, 'tool'),
          status: ev.type === 'tool.prepared' ? 'prepared' : 'running',
          input: payload.input ?? payload.args ?? existing?.input ?? null,
          summary: payload.summary != null ? str(payload.summary) : existing?.summary ?? null,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      if (ev.type === 'tool.started') {
        next = touchRun(next, runId, { status: 'running' });
      }
      break;
    }

    case 'tool.approval_required': {
      const approvalId = str(payload.approval_id || payload.id);
      const toolId = str(payload.tool_call_id || payload.tool_id) || null;
      if (!approvalId) break;
      next = upsertApproval(
        next,
        createApproval({
          id: approvalId,
          runId,
          toolExecutionId: toolId,
          status: 'pending',
          reason: str(payload.reason || payload.command),
          command: payload.command != null ? str(payload.command) : null,
          createdAt: ts,
        }),
      );
      if (toolId) {
        const tool = next.toolExecutionsById[toolId];
        if (tool) {
          next = upsertToolExecution(next, {
            ...tool,
            status: 'waiting_approval',
            approvalId,
            updatedAt: ts,
          });
        }
      }
      next = touchRun(next, runId, { status: 'waiting_approval' });
      break;
    }

    case 'tool.completed':
    case 'tool.failed': {
      const toolId = str(payload.tool_call_id || payload.id || payload.tool_id);
      if (!toolId) break;
      const existing = next.toolExecutionsById[toolId];
      next = upsertToolExecution(
        next,
        createToolExecution({
          id: toolId,
          runId,
          name: str(payload.name || existing?.name, 'tool'),
          status: ev.type === 'tool.failed' ? 'failed' : 'completed',
          input: existing?.input ?? payload.input ?? payload.args ?? null,
          result: payload.result ?? existing?.result ?? null,
          isError: ev.type === 'tool.failed' || Boolean(payload.is_error || payload.isError),
          approvalId: existing?.approvalId ?? null,
          processId: existing?.processId ?? null,
          summary: existing?.summary ?? null,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      break;
    }

    case 'process.started': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      next = upsertProcess(
        next,
        createProcess({
          id: processId,
          runId,
          toolExecutionId: str(payload.tool_call_id) || null,
          status: 'running',
          command: payload.command != null ? str(payload.command) : null,
          startedAt: ts,
          createdAt: ts,
        }),
      );
      break;
    }

    case 'process.stdout':
    case 'process.stderr': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      const proc =
        next.processesById[processId] ||
        createProcess({ id: processId, runId, status: 'running' });
      const chunk = str(payload.text || payload.chunk || payload.data);
      next = upsertProcess(next, {
        ...proc,
        runId,
        stdout:
          ev.type === 'process.stdout' ? proc.stdout + chunk : proc.stdout,
        stderr:
          ev.type === 'process.stderr' ? proc.stderr + chunk : proc.stderr,
        status: 'running',
        updatedAt: ts,
      });
      break;
    }

    case 'process.completed':
    case 'process.failed': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      const proc =
        next.processesById[processId] ||
        createProcess({ id: processId, runId });
      next = upsertProcess(next, {
        ...proc,
        runId,
        status: ev.type === 'process.failed' ? 'failed' : 'completed',
        exitCode:
          typeof payload.exit_code === 'number'
            ? payload.exit_code
            : typeof payload.exitCode === 'number'
              ? payload.exitCode
              : proc.exitCode,
        finishedAt: ts,
        updatedAt: ts,
      });
      break;
    }

    case 'artifact.created': {
      const artifactId = str(
        payload.artifact_id || payload.id,
        `art_${runId}_${ev.sequence}`,
      );
      next = upsertArtifact(
        next,
        createArtifact({
          id: artifactId,
          runId,
          sessionId:
            str(ev.session_id) ||
            str(payload.session_id) ||
            next.runsById[runId]?.sandboxSessionId ||
            null,
          name: str(payload.name, artifactId),
          path: payload.path != null ? str(payload.path) : null,
          mimeType:
            payload.mime_type != null
              ? str(payload.mime_type)
              : payload.mimeType != null
                ? str(payload.mimeType)
                : null,
          size: typeof payload.size === 'number' ? payload.size : null,
          createdAt: ts,
        }),
      );
      break;
    }

    case 'session.restored': {
      const agentSessionId =
        str(payload.agent_session_id || payload.session_id) ||
        next.runsById[runId]?.agentSessionId ||
        null;
      const conversationId =
        str(payload.conversation_id) ||
        next.runsById[runId]?.conversationId ||
        null;
      const sandboxSessionId =
        str(ev.session_id) ||
        str(payload.sandbox_session_id) ||
        next.runsById[runId]?.sandboxSessionId ||
        null;
      next = touchRun(next, runId, {
        // Legacy agent_session arrives after restore/create has completed.
        status:
          next.runsById[runId]?.status === 'queued'
            ? 'running'
            : next.runsById[runId]?.status,
        agentSessionId,
        sandboxSessionId,
      });
      if (agentSessionId && conversationId) {
        next = upsertAgentSession(
          next,
          createAgentSession({
            id: agentSessionId,
            conversationId,
            sandboxSessionId,
            workspaceId: str(payload.workspace_id) || null,
            modelId: str(payload.model_id) || null,
            status: 'active',
            runIds: [runId],
            updatedAt: ts,
          }),
        );
      }
      break;
    }

    case 'session.compacted': {
      // No run status change; metadata only
      break;
    }

    case 'budget.warning': {
      next = touchRun(next, runId, {
        budgetUsage:
          payload.usage && typeof payload.usage === 'object'
            ? (payload.usage as RunEntity['budgetUsage'])
            : next.runsById[runId]?.budgetUsage || null,
        budgetLimits:
          payload.limits && typeof payload.limits === 'object'
            ? (payload.limits as RunEntity['budgetLimits'])
            : next.runsById[runId]?.budgetLimits || null,
        budgetWarning: 'warning',
      });
      break;
    }

    case 'budget.exceeded': {
      next = touchRun(next, runId, {
        status: 'budget_exceeded',
        error: str(
          payload.message || payload.reason,
          'Budget exceeded',
        ),
        budgetUsage:
          payload.usage && typeof payload.usage === 'object'
            ? (payload.usage as RunEntity['budgetUsage'])
            : next.runsById[runId]?.budgetUsage || null,
        budgetLimits:
          payload.limits && typeof payload.limits === 'object'
            ? (payload.limits as RunEntity['budgetLimits'])
            : next.runsById[runId]?.budgetLimits || null,
        budgetWarning: 'exceeded',
        finishedAt: ts,
      });
      break;
    }

    default:
      // Unknown types: still advance cursor so sequence resume stays correct
      break;
  }

  next = advanceCursor(next, runId, ev.sequence, ev.event_id);
  opts.seenEventIds?.add(ev.event_id);

  return {
    store: next,
    outcome: sequenceGap ? 'gap' : 'applied',
    sequenceGap,
    appliedSequence: ev.sequence,
    eventId: ev.event_id,
  };
}

/**
 * Apply a batch of events in sequence order (sorts first).
 * Duplicates / out-of-order are skipped.
 */
export function reduceRuntimeEventBatch(
  store: EntityStore,
  events: unknown[],
  opts: { seenEventIds?: Set<string> } = {},
): { store: EntityStore; applied: number; skipped: number; gaps: number } {
  const parsed = events
    .map((e) => parseRuntimeEvent(e) ?? (e as RuntimeEvent))
    .filter((e) => e && e.event_id && typeof e.sequence === 'number')
    .sort((a, b) => a.sequence - b.sequence);

  let next = store;
  let applied = 0;
  let skipped = 0;
  let gaps = 0;

  for (const ev of parsed) {
    const result = reduceRuntimeEvent(next, ev, opts);
    next = result.store;
    if (result.outcome === 'applied' || result.outcome === 'gap') {
      applied += 1;
      if (result.sequenceGap) gaps += 1;
    } else {
      skipped += 1;
    }
  }

  return { store: next, applied, skipped, gaps };
}

/**
 * Rehydrate an in-progress run from API detail + optional missed events.
 * Stub-friendly when backend run API is incomplete.
 */
export function rehydrateRun(
  store: EntityStore,
  detail: {
    id?: string;
    run_id?: string;
    conversation_id?: string | null;
    session_id?: string | null;
    agent_session_id?: string | null;
    status?: string;
    last_sequence?: number | null;
    last_event_id?: string | null;
    error?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
    created_at?: string | null;
    budget?: unknown;
    budget_limits?: unknown;
  },
  missedEvents: unknown[] = [],
): EntityStore {
  const runId = detail.run_id || detail.id;
  if (!runId) return store;

  const budgetUsage =
    detail.budget && typeof detail.budget === 'object'
      ? (detail.budget as RunEntity['budgetUsage'])
      : null;
  const budgetLimits =
    detail.budget_limits && typeof detail.budget_limits === 'object'
      ? (detail.budget_limits as RunEntity['budgetLimits'])
      : null;

  let next = upsertRun(
    store,
    createRun({
      id: runId,
      conversationId: detail.conversation_id || null,
      agentSessionId: detail.agent_session_id || null,
      sandboxSessionId: detail.session_id || null,
      status: (detail.status as RunStatus) || 'running',
      lastSequence: detail.last_sequence ?? 0,
      lastEventId: detail.last_event_id || null,
      error: detail.error || null,
      budgetUsage,
      budgetLimits,
      startedAt: detail.started_at || null,
      finishedAt: detail.finished_at || null,
      createdAt: detail.created_at || null,
    }),
  );

  if (missedEvents.length) {
    next = reduceRuntimeEventBatch(next, missedEvents).store;
  }

  return next;
}
