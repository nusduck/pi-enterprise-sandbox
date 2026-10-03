/**
 * Run and tool rehydration helpers (split out of runReducer.ts,
 * which is pinned by the layout ratchet).
 */
import type {
  EntityStore,
  RunStatus,
} from '../../entities/types';
import {
  createRun,
  createToolExecution,
  upsertRun,
  upsertToolExecution,
} from '../../entities/store';
import type { ToolExecutionSnapshot } from '../schemas/events';
import { inferToolSource } from './platformEventNormalize';
import { reduceRuntimeEventBatch } from './runReducer';

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
    trace_id?: string | null;
    session_id?: string | null;
    sandbox_session_id?: string | null;
    agent_session_id?: string | null;
    status?: string;
    last_sequence?: number | null;
    last_event_id?: string | null;
    error?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
    model_id?: string | null;
    pending_input?: {
      interaction_id?: string;
      interactionId?: string;
      interaction_type?: string;
      interactionType?: string;
      title?: string;
      message?: string | null;
      options?: unknown[];
    } | null;
    pendingInput?: {
      interactionId?: string;
      interaction_id?: string;
      interactionType?: string;
      interaction_type?: string;
      title?: string;
      message?: string | null;
      options?: unknown[];
    } | null;
  },
  missedEvents: unknown[] = [],
): EntityStore {
  const runId = detail.run_id || detail.id;
  if (!runId) return store;
  const existing = store.runsById[runId];

  const status = (() => {
    const raw = String(detail.status || '').trim().toLowerCase();
    switch (raw) {
      case 'accepted':
      case 'pending':
      case 'queued':
      case 'starting':
      case 'retrying':
        return 'queued';
      case 'restoring_session':
        return 'restoring_session';
      case 'running':
        return 'running';
      case 'waiting_approval':
        return 'waiting_approval';
      case 'waiting_input':
        return 'waiting_input';
      case 'cancel_requested':
      case 'cancelling':
        return 'cancel_requested';
      case 'cancelled':
        return 'cancelled';
      case 'completed':
      case 'succeeded':
      case 'success':
        return 'succeeded';
      case 'rejected':
      case 'failed':
      case 'error':
        return 'failed';
      case 'interrupted':
        return 'interrupted';
      case 'budget_exceeded':
        return 'budget_exceeded';
      case 'orphaned':
        return 'orphaned';
      default:
        return existing?.status || 'running';
    }
  })() as RunStatus;

  const rawPending = detail.pending_input ?? detail.pendingInput ?? null;
  const pendingInput =
    status === 'waiting_input' && rawPending
      ? {
          interactionId: String(
            rawPending.interactionId || rawPending.interaction_id || '',
          ),
          interactionType: String(
            rawPending.interactionType ||
              rawPending.interaction_type ||
              'input',
          ),
          title: String(rawPending.title || 'Input required'),
          message:
            rawPending.message != null ? String(rawPending.message) : null,
          options: Array.isArray(rawPending.options)
            ? rawPending.options.map((item) => String(item)).filter(Boolean)
            : [],
        }
      : status === 'waiting_input'
        ? existing?.pendingInput ?? null
        : null;

  let next = upsertRun(
    store,
    createRun({
      ...existing,
      id: runId,
      conversationId: detail.conversation_id ?? existing?.conversationId ?? null,
      traceId: detail.trace_id ?? existing?.traceId ?? null,
      agentSessionId: detail.agent_session_id ?? existing?.agentSessionId ?? null,
      sandboxSessionId:
        detail.session_id ?? detail.sandbox_session_id ?? existing?.sandboxSessionId ?? null,
      status,
      pendingInput,
      // The Agent Run row is the authority for which model served the turn.
      modelId: detail.model_id ?? existing?.modelId ?? null,
      lastSequence: existing?.lastSequence ?? 0, // applied cursor only; never adopt detail.last_sequence
      lastEventId: existing?.lastEventId ?? null, // pairs with lastSequence
      // Drop parked wait reasons that BFF may still send as `error`.
      error:
        status === 'waiting_approval' || status === 'waiting_input'
          ? null
          : detail.error ?? existing?.error ?? null,
      startedAt: detail.started_at ?? existing?.startedAt ?? null,
      finishedAt: detail.finished_at ?? existing?.finishedAt ?? null,
      createdAt: detail.created_at ?? existing?.createdAt ?? null,
      updatedAt: detail.updated_at ?? existing?.updatedAt ?? null,
    }),
  );

  if (missedEvents.length) {
    next = reduceRuntimeEventBatch(next, missedEvents).store;
  }

  return next;
}

function ledgerToolStatus(status: string):
  | 'prepared'
  | 'waiting_approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled' {
  switch (status) {
    case 'prepared':
      return 'prepared';
    case 'waiting_approval':
      return 'waiting_approval';
    case 'executing':
      return 'running';
    case 'succeeded':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/**
 * Reconcile tools from the durable ledger after SSE replay/reconnect.
 * Durable ``unknown`` is intentionally projected as the UI's Failed state;
 * it must never be presented as a successful tool completion or auto-retry.
 */
export function rehydrateToolExecutions(
  store: EntityStore,
  runId: string,
  snapshots: ToolExecutionSnapshot[] = [],
): EntityStore {
  let next = store;
  for (const snapshot of snapshots) {
    if (!snapshot?.tool_call_id || snapshot.run_id !== runId) continue;
    const status = ledgerToolStatus(snapshot.status);
    const isUnknown = snapshot.status === 'unknown';
    const isError = status === 'failed';
    const result = snapshot.result_json ?? null;
    const summary = isUnknown
      ? 'Outcome unconfirmed; do not retry automatically.'
      : snapshot.result_summary || snapshot.summary || snapshot.error || null;
    const existing = next.toolExecutionsById[snapshot.tool_call_id];
    const name = snapshot.tool_name || existing?.name || 'tool';
    next = upsertToolExecution(
      next,
      createToolExecution({
        id: snapshot.tool_call_id,
        runId,
        name,
        source: existing?.source && existing.source !== 'unknown'
          ? existing.source
          : inferToolSource(name, (snapshot.arguments as Record<string, unknown>) || {}),
        status,
        input: snapshot.arguments ?? existing?.input ?? null,
        result,
        isError: isError || isUnknown || Boolean(existing?.isError),
        approvalId: existing?.approvalId ?? null,
        processId: existing?.processId ?? null,
        summary,
        spanId: existing?.spanId ?? null,
        seq: existing?.seq ?? null,
        createdAt: snapshot.created_at || existing?.createdAt || null,
        updatedAt: snapshot.updated_at || snapshot.finished_at || existing?.updatedAt || null,
      }),
    );
  }
  return next;
}
