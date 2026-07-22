/**
 * Bridge from Agent run events into the normalized entity runtime.
 *
 * - Reduces runtime events exactly once via RunSSEManager
 * - Conversation switch does NOT disconnect background run managers
 * - Owns per-run fetch controllers and durable-history projections
 */
import {
  createDataset,
  createEntityStore,
  createRun,
  createTraceSpan,
  cloneEntityStore,
  setActiveConversation,
  upsertApproval,
  upsertDataset,
  upsertRun,
  upsertTraceSpan,
  type ApprovalStatus,
  type DatasetEntity,
  type EntityStore,
  type MessageEntity,
  type RunEntity,
  type TraceSpanEntity,
  type TraceSpanKind,
} from '../../entities';
import {
  createRunSSEManager,
  type RunSSEManager,
} from '../../shared/sse/manager';
import {
  createAgentEventAdapterState,
  agentEventToRuntime,
  type AgentEventAdapterState,
} from '../../shared/sse/agentEventAdapter';
import type { SSEEvent } from '../../shared/sse/parser';
import { rehydrateRun, rehydrateToolExecutions } from '../../shared/state/runReducer';
import { normalizeToRuntimeEvent } from '../../shared/state/platformEventNormalize';
import {
  getRun,
  getRunTraceSpans as fetchRunTraceSpans,
  listRuns,
  listRunTools,
  type RunDetail,
} from '../../shared/api/runs';
import { getConversationEvents } from '../../shared/api/client';
import { listDatasets, type DatasetRow } from '../../shared/api/datasets';
import type { PersistedAgentEvent } from '../../shared/schemas/events';
import type { ChatMessage } from '../../shared/state/types';
import type { ContentPart, ToolUsePart } from '../../shared/state/types';
import { getArtifactDownloadUrl } from '../../shared/api/client';
import { makeRuntimeEvent } from '../../shared/schemas/events';
import { isDurableArtifactId } from '../../shared/state/runReducer';
import type {
  RunTraceResponse,
  TraceSpanWire,
} from '../../shared/schemas/events';

const TRACE_SPAN_KINDS = new Set<TraceSpanKind>([
  'run',
  'queue',
  'model',
  'tool',
  'sandbox',
  'mcp',
  'artifact',
  'session',
  'a2a',
  'error',
  'other',
]);
const MAX_TRACE_PAGES = 100;

function sameRunRevision(
  left: RunEntity | undefined,
  right: RunEntity | undefined,
): boolean {
  return (
    Boolean(left) === Boolean(right) &&
    left?.lastSequence === right?.lastSequence &&
    left?.lastEventId === right?.lastEventId &&
    left?.status === right?.status &&
    left?.traceId === right?.traceId
  );
}

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function traceAttributes(span: TraceSpanWire): Record<string, unknown> {
  if (span.attributes && typeof span.attributes === 'object') {
    return span.attributes;
  }
  if (typeof span.attributes_json === 'string') {
    try {
      const parsed = JSON.parse(span.attributes_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Apply a durable trace page. Complete responses replace the transient tree;
 * truncated pages are merged so a partial response cannot erase live spans.
 */
export function rehydrateTraceSpans(
  current: EntityStore,
  runId: string,
  response: RunTraceResponse,
): EntityStore {
  const run = current.runsById[runId];
  if (!run) return current;
  let next = cloneEntityStore(current);
  const partial =
    response.truncated === true ||
    Boolean(response.nextCursor || response.next_cursor);
  if (!partial) {
    for (const [id, span] of Object.entries(next.traceSpansById)) {
      if (span.runId === runId) delete next.traceSpansById[id];
    }
  }
  const responseTraceId = String(response.traceId || response.trace_id || run.traceId || '');
  next.runsById[runId] = {
    ...run,
    traceId: responseTraceId || run.traceId,
    traceSpanIds: partial ? [...(run.traceSpanIds || [])] : [],
  };

  for (const wire of response.spans) {
    const traceId = String(wire.traceId || wire.trace_id || responseTraceId || '');
    const spanId = String(wire.spanId || wire.span_id || wire.id || '');
    if (!spanId) continue;
    const wireRunId = String(wire.runId || wire.run_id || runId);
    if (wireRunId !== runId) continue;
    const parentSpanId = wire.parentSpanId ?? wire.parent_span_id ?? null;
    const id = traceId ? `${traceId}:${spanId}` : spanId;
    const parentId = parentSpanId
      ? traceId
        ? `${traceId}:${String(parentSpanId)}`
        : String(parentSpanId)
      : null;
    const rawKind = String(wire.kind || 'other') as TraceSpanKind;
    const kind = TRACE_SPAN_KINDS.has(rawKind) ? rawKind : 'other';
    const rawStatus = String(wire.status || 'running');
    const status: TraceSpanEntity['status'] =
      rawStatus === 'ok' || rawStatus === 'error' || rawStatus === 'cancelled'
        ? rawStatus
        : 'running';
    const metadata = traceAttributes(wire);
    next = upsertTraceSpan(
      next,
      createTraceSpan({
        id,
        runId,
        orgId: String(wire.orgId || wire.org_id || '') || null,
        userId: String(wire.userId || wire.user_id || '') || null,
        parentId,
        kind,
        name: String(wire.name || kind),
        status,
        spanId,
        durationMs: finiteNumber(wire.durationMs ?? wire.duration_ms),
        tokens: finiteNumber(wire.tokens ?? wire.token_count),
        cost: finiteNumber(wire.cost),
        error:
          status === 'error' && metadata.errorCode != null
            ? String(metadata.errorCode)
            : null,
        metadata: Object.keys(metadata).length ? metadata : null,
        startedAt: wire.startedAt ?? wire.started_at ?? null,
        finishedAt: wire.finishedAt ?? wire.finished_at ?? null,
      }),
    );
  }
  return next;
}

export type EntityBridge = {
  manager: RunSSEManager;
  getStore: () => EntityStore;
  /**
   * Start tracking a new run (local test id or server run_id).
   * Returns the runId used for subsequent Agent event reduction.
   */
  beginRun: (opts?: {
    runId?: string;
    conversationId?: string | null;
    agentSessionId?: string | null;
    sessionId?: string | null;
  }) => string;
  /** Reduce one Agent wire event into the entity store. */
  ingestAgentEvent: (runId: string, ev: SSEEvent) => void;
  /** Register/release the fetch transport owned by a run. */
  attachTransport: (runId: string, controller: AbortController) => void;
  releaseTransport: (runId: string) => void;
  abortRun: (runId: string) => void;
  /**
   * Focus a conversation without cancelling background runs.
   * Unlike ChatState.switchConversation, this never aborts SSE managers.
   */
  focusConversation: (conversationId: string | null) => void;
  /** User-initiated stop: disconnect SSE for this run only. */
  stopRun: (runId: string) => void;
  /** Mark a locally aborted transport as an interrupted runtime event. */
  interruptRun: (runId: string, reason?: string) => void;
  /** Mark a transport failure in the same runtime store used by SSE events. */
  failRun: (runId: string, message: string) => void;
  /** Fetch authoritative run + tool state after transport recovery is exhausted. */
  reconcileRun: (runId: string) => Promise<RunEntity | null>;
  /** Disconnect all (page unload). */
  dispose: () => void;
  /** Rehydrate in-progress runs after refresh. */
  rehydrateInProgress: (conversationId?: string | null) => Promise<RunEntity[]>;
  /** Restore the complete persisted timeline and reconnect non-terminal runs. */
  rehydrateConversation: (conversationId: string) => Promise<RunEntity[]>;
  /** Project run assistant messages to ChatMessage[] for UI. */
  projectRunMessages: (runId: string) => ChatMessage[];
  /** Adapter state for a run (tests). */
  getAgentEventAdapter: (runId: string) => AgentEventAdapterState | null;
  /** Mark an approval decided (optimistic UI after user action). */
  markApproval: (
    approvalId: string,
    status: Extract<ApprovalStatus, 'approved' | 'rejected'>,
  ) => void;
  /** Immediately publish a successful upload into the normalized Dataset store. */
  recordDataset: (
    row: DatasetRow,
    context?: { conversationId?: string | null; sessionId?: string | null },
  ) => DatasetEntity | null;
};

/** Convert the Sandbox/BFF Dataset wire row into the single UI entity shape. */
export function datasetRowToEntity(
  row: DatasetRow,
  context: { conversationId?: string | null; sessionId?: string | null } = {},
): DatasetEntity | null {
  const id = String(row.dataset_id || row.id || '');
  if (!id) return null;
  const statusRaw = String(row.status || 'ready').toLowerCase();
  const status =
    statusRaw === 'failed'
      ? 'failed'
      : statusRaw === 'uploading' || statusRaw === 'pending'
        ? 'uploading'
        : 'ready';
  return createDataset({
    id,
    conversationId:
      String(row.conversation_id || context.conversationId || '') || null,
    sessionId:
      String(row.sandbox_session_id || context.sessionId || '') || null,
    name: String(row.name || row.original_filename || id),
    path: String(row.path || row.stored_relative_path || '') || null,
    size:
      typeof row.size === 'number'
        ? row.size
        : typeof row.size_bytes === 'number'
          ? row.size_bytes
          : null,
    mimeType: row.mime_type != null ? String(row.mime_type) : null,
    sha256: row.sha256 != null ? String(row.sha256) : null,
    status,
    progress: status === 'ready' ? 100 : null,
    agentVisible: status === 'ready',
    createdAt: row.created_at != null ? String(row.created_at) : null,
    updatedAt: row.completed_at != null ? String(row.completed_at) : null,
  });
}

/**
 * Create the F2 entity bridge. Safe to construct once per ChatProvider.
 */
export function createEntityBridge(
  onStoreChange?: (store: EntityStore) => void,
): EntityBridge {
  let store = createEntityStore();
  const eventAdapters = new Map<string, AgentEventAdapterState>();
  const transports = new Map<string, AbortController>();
  const reconcileInFlight = new Map<string, Promise<RunEntity | null>>();

  function localRunId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid ? `local_${uuid}` : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  const manager = createRunSSEManager(store, {
    onStoreChange: (s) => {
      store = s;
      onStoreChange?.(s);
    },
    reconcileRun,
  });

  function recordDataset(
    row: DatasetRow,
    context: { conversationId?: string | null; sessionId?: string | null } = {},
  ): DatasetEntity | null {
    const entity = datasetRowToEntity(row, context);
    if (!entity) return null;
    store = upsertDataset(manager.getStore(), entity);
    manager.setStore(store);
    onStoreChange?.(store);
    return entity;
  }

  function beginRun(
    opts: {
      runId?: string;
      conversationId?: string | null;
      agentSessionId?: string | null;
      sessionId?: string | null;
    } = {},
  ): string {
    const runId = opts.runId || localRunId();
    store = upsertRun(
      store,
      createRun({
        id: runId,
        conversationId: opts.conversationId || null,
        agentSessionId: opts.agentSessionId || null,
        sandboxSessionId: opts.sessionId || null,
        status: 'queued',
      }),
    );
    store = {
      ...store,
      activeRunId: runId,
      activeConversationId: opts.conversationId || store.activeConversationId,
    };
    manager.setStore(store);
    eventAdapters.set(
      runId,
      createAgentEventAdapterState({
        runId,
        conversationId: opts.conversationId || null,
        sessionId: opts.sessionId || null,
      }),
    );
    onStoreChange?.(store);
    return runId;
  }

  function ingestAgentEvent(runId: string, ev: SSEEvent): void {
    // Platform envelopes already carry sequence/eventId — feed reducer directly
    // so replay/live merge stays authoritative (no double sequence synthesis).
    const asPlatform = normalizeToRuntimeEvent(ev, runId);
    const eventType = String(ev.type || asPlatform?.type || '');
    if (asPlatform && eventType.includes('.')) {
      // Formal platform events use dotted names. Legacy Agent events such as
      // tool_start also carry durable ids after history projection, but still
      // need the adapter that maps them into normalized reducer events.
      manager.handleRuntimeEvent(asPlatform);
      store = manager.getStore();
      return;
    }

    let adapter = eventAdapters.get(runId);
    if (!adapter) {
      adapter = createAgentEventAdapterState({
        runId,
        sequence: manager.getStore().runsById[runId]?.lastSequence || 0,
      });
      eventAdapters.set(runId, adapter);
    }
    const runtimeEvents = agentEventToRuntime(adapter, ev);
    for (const re of runtimeEvents) {
      manager.handleRuntimeEvent(re);
    }
    store = manager.getStore();
  }

  function focusConversation(conversationId: string | null): void {
    store = setActiveConversation(manager.getStore(), conversationId);
    manager.setStore(store);
    onStoreChange?.(store);
    // Intentionally does NOT call manager.disconnect* — background runs continue
  }

  function stopRun(runId: string): void {
    manager.disconnect(runId);
  }

  function attachTransport(runId: string, controller: AbortController): void {
    transports.set(runId, controller);
  }

  function releaseTransport(runId: string): void {
    transports.delete(runId);
  }

  function abortRun(runId: string): void {
    transports.get(runId)?.abort();
    transports.delete(runId);
    stopRun(runId);
  }

  function applyLocalRunEvent(
    runId: string,
    type: 'run.status_changed' | 'run.failed',
    payload: Record<string, unknown>,
  ): void {
    let adapter = eventAdapters.get(runId);
    if (!adapter) {
      adapter = createAgentEventAdapterState({
        runId,
        sequence: manager.getStore().runsById[runId]?.lastSequence || 0,
      });
      eventAdapters.set(runId, adapter);
    }
    adapter.sequence += 1;
    manager.handleRuntimeEvent(
      makeRuntimeEvent({
        event_id: `local_${runId}_${adapter.sequence}`,
        sequence: adapter.sequence,
        run_id: runId,
        session_id: adapter.sessionId,
        type,
        payload,
      }),
    );
    store = manager.getStore();
  }

  function interruptRun(runId: string, reason = 'Run interrupted'): void {
    applyLocalRunEvent(runId, 'run.status_changed', {
      status: 'interrupted',
      message: reason,
    });
  }

  function failRun(runId: string, message: string): void {
    applyLocalRunEvent(runId, 'run.failed', { message });
  }

  async function fetchDurableTrace(
    runId: string,
    expectedTraceId: string | null | undefined,
  ): Promise<RunTraceResponse | null> {
    // Older BFFs may omit trace_id from Run detail. Avoid a speculative request
    // in that compatibility case; live spans remain available from SSE replay.
    if (!expectedTraceId) return null;
    let page = await fetchRunTraceSpans(runId);
    const firstTraceId = page.traceId || page.trace_id || null;
    if (firstTraceId && firstTraceId !== expectedTraceId) {
      throw new Error('trace response changed trace id');
    }
    const firstRunId = page.runId || page.run_id || null;
    if (firstRunId && firstRunId !== runId) {
      throw new Error('trace response changed run id');
    }
    const aggregate: RunTraceResponse = {
      ...page,
      spans: [...page.spans],
      truncated: page.truncated === true,
      nextCursor: page.nextCursor ?? page.next_cursor ?? null,
      next_cursor: page.next_cursor ?? page.nextCursor ?? null,
    };
    const seenCursors = new Set<string>();
    let pageCount = 1;
    while (
      aggregate.truncated === true &&
      aggregate.nextCursor &&
      pageCount < MAX_TRACE_PAGES
    ) {
      const cursor = String(aggregate.nextCursor);
      if (seenCursors.has(cursor)) break;
      seenCursors.add(cursor);
      page = await fetchRunTraceSpans(runId, { cursor });
      const pageTraceId = page.traceId || page.trace_id || null;
      const aggregateTraceId = aggregate.traceId || aggregate.trace_id || null;
      if (pageTraceId && aggregateTraceId && pageTraceId !== aggregateTraceId) {
        throw new Error('trace page changed trace id');
      }
      const pageRunId = page.runId || page.run_id || null;
      const aggregateRunId = aggregate.runId || aggregate.run_id || null;
      if (pageRunId && aggregateRunId && pageRunId !== aggregateRunId) {
        throw new Error('trace page changed run id');
      }
      aggregate.spans.push(...page.spans);
      aggregate.truncated = page.truncated === true;
      aggregate.nextCursor = page.nextCursor ?? page.next_cursor ?? null;
      aggregate.next_cursor = aggregate.nextCursor;
      pageCount += 1;
    }
    // A hard page ceiling is an honest partial result, not permission to clear
    // the live tree. The response schema exposes this state to the rehydrator.
    if (aggregate.truncated && pageCount >= MAX_TRACE_PAGES) {
      aggregate.nextCursor = aggregate.nextCursor || null;
      aggregate.next_cursor = aggregate.nextCursor;
    }
    return aggregate;
  }

  async function loadDurableTrace(
    next: EntityStore,
    runId: string,
  ): Promise<EntityStore> {
    const expectedRun = next.runsById[runId];
    const response = await fetchDurableTrace(
      runId,
      expectedRun?.traceId,
    );
    const latest = manager.getStore();
    const currentRun = latest.runsById[runId];
    if (!sameRunRevision(expectedRun, currentRun)) return latest;
    // Rebase the target Run's trace projection onto the latest global store so
    // an unrelated background Run cannot be rolled back by this HTTP request.
    return response ? rehydrateTraceSpans(latest, runId, response) : latest;
  }

  async function reconcileRunOnce(runId: string): Promise<RunEntity | null> {
    const initialSequence = manager.getStore().runsById[runId]?.lastSequence ?? null;
    const detail = await getRun(runId);
    let candidate = rehydrateRun(manager.getStore(), detail);
    let tools: Awaited<ReturnType<typeof listRunTools>> | null = null;
    try {
      tools = await listRunTools(runId);
      candidate = rehydrateToolExecutions(candidate, runId, tools);
    } catch {
      // Run status remains authoritative even when an older BFF has no tool
      // snapshot endpoint yet; persisted events can still restore the UI.
    }
    let trace: RunTraceResponse | null = null;
    try {
      trace = await fetchDurableTrace(
        runId,
        candidate.runsById[runId]?.traceId,
      );
    } catch {
      // Trace projection is additive observability. Run/tool reconciliation must
      // still succeed against an older BFF while SSE spans remain usable.
    }
    // A live SSE event may have been applied while the authoritative snapshot
    // was in flight. Never let that older response move the run backwards.
    const currentRun = manager.getStore().runsById[runId];
    if (
      (initialSequence == null && currentRun) ||
      (initialSequence != null && currentRun?.lastSequence !== initialSequence)
    ) {
      return currentRun || null;
    }

    // Re-apply only this Run's authoritative snapshots onto the latest store.
    // Another Run may have received SSE while the HTTP reads were in flight;
    // committing the earlier candidate wholesale would erase that update.
    let next = rehydrateRun(manager.getStore(), detail);
    if (tools) next = rehydrateToolExecutions(next, runId, tools);
    if (trace) next = rehydrateTraceSpans(next, runId, trace);
    store = next;
    manager.setStore(store);

    store = manager.getStore();
    onStoreChange?.(store);
    return store.runsById[runId] || null;
  }

  /** Coalesce reconnect/manual reconciliation calls for one Run. */
  async function reconcileRun(runId: string): Promise<RunEntity | null> {
    const pending = reconcileInFlight.get(runId);
    if (pending) return pending;
    const current = reconcileRunOnce(runId);
    reconcileInFlight.set(runId, current);
    try {
      return await current;
    } finally {
      if (reconcileInFlight.get(runId) === current) {
        reconcileInFlight.delete(runId);
      }
    }
  }

  function dispose(): void {
    for (const controller of transports.values()) controller.abort();
    transports.clear();
    manager.disconnectAll();
  }

  async function rehydrateInProgress(
    conversationId?: string | null,
  ): Promise<RunEntity[]> {
    // List without a single-status filter so WAITING_INPUT / WAITING_APPROVAL
    // runs are rediscovered after refresh (plan §32 / STATUS G6 + D1).
    const listed = await listRuns({
      conversation_id: conversationId || undefined,
    });
    const activeStatuses = new Set([
      'running',
      'queued',
      'accepted',
      'starting',
      'retrying',
      'waiting_input',
      'waiting_approval',
      'cancelling',
      'cancel_requested',
      'restoring_session',
      // Agent MySQL stores plan §10 uppercase statuses; accept both shapes.
      'RUNNING',
      'QUEUED',
      'ACCEPTED',
      'STARTING',
      'RETRYING',
      'WAITING_INPUT',
      'WAITING_APPROVAL',
      'CANCELLING',
    ]);
    const details = listed.filter((d) =>
      activeStatuses.has(String(d.status || '').trim()),
    );
    const rehydrated: RunEntity[] = [];

    for (const d of details) {
      const runId = d.run_id || d.id;
      if (!runId) continue;

      // Prefer full detail when available
      let detail: RunDetail | null = d;
      const full = await getRun(runId);
      if (full) detail = full;

      store = rehydrateRun(manager.getStore(), detail);
      manager.setStore(store);
      const toolsBaseRun = store.runsById[runId];
      try {
        const tools = await listRunTools(runId);
        const latest = manager.getStore();
        store = sameRunRevision(toolsBaseRun, latest.runsById[runId])
          ? rehydrateToolExecutions(latest, runId, tools)
          : latest;
      } catch {
        /* Older BFFs may not expose snapshots; event replay remains usable. */
      }
      try {
        store = await loadDurableTrace(store, runId);
      } catch {
        /* Older BFFs may not expose durable trace snapshots yet. */
      }
      manager.setStore(store);

      const run = store.runsById[runId];
      if (run) {
        rehydrated.push(run);
        // Resume SSE from last event
        manager.connect(runId, {
          lastEventId: run.lastEventId,
          lastSequence: run.lastSequence,
        });
      }
    }

    onStoreChange?.(store);
    return rehydrated;
  }

  function persistedEventPayload(event: PersistedAgentEvent): SSEEvent {
    const persistedType = event.type === 'token_batch' ? 'token' : event.type;
    return {
      ...(event.payload || {}),
      type: persistedType,
      eventId: event.event_id,
      event_id: event.event_id,
      sequence: event.sequence,
      persisted_event_id: event.event_id,
      persisted_sequence: event.sequence,
      timestamp: event.created_at || undefined,
    } as SSEEvent;
  }

  async function rehydrateConversation(conversationId: string): Promise<RunEntity[]> {
    const timeline = await getConversationEvents(conversationId);
    const eventsByRun = new Map<string, PersistedAgentEvent[]>();
    for (const event of timeline.events) {
      const list = eventsByRun.get(event.run_id) || [];
      list.push(event);
      eventsByRun.set(event.run_id, list);
    }

    const restored: RunEntity[] = [];
    for (const detail of timeline.runs) {
      const runId = detail.run_id || detail.id;
      if (!runId) continue;

      store = rehydrateRun(manager.getStore(), detail);
      manager.setStore(store);

      const persisted = (eventsByRun.get(runId) || [])
        .slice()
        .sort((a, b) => a.sequence - b.sequence);
      const status = String(manager.getStore().runsById[runId]?.status || '');
      const activelyStreaming = status === 'pending' || status === 'queued' || status === 'running';
      const resumable = status === 'waiting_approval' || status === 'waiting_input';

      const replayPersisted = () => {
        eventAdapters.set(
          runId,
          createAgentEventAdapterState({
            runId,
            conversationId,
            sessionId: detail.session_id || detail.sandbox_session_id || null,
          }),
        );
        for (const event of persisted) {
          ingestAgentEvent(runId, persistedEventPayload(event));
        }
        // Persisted event types are projections; the run row is authoritative
        // for terminal/waiting status and timestamps.
        store = rehydrateRun(manager.getStore(), detail);
        manager.setStore(store);
      };

      if (!activelyStreaming) {
        replayPersisted();
      }

      if (activelyStreaming || resumable) {
        const live = await getRun(runId);
        if (live) {
          store = rehydrateRun(manager.getStore(), live);
          manager.setStore(store);
          const toolsBaseRun = store.runsById[runId];
          try {
            const tools = await listRunTools(runId);
            const latest = manager.getStore();
            store = sameRunRevision(toolsBaseRun, latest.runsById[runId])
              ? rehydrateToolExecutions(latest, runId, tools)
              : latest;
          } catch {
            /* Event replay below remains the fallback for older deployments. */
          }
          manager.setStore(store);
        }
        if (live.runtime_available === false) {
          if (activelyStreaming) replayPersisted();
        } else {
          const liveCursor = resumable && live?.next_sequence
            ? Math.max(0, live.next_sequence - 1)
            : 0;
          manager.connect(runId, { lastSequence: liveCursor });
        }
      }

      try {
        store = await loadDurableTrace(manager.getStore(), runId);
        manager.setStore(store);
      } catch {
        /* Persisted events remain the trace fallback on older deployments. */
      }

      const run = manager.getStore().runsById[runId];
      if (run) restored.push(run);
    }

    // Refresh datasets for the conversation session (authoritative list).
    try {
      const sessionId =
        restored.find((r) => r.sandboxSessionId)?.sandboxSessionId ||
        timeline.runs.find((r) => r.session_id || r.sandbox_session_id)?.session_id ||
        timeline.runs.find((r) => r.sandbox_session_id)?.sandbox_session_id ||
        null;
      const rows = await listDatasets({
        conversationId,
        sessionId: sessionId || undefined,
      });
      let next = manager.getStore();
      for (const row of rows) {
        const entity = datasetRowToEntity(row, { conversationId, sessionId });
        if (entity) next = upsertDataset(next, entity);
      }
      store = next;
      manager.setStore(store);
    } catch {
      /* Dataset list is best-effort on older BFFs. */
    }

    store = setActiveConversation(manager.getStore(), conversationId);
    manager.setStore(store);
    onStoreChange?.(store);
    return restored;
  }

  function projectRunMessages(runId: string): ChatMessage[] {
    const s = manager.getStore();
    const run = s.runsById[runId];
    if (!run) return [];
    const messages: ChatMessage[] = run.messageIds
      .map((id) => s.messagesById[id])
      .filter((m): m is MessageEntity => Boolean(m))
      .map((m) => ({
        role: m.role,
        content: [{ type: 'text' as const, text: m.text }],
        _runId: runId,
        _messageId: m.id,
        createdAt: m.createdAt || undefined,
        ...(m.status === 'interrupted'
          ? { interrupted: true, status: 'interrupted' as const }
          : {}),
      }));
    const content: ContentPart[] = [];
    /** Skip assistant rows that are leaked tool envelopes (pre-fix clients). */
    const looksLikeToolEnvelope = (text: string): boolean => {
      const t = text.trim();
      if (!t.startsWith('{')) return false;
      return (
        t.includes('"exitCode"') ||
        t.includes('"stdout"') ||
        t.includes('"stdoutTruncated"')
      );
    };
    let assistant: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role !== 'assistant') continue;
      const text = messages[i].content
        .filter((p) => p.type === 'text' && 'text' in p)
        .map((p) => String((p as { text?: unknown }).text || ''))
        .join('');
      if (looksLikeToolEnvelope(text)) continue;
      assistant = messages[i];
      break;
    }
    // If every assistant row was a tool leak, still attach tools below with empty text.
    if (assistant) content.push(...assistant.content);

    for (const toolId of run.toolExecutionIds) {
      const tool = s.toolExecutionsById[toolId];
      if (!tool) continue;
      const part: ToolUsePart = {
        type: 'tool_use',
        name: tool.name,
        input: tool.input,
        status:
          tool.status === 'running' || tool.status === 'waiting_approval'
            ? 'running'
            : 'complete',
        isError: tool.isError || tool.status === 'failed',
        result: tool.result,
      };
      content.push(part);
    }

    if (
      run.error &&
      !content.some(
        (part) =>
          part.type === 'text' &&
          'text' in part &&
          String((part as { text?: unknown }).text || '').includes(run.error || ''),
      )
    ) {
      content.push({ type: 'text', text: `\n[Error: ${run.error}]` });
    }

    // Deliverables: only durable server artifact_id via artifact-download.
    // Never fall back to workspace path download (submit_artifact only).
    const fileLinks = run.artifactIds.flatMap((artifactId) => {
      const artifact = s.artifactsById[artifactId];
      if (!artifact) return [];
      if (!isDurableArtifactId(artifact.id, runId)) return [];
      if (artifact.source !== 'submit_artifact') return [];
      const sessionId = artifact.sessionId || run.sandboxSessionId;
      if (!sessionId) return [];
      const url = getArtifactDownloadUrl(sessionId, artifact.id);
      if (!url) return [];
      return [{
        name: artifact.name,
        url,
        path: artifact.path || undefined,
        artifact_id: artifact.id,
        mime_type: artifact.mimeType || undefined,
        size: artifact.size ?? undefined,
      }];
    });

    if (!assistant && (content.length || fileLinks.length)) {
      messages.push({ role: 'assistant', content: [], _runId: runId });
    }
    let projected: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') {
        projected = messages[i];
        break;
      }
    }
    if (projected) {
      projected.content = content;
      projected._fileLinks = fileLinks;
      projected._runId = runId;
      if (
        run.status === 'interrupted' ||
        run.status === 'cancelled' ||
        run.status === 'orphaned'
      ) {
        projected.interrupted = true;
        projected.status = 'interrupted';
      }
    }
    return messages;
  }

  function markApproval(
    approvalId: string,
    status: Extract<ApprovalStatus, 'approved' | 'rejected'>,
  ): void {
    const s = manager.getStore();
    const existing = s.approvalsById[approvalId];
    if (!existing) return;
    store = upsertApproval(s, {
      ...existing,
      status,
      decidedAt: new Date().toISOString(),
    });
    manager.setStore(store);
    onStoreChange?.(store);
  }

  return {
    manager,
    getStore: () => manager.getStore(),
    beginRun,
    ingestAgentEvent,
    attachTransport,
    releaseTransport,
    abortRun,
    focusConversation,
    stopRun,
    interruptRun,
    failRun,
    reconcileRun,
    dispose,
    rehydrateInProgress,
    rehydrateConversation,
    projectRunMessages,
    getAgentEventAdapter: (runId) => eventAdapters.get(runId) || null,
    markApproval,
    recordDataset,
  };
}
