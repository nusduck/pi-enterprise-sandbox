/**
 * Trace span 的纯投影与归一化：id 校验/派生、行映射、属性序列化、
 * 事件生命周期与 usage 提取。
 *
 * 从 trace-span-repository 抽出来的原因很直接——这些函数一个都不碰 knex，
 * 全部只对传进来的值做变换，而它们占了那个文件的前三分之一。
 * `normalizeTraceId` / `normalizeSpanId` 本来就已经被 trace-query-service
 * 跨模块引用了。
 */

import { createHash } from 'node:crypto';
import {
  formatDateTime,
  parseJsonColumn,
} from '../row-mappers.js';
import { redactPayload } from '../../../lib/event-redaction.js';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
export const TERMINAL_RUN = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const TERMINAL_TOOL = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
  'TIMEOUT',
]);
export const TRACE_EVENT_PAGE_SIZE = 500;
export const TERMINAL_SPAN_STATUS = new Set(['ok', 'error', 'cancelled']);
export const TRACE_PROJECTED_SEQUENCE_KEY = 'projectedSequence';
const TRACE_DATETIME_FIELDS = new Set([
  'started_at',
  'finished_at',
]);
const TRACE_NUMERIC_FIELDS = new Set([
  'duration_ms',
  'token_count',
  'cost',
]);

// Trace attributes are a deliberately narrow metadata contract. In particular,
// prompt/message/tool arguments and results must never become durable trace data,
// even when a future caller accidentally passes them to upsert().
const TRACE_ATTRIBUTE_KEYS = new Set([
  'source',
  'queueName',
  'attempt',
  'lastEventType',
  'status',
  'eventType',
  'toolCallId',
  'toolExecutionId',
  'toolName',
  'modelId',
  'provider',
  'errorCode',
  'riskLevel',
  'kind',
  'exitCode',
  'artifactId',
  'displayName',
  'mimeType',
  'sizeBytes',
  'sha256',
  'taskId',
  'clientId',
  'agentId',
]);

/** @param {unknown} value */
export function normalizeTraceId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!TRACE_ID_RE.test(id) || id === '0'.repeat(32)) {
    throw new Error('traceId must be a non-zero lowercase W3C trace id');
  }
  return id;
}

/** @param {unknown} value */
export function normalizeSpanId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  if (!SPAN_ID_RE.test(id) || id === '0'.repeat(16)) {
    throw new Error('spanId must be a non-zero lowercase W3C span id');
  }
  return id;
}

/** Stable W3C span id for facts that do not originate in an OTEL SDK. */
export function deriveSpanId(traceId, ...identity) {
  const trace = normalizeTraceId(traceId);
  let id = createHash('sha256')
    .update([trace, ...identity.map((v) => String(v ?? ''))].join('\0'))
    .digest('hex')
    .slice(0, 16);
  if (id === '0'.repeat(16)) id = `1${id.slice(1)}`;
  return id;
}

export function runRootSpanId(traceId, runId) {
  return deriveSpanId(traceId, 'run', runId);
}

/** @param {unknown} value */
export function maybeSpanId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return SPAN_ID_RE.test(id) && id !== '0'.repeat(16) ? id : null;
}

/** @param {unknown} value @returns {Record<string, unknown> | undefined} */
export function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** @param {unknown} value @returns {Record<string, unknown>} */
export function jsonObject(value) {
  if (value == null) return {};
  try {
    const parsed = parseJsonColumn(value);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

/** @param {unknown} value */
function timestampMs(value) {
  if (value == null) return null;
  try {
    // Reuse the row-mapper's UTC wall-clock rule for raw DATETIME strings.
    const normalized = formatDateTime(value);
    const ms = normalized == null ? NaN : Date.parse(normalized);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export function durationMs(startedAt, finishedAt) {
  const start = timestampMs(startedAt);
  const finish = timestampMs(finishedAt);
  return start != null && finish != null ? Math.max(0, finish - start) : null;
}


/** @param {Record<string, unknown>} row */
export function mapTraceSpan(row) {
  return {
    id: String(row.span_id),
    traceId: String(row.trace_id),
    spanId: String(row.span_id),
    parentSpanId:
      row.parent_span_id == null ? null : String(row.parent_span_id),
    orgId: String(row.org_id),
    userId: String(row.user_id),
    conversationId:
      row.conversation_id == null ? null : String(row.conversation_id),
    agentSessionId:
      row.agent_session_id == null ? null : String(row.agent_session_id),
    runId: row.run_id == null ? null : String(row.run_id),
    sandboxSessionId:
      row.sandbox_session_id == null ? null : String(row.sandbox_session_id),
    executionId:
      row.execution_id == null ? null : String(row.execution_id),
    toolExecutionId:
      row.tool_execution_id == null ? null : String(row.tool_execution_id),
    artifactId: row.artifact_id == null ? null : String(row.artifact_id),
    kind: String(row.kind),
    name: String(row.name),
    status: String(row.status),
    startedAt: formatDateTime(row.started_at),
    finishedAt: formatDateTime(row.finished_at),
    durationMs:
      row.duration_ms == null ? null : Number(row.duration_ms),
    tokens: row.token_count == null ? null : Number(row.token_count),
    cost: row.cost == null ? null : Number(row.cost),
    // Apply the same allowlist on read as on write. This protects traces
    // created by an older/side-channel writer from exposing raw payloads.
    attributes:
      row.attributes_json == null
        ? {}
        : JSON.parse(serializeTraceAttributes(jsonObject(row.attributes_json))),
  };
}

/** Safe bounded metadata only. Raw prompt/tool result fields never enter spans. */
export function serializeTraceAttributes(value) {
  const input =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const allowed = {};
  for (const [key, item] of Object.entries(input)) {
    if (!TRACE_ATTRIBUTE_KEYS.has(key)) continue;
    // Trace attributes are intentionally scalar. Accepting arbitrary nested
    // objects under an allowlisted key would provide a prompt/tool-payload
    // side channel and can also make JSON serialization fail on exotic values.
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
    ) {
      allowed[key] = item;
    }
  }
  const redacted = redactPayload(allowed);
  const raw = JSON.stringify(redacted ?? {});
  if (Buffer.byteLength(raw, 'utf8') <= 32 * 1024) return raw;
  return JSON.stringify({ truncated: true, reason: 'attributes_exceed_32k' });
}

export function normalizeProjectedSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

export function projectedSequenceFrom(value) {
  const attributes = jsonObject(value?.attributes_json ?? value);
  return normalizeProjectedSequence(attributes[TRACE_PROJECTED_SEQUENCE_KEY]) ?? 0;
}

/** Keep the internal replay watermark in MySQL while excluding it from public spans. */
export function serializeStoredTraceAttributes(value, projectedSequence = null) {
  const attributes = JSON.parse(serializeTraceAttributes(value));
  const sequence = normalizeProjectedSequence(projectedSequence);
  if (sequence != null && sequence > 0) {
    attributes[TRACE_PROJECTED_SEQUENCE_KEY] = sequence;
  }
  return JSON.stringify(attributes);
}

function canonicalJson(value) {
  const visit = (item) => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, visit(item[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(visit(jsonObject(value)));
}

function sameStoredValue(field, current, requested) {
  if (field === 'attributes_json') {
    return canonicalJson(current) === canonicalJson(requested);
  }
  if (TRACE_DATETIME_FIELDS.has(field)) {
    return timestampMs(current) === timestampMs(requested);
  }
  if (TRACE_NUMERIC_FIELDS.has(field)) {
    if (current == null || requested == null) return current == null && requested == null;
    return Number(current) === Number(requested);
  }
  if (current == null || requested == null) return current == null && requested == null;
  return String(current) === String(requested);
}

export function isSemanticNoop(existing, patch) {
  return Object.entries(patch).every(([field, value]) =>
    sameStoredValue(field, existing[field], value),
  );
}

export function publicStatus(raw, isError = false) {
  const status = String(raw ?? '').toUpperCase();
  if (
    isError ||
    status === 'FAILED' ||
    status === 'UNKNOWN' ||
    status === 'TIMEOUT'
  ) {
    return 'error';
  }
  if (status === 'CANCELLED' || status === 'CANCELLING') return 'cancelled';
  if (
    status === 'SUCCEEDED' ||
    status === 'SUCCESS' ||
    status === 'COMPLETED' ||
    status === 'READY'
  ) {
    return 'ok';
  }
  return 'running';
}

export function eventLifecycle(eventType, data) {
  const type = String(eventType || '').toLowerCase();
  if (type.endsWith('.failed') || type === 'error.occurred') return 'error';
  if (type.endsWith('.cancelled')) return 'cancelled';
  if (
    type.endsWith('.completed') ||
    type.endsWith('.ready') ||
    type.endsWith('.saved') ||
    type.endsWith('.projected') ||
    type.endsWith('.compacted')
  ) {
    return data?.isError ? 'error' : 'ok';
  }
  return 'running';
}

export function usageFrom(data) {
  const usage =
    data?.usage && typeof data.usage === 'object' ? data.usage : data ?? {};
  const tokenCandidates = [
    usage.totalTokens,
    usage.total_tokens,
    usage.tokens,
    usage.inputTokens != null || usage.outputTokens != null
      ? Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0)
      : null,
    usage.input_tokens != null || usage.output_tokens != null
      ? Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)
      : null,
  ];
  const token = tokenCandidates.find(
    (v) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0,
  );
  const costCandidates = [usage.cost, usage.totalCost, usage.total_cost];
  const cost = costCandidates.find(
    (v) => v != null && Number.isFinite(Number(v)) && Number(v) >= 0,
  );
  return {
    tokens: token == null ? null : Math.trunc(Number(token)),
    cost: cost == null ? null : Number(cost),
  };
}
