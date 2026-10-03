import {
  createDataset,
  createProcess,
  createTraceSpan,
  cloneEntityStore,
  upsertArtifact,
  upsertTraceSpan,
  type DatasetEntity,
  type EntityStore,
  type ProcessEntity,
  type ProcessStatus,
  type RunEntity,
  type TraceSpanEntity,
  type TraceSpanKind,
} from '../../entities';
import type { DatasetRow } from '../../shared/api/datasets';
import type { ManagedProcess } from '../../shared/api/processes';
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

export function sameRunRevision(
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

/**
 * Backfill artifact.sessionId from the parent run's sandbox session.
 * Historical artifact.ready events may omit sandboxSessionId in context;
 * after Run DTO rehydrate supplies sandbox_session_id, chips still need it.
 */
export function backfillArtifactSessionIds(store: EntityStore): EntityStore {
  let next = store;
  for (const art of Object.values(store.artifactsById)) {
    if (art.sessionId) continue;
    if (art.source !== 'submit_artifact') continue;
    const run = art.runId ? store.runsById[art.runId] : null;
    const sessionId = run?.sandboxSessionId || null;
    if (!sessionId) continue;
    next = upsertArtifact(next, { ...art, sessionId });
  }
  return next;
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

const PROCESS_STATUSES = new Set<ProcessStatus>([
  'created',
  'running',
  'waiting_input',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'timeout',
  'orphaned',
]);

/**
 * Project a BFF managed-process row onto the entity shape. Sandbox and the
 * entity layer share one status vocabulary, so an unknown value means a newer
 * Sandbox — fall back to `created` rather than dropping the row.
 */
export function processRowToEntity(
  row: ManagedProcess,
  context: { sessionId?: string | null } = {},
): ProcessEntity | null {
  const id = String(row.process_id || '');
  if (!id) return null;
  const rawStatus = String(row.status || '').trim().toLowerCase();
  const status = PROCESS_STATUSES.has(rawStatus as ProcessStatus)
    ? (rawStatus as ProcessStatus)
    : 'created';
  return createProcess({
    id,
    runId: String(row.run_id || ''),
    sessionId:
      String(row.sandbox_session_id || row.session_id || context.sessionId || '') ||
      null,
    toolExecutionId: row.execution_id != null ? String(row.execution_id) : null,
    status,
    command: row.command != null ? String(row.command) : null,
    exitCode: typeof row.exit_code === 'number' ? row.exit_code : null,
    startedAt: row.started_at != null ? String(row.started_at) : null,
    finishedAt: row.finished_at != null ? String(row.finished_at) : null,
    createdAt: row.created_at != null ? String(row.created_at) : null,
  });
}
