/**
 * Normalize platform envelopes (plan §15.3 / §19.3) and legacy Agent wire
 * shapes into a single RuntimeEvent form for the unified reducer.
 *
 * Live SSE and historical replay MUST share this path so UI projections match.
 */
import type { RuntimeEvent } from '../schemas/events';
import { makeRuntimeEvent, parseRuntimeEvent } from '../schemas/events';

/** Cap process log buffers retained in the entity store (chars per stream). */
export const PROCESS_LOG_CHAR_CAP = 256 * 1024;

/** Cap seen-event-id sets per run connection (memory growth). */
export const SEEN_EVENT_ID_CAP = 4_000;

/**
 * Map plan §15.2 platform types → internal RuntimeEvent.type used by the
 * existing reducer cases. Unknown types pass through unchanged.
 */
const PLATFORM_TYPE_ALIASES: Record<string, string> = {
  // Run
  'run.accepted': 'run.created',
  'run.queued': 'run.created',
  'run.status.changed': 'run.status_changed',
  // Messages
  'message.created': 'message.started',
  // Tools
  'tool.call.proposed': 'tool.prepared',
  'tool.execution.started': 'tool.started',
  'tool.execution.progress': 'tool.progress',
  'tool.execution.completed': 'tool.completed',
  'tool.execution.failed': 'tool.failed',
  // Process
  'process.output': 'process.output',
  'process.cancelled': 'process.cancelled',
  // Approval
  'approval.requested': 'tool.approval_required',
  'approval.resolved': 'approval.resolved',
  // Dataset
  'dataset.upload.started': 'dataset.upload.started',
  'dataset.upload.progress': 'dataset.upload.progress',
  'dataset.ready': 'dataset.ready',
  'dataset.failed': 'dataset.failed',
  // Artifact — only explicit submit path
  'artifact.ready': 'artifact.created',
  // Errors
  'error.occurred': 'error.occurred',
  // Model → handled as trace spans in reducer under these names
  'model.request.started': 'model.request.started',
  'model.request.completed': 'model.request.completed',
  'model.request.failed': 'model.request.failed',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickStr(...vals: unknown[]): string {
  for (const v of vals) {
    if (v != null && String(v).length > 0) return String(v);
  }
  return '';
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isPlainObject(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (!Array.isArray(value.content)) return '';
  return value.content
    .map((part) => {
      if (typeof part === 'string') return part;
      return isPlainObject(part) && typeof part.text === 'string' ? part.text : '';
    })
    .filter(Boolean)
    .join('');
}

/**
 * Map platform type string to internal reducer type.
 */
export function mapPlatformEventType(type: string): string {
  return PLATFORM_TYPE_ALIASES[type] || type;
}

/**
 * Infer tool source from name / payload (plan §19.5). Backend may override.
 */
export function inferToolSource(
  name: string,
  payload: Record<string, unknown> = {},
): 'sandbox' | 'mcp' | 'internal' | 'unknown' {
  const explicit = pickStr(payload.source, payload.tool_source, payload.provider);
  const lower = explicit.toLowerCase();
  if (lower === 'sandbox' || lower === 'mcp' || lower === 'internal') {
    return lower;
  }
  const n = (name || '').toLowerCase();
  if (
    n.startsWith('mcp_') ||
    n.startsWith('mcp.') ||
    n.includes('__mcp') ||
    payload.mcp_server != null ||
    payload.server != null
  ) {
    return 'mcp';
  }
  if (
    n === 'bash' ||
    n === 'read' ||
    n === 'write' ||
    n === 'edit' ||
    n === 'python' ||
    n === 'process_start' ||
    n === 'submit_artifact' ||
    n.startsWith('sandbox')
  ) {
    return 'sandbox';
  }
  if (n.startsWith('skill') || n === 'ask_user' || n.includes('internal')) {
    return 'internal';
  }
  return 'unknown';
}

/**
 * Whether an approval event should surface in the Approval Panel (plan §19.9).
 *
 * Authority: enterprise-policy on the Agent. The frontend never invents
 * approvals from ordinary bash tool.started/completed — only from explicit
 * `approval.requested` / `tool.approval_required` events.
 *
 * Synthetic / client-side "approval" without an id is dropped. Backend
 * emissions for high-risk external tools are always shown, including
 * elevated bash when policy attaches an approval_id.
 */
export function isExternalRiskApproval(
  payload: Record<string, unknown>,
  _toolName?: string | null,
): boolean {
  const approvalId = pickStr(payload.approval_id, payload.id);
  if (!approvalId) return false;
  // Client-synthesized noise (never a durable policy id)
  if (approvalId.startsWith('local_') || approvalId.startsWith('synth_')) {
    return false;
  }
  return true;
}

/**
 * Append text to a process log buffer with a hard char cap (keeps the tail).
 */
export function appendCappedLog(
  existing: string,
  chunk: string,
  cap: number = PROCESS_LOG_CHAR_CAP,
): { text: string; truncated: boolean } {
  if (!chunk) return { text: existing, truncated: existing.length > cap };
  const next = existing + chunk;
  if (next.length <= cap) return { text: next, truncated: false };
  // Keep a small head marker + tail so operators see truncation.
  const keep = Math.max(0, cap - 48);
  const tail = next.slice(next.length - keep);
  return {
    text: `…[truncated ${next.length - keep} chars]\n${tail}`,
    truncated: true,
  };
}

/**
 * Bound a Set of seen event ids to prevent unbounded memory growth.
 */
export function capSeenEventIds(
  seen: Set<string> | undefined,
  cap: number = SEEN_EVENT_ID_CAP,
): void {
  if (!seen || seen.size <= cap) return;
  const drop = seen.size - Math.floor(cap * 0.75);
  let i = 0;
  for (const id of seen) {
    if (i++ >= drop) break;
    seen.delete(id);
  }
}

/**
 * Coerce any known wire shape into RuntimeEvent | null.
 *
 * Accepts:
 * - RuntimeEvent snake_case envelope
 * - PlatformEventEnvelope camelCase (eventId / sequence / type / data / context)
 * - BFF relay { sequence, event, ts }
 * - Loose { type, ...fields }
 */
export function normalizeToRuntimeEvent(
  raw: unknown,
  fallbackRunId?: string | null,
): RuntimeEvent | null {
  if (raw == null || typeof raw !== 'object') return null;
  let obj = raw as Record<string, unknown>;

  // BFF relay: { sequence, event, ts }
  if (isPlainObject(obj.event) && (obj.sequence != null || obj.event_id != null)) {
    const inner = obj.event as Record<string, unknown>;
    obj = {
      ...inner,
      sequence: obj.sequence ?? inner.sequence,
      event_id: inner.event_id || inner.eventId || obj.event_id || obj.id,
      timestamp: inner.timestamp || obj.ts || obj.timestamp,
    };
  }

  // Already a RuntimeEvent
  const direct = parseRuntimeEvent(obj);
  if (direct && direct.event_id && direct.run_id && typeof direct.sequence === 'number') {
    return {
      ...direct,
      type: mapPlatformEventType(String(direct.type)),
      payload: normalizePayload(
        mapPlatformEventType(String(direct.type)),
        direct.payload || {},
        direct.event_id,
      ),
    };
  }

  // Platform envelope (camelCase)
  const eventId = pickStr(obj.eventId, obj.event_id, obj.id);
  const sequence =
    typeof obj.sequence === 'number'
      ? obj.sequence
      : typeof obj.sequenceNo === 'number'
        ? obj.sequenceNo
        : typeof obj.persisted_sequence === 'number'
          ? obj.persisted_sequence
          : null;
  const typeRaw = pickStr(obj.type, obj.eventType, obj.event_type);
  const context = isPlainObject(obj.context) ? obj.context : {};
  // Prefer explicit data/payload bags. When history replay flattens the durable
  // payload onto the event root (entityBridge.persistedEventPayload), promote
  // non-envelope fields so process/artifact ids are not dropped.
  const nestedData = isPlainObject(obj.data)
    ? obj.data
    : isPlainObject(obj.payload)
      ? obj.payload
      : null;
  const envelopeKeys = new Set([
    'eventId',
    'event_id',
    'id',
    'sequence',
    'sequenceNo',
    'persisted_sequence',
    'persisted_event_id',
    'type',
    'eventType',
    'event_type',
    'timestamp',
    'ts',
    'context',
    'data',
    'payload',
    'run_id',
    'runId',
    'session_id',
    'sessionId',
  ]);
  let data: Record<string, unknown> = nestedData ? { ...nestedData } : {};
  if (!nestedData || Object.keys(data).length === 0) {
    for (const [key, value] of Object.entries(obj)) {
      if (envelopeKeys.has(key) || value === undefined) continue;
      data[key] = value;
    }
  } else {
    // Nested bag may still omit fields that were flattened beside it.
    for (const [key, value] of Object.entries(obj)) {
      if (envelopeKeys.has(key) || value === undefined) continue;
      if (data[key] == null) data[key] = value;
    }
  }

  const runId = pickStr(
    obj.run_id,
    obj.runId,
    context.runId,
    context.run_id,
    fallbackRunId,
  );
  if (!eventId || sequence == null || !typeRaw || !runId) {
    // Last-chance: type-only loose event (Agent legacy)
    if (typeRaw && runId) {
      const seq = typeof sequence === 'number' ? sequence : 0;
      const id = eventId || `synth_${runId}_${seq}_${typeRaw}`;
      const mapped = mapPlatformEventType(typeRaw);
      return makeRuntimeEvent({
        event_id: id,
        sequence: seq,
        run_id: runId,
        session_id: pickStr(obj.session_id, obj.sessionId, context.sandboxSessionId) || null,
        type: mapped,
        timestamp: pickStr(obj.timestamp, obj.ts) || null,
        payload: normalizePayload(mapped, {
          ...data,
          type: undefined,
          event_id: undefined,
          sequence: undefined,
        }, eventId),
      });
    }
    return null;
  }

  const mapped = mapPlatformEventType(typeRaw);
  const payload = normalizePayload(mapped, {
    ...data,
    // Promote common context fields for reducers that read conversation_id etc.
    conversation_id:
      data.conversation_id ??
      data.conversationId ??
      context.conversationId ??
      context.conversation_id,
    agent_session_id:
      data.agent_session_id ??
      data.agentSessionId ??
      context.agentSessionId ??
      context.agent_session_id,
    trace_id: data.trace_id ?? data.traceId ?? context.traceId ?? context.trace_id,
    span_id: data.span_id ?? data.spanId ?? context.spanId ?? context.span_id,
    org_id: data.org_id ?? data.orgId ?? context.orgId ?? context.org_id,
    user_id: data.user_id ?? data.userId ?? context.userId ?? context.user_id,
  }, eventId);

  return makeRuntimeEvent({
    event_id: eventId,
    sequence,
    run_id: runId,
    session_id:
      pickStr(
        obj.session_id,
        obj.sessionId,
        data.session_id,
        data.sessionId,
        context.sandboxSessionId,
      ) || null,
    type: mapped,
    timestamp: pickStr(obj.timestamp, data.timestamp) || null,
    payload,
  });
}

/**
 * Normalize payload field names so reducer cases can stay snake_case.
 */
function normalizePayload(
  type: string,
  data: Record<string, unknown>,
  eventId?: string,
): Record<string, unknown> {
  const p: Record<string, unknown> = { ...data };

  // Common camelCase → snake_case promotions
  const aliases: Array<[string, string]> = [
    ['toolCallId', 'tool_call_id'],
    ['tool_id', 'tool_call_id'],
    ['toolId', 'tool_call_id'],
    ['approvalId', 'approval_id'],
    ['processId', 'process_id'],
    ['artifactId', 'artifact_id'],
    ['datasetId', 'dataset_id'],
    ['messageId', 'message_id'],
    ['interactionId', 'interaction_id'],
    ['interactionType', 'interaction_type'],
    ['idempotencyKey', 'idempotency_key'],
    ['exitCode', 'exit_code'],
    ['mimeType', 'mime_type'],
    ['traceId', 'trace_id'],
    ['spanId', 'span_id'],
    ['conversationId', 'conversation_id'],
    ['agentSessionId', 'agent_session_id'],
    ['sessionId', 'session_id'],
    ['sizeBytes', 'size'],
    ['originalFilename', 'name'],
    ['riskLevel', 'risk_level'],
    ['expiresAt', 'expires_at'],
    ['parentSpanId', 'parent_span_id'],
  ];
  for (const [from, to] of aliases) {
    if (p[to] == null && p[from] != null) p[to] = p[from];
  }

  if (type.startsWith('message.')) {
    const message = isPlainObject(p.message) ? p.message : null;
    if (p.role == null && message?.role != null) p.role = message.role;
    if (p.text == null) {
      const inferredText =
        typeof p.delta === 'string'
          ? p.delta
          : messageText(message ?? p.content);
      // A completion event commonly carries only the message id. Keep the
      // field absent in that case so the reducer preserves accumulated deltas.
      // Explicit `text: ''` remains an intentional empty completion.
      if (inferredText || type !== 'message.completed') {
        p.text = inferredText;
      }
    }
    // User messages have no preceding delta from which the reducer could infer
    // identity. The durable event id is a stable, replay-safe fallback.
    if (
      p.message_id == null &&
      eventId &&
      String(p.role || '').toLowerCase() === 'user'
    ) {
      p.message_id = eventId;
    }
  }

  // Agent persists Run state-machine values in uppercase; the UI entity
  // contract is lowercase and uses the same normalization for live/replayed
  // events.
  if (type === 'run.status_changed' && p.status != null) {
    p.status = String(p.status).toLowerCase();
  }

  // process.output → stream-aware text
  if (type === 'process.output') {
    if (p.text == null) p.text = p.chunk ?? p.data ?? p.output ?? '';
    if (p.stream == null) p.stream = p.channel || 'stdout';
  }

  // approval.resolved decision
  if (type === 'approval.resolved') {
    if (p.status == null) {
      const d = pickStr(p.decision, p.result).toLowerCase();
      if (d === 'approve' || d === 'approved' || d === 'allow') p.status = 'approved';
      else if (d === 'deny' || d === 'denied' || d === 'reject' || d === 'rejected') {
        p.status = 'rejected';
      } else if (d === 'expired') p.status = 'expired';
    }
  }

  // artifact fields
  if (type === 'artifact.created') {
    p.source = 'submit_artifact';
    if (p.sha256 == null && p.checksum != null) p.sha256 = p.checksum;
  }

  return p;
}

/** Plan-facing alias used by docs / tests. */
export function reducePlatformEventInput(raw: unknown, fallbackRunId?: string | null): RuntimeEvent | null {
  return normalizeToRuntimeEvent(raw, fallbackRunId);
}
