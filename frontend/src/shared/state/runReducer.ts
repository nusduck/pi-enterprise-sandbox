/**
 * Unified Event Reducer (plan §19.3) — applies RuntimeEvents / platform
 * envelopes to the normalized EntityStore.
 * Pure: no I/O or DOM mutation (F2 / ADR 0003 §13–15).
 *
 * Live SSE and historical replay share this path.
 */
import type {
  EntityStore,
  RunStatus,
} from '../../entities/types';
import {
  createRun,
  createTraceSpan,
  isTerminalRunStatus,
  setActiveConversation,
  upsertMessage,
  upsertRun,
  upsertTraceSpan,
} from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import { parseRuntimeEvent } from '../schemas/events';
import {
  capSeenEventIds,
  normalizeToRuntimeEvent,
} from './platformEventNormalize';
import { reduceMessageEvent } from './messageEvents';
import { canFocusStartedRun } from './runFocusPolicy';
import { reduceToolEvent } from './toolEvents';
import { reduceArtifactEvent } from './artifactEvents';

export { isDurableArtifactId } from './artifactEvents';
export { rehydrateRun, rehydrateToolExecutions } from './runRehydration';

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
 * - gap: sequence > lastSequence + 1 — must NOT apply (caller re-subscribes)
 * - new run with sequence > 1 is also a gap (expected first is sequence 1)
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
  // Virtual cursor 0 when the run entity does not exist yet.
  const lastSequence = run?.lastSequence ?? 0;
  const lastEventId = run?.lastEventId ?? null;

  if (lastEventId && lastEventId === ev.event_id) return 'duplicate';
  if (ev.sequence <= lastSequence) {
    return ev.sequence < lastSequence ? 'out_of_order' : 'duplicate';
  }
  // Expected next is lastSequence + 1. Jumping ahead is a gap — never apply.
  // New runs (lastSequence 0) require sequence === 1; sequence > 1 is a gap.
  if (ev.sequence > lastSequence + 1) return 'gap';
  return 'applied';
}

/**
 * Apply one RuntimeEvent (or platform envelope) to the entity store.
 * Does NOT mutate nested message content in place — each delta produces a new MessageEntity snapshot.
 */
export function reduceRuntimeEvent(
  store: EntityStore,
  raw: RuntimeEvent | unknown,
  opts: { seenEventIds?: Set<string>; applyOutOfOrder?: boolean } = {},
): ReduceResult {
  // Platform envelopes and RuntimeEvents share one normalize path.
  const normalized = normalizeToRuntimeEvent(raw);
  const ev =
    normalized ||
    parseRuntimeEvent(raw) ||
    (raw as RuntimeEvent | null);
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
  // Gap: never mutate store, never advance cursor / seen set. Caller must
  // resubscribe from the previous lastSequence (authoritative replay).
  if (outcome === 'gap') {
    return {
      store,
      outcome: 'gap',
      sequenceGap: true,
      appliedSequence: null,
      eventId: ev.event_id,
    };
  }

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
      if (canFocusStartedRun(next, runId, conversationId)) {
        next = setActiveConversation(next, conversationId, { activeRunId: runId });
      }
      break;
    }

    case 'run.status_changed': {
      const status = str(payload.status) as RunStatus;
      if (status) {
        next = touchRun(next, runId, {
          status,
          pendingInput:
            status === 'waiting_input'
              ? {
                  interactionId: str(payload.interaction_id),
                  interactionType: str(payload.interaction_type, 'input'),
                  title: str(payload.title, 'Input required'),
                  message: payload.message != null ? str(payload.message) : null,
                  options: Array.isArray(payload.options)
                    ? payload.options.map((item) => str(item)).filter(Boolean)
                    : [],
                }
              : null,
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
          if (msg && (msg.status === 'streaming' || msg.thinkingStatus === 'streaming')) {
            next = upsertMessage(next, {
              ...msg,
              status: msg.status === 'streaming' ? 'complete' : msg.status,
              thinkingStatus: msg.thinkingStatus === 'streaming' ? 'complete' : msg.thinkingStatus,
              updatedAt: ts,
            });
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

    case 'run.cancelled': {
      next = touchRun(next, runId, {
        status: 'cancelled',
        error: str(payload.message || payload.error) || null,
        finishedAt: ts,
        pendingInput: null,
      });
      break;
    }

    case 'message.delta':
    case 'thinking.started':
    case 'thinking.delta':
    case 'thinking.completed':
    case 'message.completed':
      next = reduceMessageEvent(next, ev, payload, ts);
      break;

    case 'tool.prepared':
    case 'tool.started':
    case 'tool.progress':
    case 'tool.approval_required':
    case 'approval.resolved':
    case 'tool.completed':
    case 'tool.failed':
      next = reduceToolEvent(next, ev, payload, ts);
      break;

    case 'artifact.released':
    case 'review.rejected':
    case 'artifact.created':
      next = reduceArtifactEvent(next, ev, payload, ts);
      break;

    case 'model.request.started':
    case 'model.request.completed':
    case 'model.request.failed': {
      const spanId = str(
        payload.span_id || payload.id,
        `model_${runId}_${ev.sequence}`,
      );
      const existing = next.traceSpansById[spanId];
      const failed = ev.type === 'model.request.failed';
      const done = ev.type !== 'model.request.started';
      // The Run row carries no model column, so the provider call is the only
      // place the served model is stated. Record it on the run for the header.
      const eventModelId = str(payload.model_id);
      if (eventModelId && next.runsById[runId]?.modelId !== eventModelId) {
        next = touchRun(next, runId, { modelId: eventModelId });
      }
      next = upsertTraceSpan(
        next,
        createTraceSpan({
          id: spanId,
          runId,
          parentId: existing?.parentId ?? `runspan_${runId}`,
          kind: 'model',
          name: str(payload.model || payload.name, 'model'),
          status: failed ? 'error' : done ? 'ok' : 'running',
          spanId: payload.span_id != null ? str(payload.span_id) : existing?.spanId ?? null,
          tokens:
            typeof payload.tokens === 'number'
              ? payload.tokens
              : typeof payload.total_tokens === 'number'
                ? payload.total_tokens
                : existing?.tokens ?? null,
          cost:
            typeof payload.cost === 'number' ? payload.cost : existing?.cost ?? null,
          error: failed
            ? str(payload.message || payload.error, 'model failed')
            : null,
          durationMs:
            typeof payload.duration_ms === 'number'
              ? payload.duration_ms
              : existing?.durationMs ?? null,
          startedAt: existing?.startedAt || ts,
          finishedAt: done ? ts : null,
          metadata: {
            model: payload.model,
            provider: payload.provider,
          },
        }),
      );
      break;
    }

    case 'error.occurred': {
      const msg = str(payload.message || payload.error, 'Error');
      next = touchRun(next, runId, {
        error: msg,
        // Non-terminal by default — agent may continue after recoverable errors
      });
      next = upsertTraceSpan(
        next,
        createTraceSpan({
          id: `err_${runId}_${ev.sequence}`,
          runId,
          parentId: null,
          kind: 'error',
          name: 'error',
          status: 'error',
          error: msg,
          startedAt: ts,
          finishedAt: ts,
        }),
      );
      break;
    }

    case 'session.compacted': {
      // No run status change; metadata only
      break;
    }

    default:
      // Unknown types: still advance cursor so sequence resume stays correct
      break;
  }

  // Ensure a root run span exists when we have a trace id
  const runAfter = next.runsById[runId];
  if (runAfter?.traceId && !next.traceSpansById[`runspan_${runId}`]) {
    next = upsertTraceSpan(
      next,
      createTraceSpan({
        id: `runspan_${runId}`,
        runId,
        parentId: null,
        kind: 'run',
        name: 'run',
        status: isTerminalRunStatus(runAfter.status)
          ? runAfter.status === 'failed'
            ? 'error'
            : runAfter.status === 'cancelled'
              ? 'cancelled'
              : 'ok'
          : 'running',
        spanId: null,
        startedAt: runAfter.startedAt || ts,
        finishedAt: runAfter.finishedAt,
      }),
    );
  }

  next = advanceCursor(next, runId, ev.sequence, ev.event_id);
  if (opts.seenEventIds) {
    opts.seenEventIds.add(ev.event_id);
    capSeenEventIds(opts.seenEventIds);
  }

  return {
    store: next,
    outcome: 'applied',
    sequenceGap: false,
    appliedSequence: ev.sequence,
    eventId: ev.event_id,
  };
}

/**
 * Apply a batch of events in sequence order (sorts first).
 * Only consecutive events apply: gaps do not advance the cursor, so later
 * non-contiguous sequences remain skipped until the hole is filled.
 * Replay + live merge is safe — later duplicates are skipped.
 */
export function reduceRuntimeEventBatch(
  store: EntityStore,
  events: unknown[],
  opts: { seenEventIds?: Set<string> } = {},
): { store: EntityStore; applied: number; skipped: number; gaps: number } {
  const parsed = events
    .map((e) => normalizeToRuntimeEvent(e) ?? parseRuntimeEvent(e) ?? (e as RuntimeEvent))
    .filter((e) => e && e.event_id && typeof e.sequence === 'number')
    .sort((a, b) => a.sequence - b.sequence);

  let next = store;
  let applied = 0;
  let skipped = 0;
  let gaps = 0;

  for (const ev of parsed) {
    const result = reduceRuntimeEvent(next, ev, opts);
    // Gap leaves store unchanged; do not treat as applied.
    if (result.outcome === 'applied') {
      next = result.store;
      applied += 1;
    } else {
      skipped += 1;
      if (result.outcome === 'gap') gaps += 1;
    }
  }

  return { store: next, applied, skipped, gaps };
}
