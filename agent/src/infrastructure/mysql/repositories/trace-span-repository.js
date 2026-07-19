/** Durable owner-scoped trace-span projection over formal Agent MySQL facts. */

import { createHash } from 'node:crypto';
import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import {
  formatDateTime,
  parseJsonColumn,
  toMysqlDateTime,
} from '../row-mappers.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { redactPayload } from '../../pi/platform-event-projector.js';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TERMINAL_RUN = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL_TOOL = new Set([
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
  'TIMEOUT',
]);
const TRACE_EVENT_PAGE_SIZE = 500;
const TERMINAL_SPAN_STATUS = new Set(['ok', 'error', 'cancelled']);
const TRACE_PROJECTED_SEQUENCE_KEY = 'projectedSequence';
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
function maybeSpanId(value) {
  const id = String(value ?? '').trim().toLowerCase();
  return SPAN_ID_RE.test(id) && id !== '0'.repeat(16) ? id : null;
}

/** @param {unknown} value */
function jsonObject(value) {
  if (value == null) return {};
  try {
    const parsed = parseJsonColumn(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
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

function durationMs(startedAt, finishedAt) {
  const start = timestampMs(startedAt);
  const finish = timestampMs(finishedAt);
  return start != null && finish != null ? Math.max(0, finish - start) : null;
}

/**
 * Reject parent chains that would introduce a cycle or cross-run/owner link.
 * Unknown parents are allowed for an upstream W3C span that is not persisted
 * in this service; the frontend will safely render such a span as a root.
 */
async function assertParentChain(db, { traceId, spanId, parentSpanId, runId, scope }) {
  if (!parentSpanId) return;
  const seen = new Set([spanId]);
  let cursor = parentSpanId;
  for (let depth = 0; depth < 64 && cursor; depth += 1) {
    if (seen.has(cursor)) {
      throw new Error('trace span parent cycle detected');
    }
    seen.add(cursor);
    const row = await db('trace_spans')
      .where({ trace_id: traceId, span_id: cursor })
      .first();
    if (!row) return;
    if (
      String(row.org_id) !== scope.orgId ||
      String(row.user_id) !== scope.userId
    ) {
      throw new Error('trace span parent ownership mismatch');
    }
    if (row.run_id != null && runId != null && String(row.run_id) !== String(runId)) {
      throw new Error('trace span parent run mismatch');
    }
    cursor = row.parent_span_id == null ? null : String(row.parent_span_id);
  }
  if (cursor) throw new Error('trace span parent chain is too deep');
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

function normalizeProjectedSequence(value) {
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function projectedSequenceFrom(value) {
  const attributes = jsonObject(value?.attributes_json ?? value);
  return normalizeProjectedSequence(attributes[TRACE_PROJECTED_SEQUENCE_KEY]) ?? 0;
}

/** Keep the internal replay watermark in MySQL while excluding it from public spans. */
function serializeStoredTraceAttributes(value, projectedSequence = null) {
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

function isSemanticNoop(existing, patch) {
  return Object.entries(patch).every(([field, value]) =>
    sameStoredValue(field, existing[field], value),
  );
}

function publicStatus(raw, isError = false) {
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

function eventLifecycle(eventType, data) {
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

function usageFrom(data) {
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

export class TraceSpanRepository {
  /** @param {import('knex').Knex | import('knex').Knex.Transaction} db */
  constructor(db, opts = {}) {
    if (!db) throw new Error('TraceSpanRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /** Bind the same projection policy to a caller-owned transaction executor. */
  forExecutor(db) {
    return new TraceSpanRepository(db, { now: this.now });
  }

  async upsert(input, retryCount = 0) {
    const scope = requireOwnerScope(input);
    const traceId = normalizeTraceId(input.traceId);
    const spanId = normalizeSpanId(input.spanId);
    const parentSpanId =
      input.parentSpanId == null ? null : normalizeSpanId(input.parentSpanId);
    if (parentSpanId === spanId) {
      throw new Error('trace span cannot be its own parent');
    }
    const runId = input.runId ? assertUlid(input.runId, 'runId') : null;
    const existing = await this.db('trace_spans')
      .where({ trace_id: traceId, span_id: spanId })
      .first();

    if (
      existing &&
      (String(existing.org_id) !== scope.orgId ||
        String(existing.user_id) !== scope.userId)
    ) {
      throw new Error('trace/span identity is already owned by another subject');
    }
    await assertParentChain(this.db, {
      traceId,
      spanId,
      parentSpanId,
      runId,
      scope,
    });

    const now = this.now();
    const existingAttrs = existing ? jsonObject(existing.attributes_json) : {};
    const requestedStatus = String(
      input.status ?? existing?.status ?? 'running',
    ).slice(0, 32);
    const existingStatus = String(existing?.status ?? '').toLowerCase();
    const requestedStatusLower = requestedStatus.toLowerCase();
    const existingIsTerminal = TERMINAL_SPAN_STATUS.has(existingStatus);
    const allowTerminalOverride = input.allowTerminalOverride === true;
    // A durable terminal lifecycle cannot be reopened or rewritten by a
    // delayed/replayed fact. Callers with a stronger source of truth (for
    // example the ToolExecution ledger during restart materialization) must
    // opt in explicitly before replacing a terminal status.
    const keepTerminalState =
      existingIsTerminal &&
      !allowTerminalOverride &&
      requestedStatusLower !== existingStatus;
    const startedAt =
      existing?.started_at ?? input.startedAt ?? input.finishedAt ?? now;
    const finishedAt =
      existingIsTerminal && !allowTerminalOverride && existing?.finished_at != null
        ? existing.finished_at
        : input.finishedAt ?? existing?.finished_at ?? null;
    const requestedProjectedSequence = normalizeProjectedSequence(
      input.internalAttributes?.[TRACE_PROJECTED_SEQUENCE_KEY],
    );
    const projectedSequence = Math.max(
      projectedSequenceFrom(existingAttrs),
      requestedProjectedSequence ?? 0,
    );
    const semanticPatch = {
      parent_span_id:
        parentSpanId ?? existing?.parent_span_id ?? null,
      org_id: scope.orgId,
      user_id: scope.userId,
      conversation_id:
        input.conversationId ?? existing?.conversation_id ?? null,
      agent_session_id:
        input.agentSessionId ?? existing?.agent_session_id ?? null,
      run_id: runId ?? existing?.run_id ?? null,
      sandbox_session_id:
        input.sandboxSessionId ?? existing?.sandbox_session_id ?? null,
      execution_id: input.executionId ?? existing?.execution_id ?? null,
      tool_execution_id:
        input.toolExecutionId ?? existing?.tool_execution_id ?? null,
      artifact_id: input.artifactId ?? existing?.artifact_id ?? null,
      kind: String(input.kind ?? existing?.kind ?? 'other').slice(0, 32),
      name: String(input.name ?? existing?.name ?? 'span').slice(0, 255),
      status: keepTerminalState ? String(existing.status) : requestedStatus,
      started_at: toMysqlDateTime(startedAt),
      finished_at: finishedAt == null ? null : toMysqlDateTime(finishedAt),
      duration_ms:
        input.durationMs ??
        existing?.duration_ms ??
        durationMs(startedAt, finishedAt),
      token_count: input.tokens ?? existing?.token_count ?? null,
      cost: input.cost ?? existing?.cost ?? null,
      attributes_json: serializeStoredTraceAttributes(
        {
          ...existingAttrs,
          ...(!keepTerminalState &&
          input.attributes &&
          typeof input.attributes === 'object'
            ? input.attributes
            : {}),
        },
        projectedSequence,
      ),
    };

    if (existing) {
      if (isSemanticNoop(existing, semanticPatch)) return mapTraceSpan(existing);
      const patch = {
        ...semanticPatch,
        updated_at: toMysqlDateTime(now),
      };
      let update = this.db('trace_spans').where({
        trace_id: traceId,
        span_id: spanId,
        org_id: scope.orgId,
        user_id: scope.userId,
      });
      // attributes_json contains the internal watermark. Use it as an
      // optimistic token so a concurrent materializer cannot be overwritten by
      // a stale ordinary span update that read an older watermark.
      if (existing.attributes_json == null) {
        update = update.whereNull('attributes_json');
      } else if (typeof update.whereRaw === 'function' && this.db.client) {
        // MySQL compares a JSON column to a quoted string as different JSON
        // types. CAST the token back to JSON so the CAS is semantic, not a
        // brittle byte-for-byte string comparison.
        update = update.whereRaw('attributes_json = CAST(? AS JSON)', [
          JSON.stringify(jsonObject(existing.attributes_json)),
        ]);
      } else {
        // Connection-free fakes and minimal query adapters may not implement
        // whereRaw; their JSON values are represented as the original string.
        update = update.andWhere('attributes_json', existing.attributes_json);
      }
      // Include the row timestamp in the CAS as well. A concurrent update may
      // legitimately leave attributes_json unchanged while changing status or
      // lifecycle fields; that update must still force a re-read before merge.
      if (existing.updated_at == null) {
        update = update.whereNull('updated_at');
      } else {
        update = update.andWhere('updated_at', existing.updated_at);
      }
      const affected = await update.update(patch);
      if (!Number(affected)) {
        if (retryCount >= 16) {
          throw new Error('trace span optimistic upsert did not converge');
        }
        return this.upsert(input, retryCount + 1);
      }
    } else {
      const patch = {
        ...semanticPatch,
        updated_at: toMysqlDateTime(now),
      };
      try {
        await this.db('trace_spans').insert({
          trace_id: traceId,
          span_id: spanId,
          ...patch,
          created_at: toMysqlDateTime(now),
        });
      } catch (err) {
        // Two restart-safe materializers can observe an absent span at the
        // same time. Re-read the winner and apply the normal owner/merge path
        // instead of surfacing a transient duplicate-key failure.
        if (/** @type {{ code?: string }} */ (err)?.code !== 'ER_DUP_ENTRY') {
          throw err;
        }
        if (retryCount >= 16) {
          throw new Error('trace span duplicate-key upsert did not converge');
        }
        return this.upsert(input, retryCount + 1);
      }
    }
    const row = await this.db('trace_spans')
      .where({ trace_id: traceId, span_id: spanId })
      .first();
    return mapTraceSpan(row);
  }

  /**
   * Advance the event projection watermark monotonically. The value is stored
   * only in the Run root's private attributes_json and never mapped to the API.
   */
  async advanceRunProjectionWatermark(fact, scope, sequenceValue = undefined) {
    const owner = requireOwnerScope(scope);
    const traceId = normalizeTraceId(fact.traceId ?? fact.trace_id);
    const runId = assertUlid(fact.runId ?? fact.run_id, 'runId');
    const sequence = normalizeProjectedSequence(
      sequenceValue ?? fact.sequenceNo ?? fact.sequence_no,
    );
    if (sequence == null) {
      throw new Error('trace projection sequence must be a non-negative safe integer');
    }
    return this.upsert({
      ...owner,
      traceId,
      spanId: runRootSpanId(traceId, runId),
      runId,
      conversationId: fact.conversationId ?? fact.conversation_id ?? null,
      agentSessionId: fact.agentSessionId ?? fact.agent_session_id ?? null,
      kind: 'run',
      name: 'Run',
      status: publicStatus(fact.status ?? 'RUNNING'),
      startedAt: fact.createdAt ?? fact.created_at ?? this.now(),
      internalAttributes: { [TRACE_PROJECTED_SEQUENCE_KEY]: sequence },
    });
  }

  async ensureRunRoot(run, scope) {
    const owner = requireOwnerScope(scope);
    const traceId = normalizeTraceId(run.traceId ?? run.trace_id);
    const runId = assertUlid(run.runId ?? run.run_id, 'runId');
    const rawStatus = run.status ?? 'RUNNING';
    const terminal = TERMINAL_RUN.has(String(rawStatus).toUpperCase());
    return this.upsert({
      ...owner,
      traceId,
      spanId: runRootSpanId(traceId, runId),
      runId,
      conversationId: run.conversationId ?? run.conversation_id ?? null,
      agentSessionId: run.agentSessionId ?? run.agent_session_id ?? null,
      kind: 'run',
      name: 'Run',
      status: publicStatus(rawStatus),
      allowTerminalOverride: true,
      startedAt: run.createdAt ?? run.created_at ?? this.now(),
      finishedAt:
        run.completedAt ?? run.completed_at ?? (terminal ? run.updatedAt : null),
      attributes: {
        source: run.source ?? null,
        queueName: run.queueName ?? run.queue_name ?? null,
        attempt: run.attempt ?? null,
      },
    });
  }

  /** Project one durable run_events row into one or more stable spans. */
  async projectRunEvent(event, scope) {
    const owner = requireOwnerScope(scope);
    const traceId = normalizeTraceId(event.traceId ?? event.trace_id);
    const runId = assertUlid(event.runId ?? event.run_id, 'runId');
    const eventType = String(event.eventType ?? event.event_type ?? 'event');
    const payload = jsonObject(event.payloadJson ?? event.payload_json);
    const data =
      payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
        ? payload.data
        : payload;
    const context =
      payload.context && typeof payload.context === 'object' ? payload.context : {};
    const at = event.createdAt ?? event.created_at ?? this.now();
    const root = runRootSpanId(traceId, runId);
    const lower = eventType.toLowerCase();

    // Progress is a timeline update, not a new durable lifecycle. The Tool
    // ledger/materializer owns the authoritative status and prevents a late
    // progress frame from reopening a terminal span.
    if (lower === 'tool.execution.progress') return;

    // Run lifecycle owns the root and queue-wait child.
    if (lower.startsWith('run.')) {
      const rawStatus = data.status ?? data.to ?? eventType.split('.').pop();
      const status = publicStatus(rawStatus, lower.endsWith('.failed'));
      const terminal = status !== 'running';
      const upstreamParentSpanId =
        lower === 'run.accepted' || lower === 'run.created'
          ? maybeSpanId(event.spanId ?? event.span_id ?? context.spanId)
          : null;
      await this.upsert({
        ...owner,
        traceId,
        spanId: root,
        parentSpanId: upstreamParentSpanId,
        runId,
        conversationId: context.conversationId ?? data.conversationId ?? null,
        agentSessionId: context.agentSessionId ?? data.agentSessionId ?? null,
        kind: 'run',
        name: 'Run',
        status,
        startedAt: at,
        finishedAt: terminal ? at : null,
        attributes: { lastEventType: eventType, status: rawStatus },
      });
      if (lower === 'run.queued') {
        const queueIdentity =
          event.eventId ?? event.event_id ?? event.sequenceNo ?? event.sequence_no ?? at;
        await this.upsert({
          ...owner,
          traceId,
          spanId: deriveSpanId(traceId, 'queue', runId, queueIdentity),
          parentSpanId: root,
          runId,
          kind: 'queue',
          name: 'Queue wait',
          status: 'running',
          startedAt: at,
          attributes: { eventType },
        });
      } else if (lower === 'run.started' || status !== 'running') {
        const openQueue = await applyOwnerScope(
          this.db('trace_spans').where({
            run_id: runId,
            trace_id: traceId,
            kind: 'queue',
            status: 'running',
          }),
          owner,
        )
          .orderBy('started_at', 'desc')
          .first();
        if (openQueue) {
          await this.upsert({
            ...owner,
            traceId,
            spanId: openQueue.span_id,
            parentSpanId: root,
            runId,
            kind: 'queue',
            name: 'Queue wait',
            status: lower === 'run.started' ? 'ok' : status,
            finishedAt: at,
            attributes: { eventType },
          });
        }
      }
      return;
    }

    let kind;
    let name = eventType;
    let identity = event.eventId ?? event.event_id ?? eventType;
    let parentSpanId = root;
    if (lower.startsWith('tool.')) {
      const source = String(data.toolSource ?? data.tool_source ?? '').toLowerCase();
      kind = source === 'mcp' ? 'mcp' : 'tool';
      name = String(data.toolName ?? data.tool_name ?? 'Tool call');
      // The proposal event exists before a ToolExecution ULID is allocated.
      // toolCallId is therefore the only identity shared by the complete
      // proposal -> execution lifecycle and its durable ledger row.
      identity = data.toolCallId ?? data.toolExecutionId ?? identity;
    } else if (lower.startsWith('model.request.')) {
      kind = 'model';
      name = String(data.modelId ?? data.model?.id ?? 'Model call');
      identity = data.correlationId ?? data.messageId ?? identity;
    } else if (lower.startsWith('sandbox.') || lower.startsWith('execution.')) {
      kind = 'sandbox';
      name = String(data.kind ?? 'Sandbox execution');
      identity = data.executionId ?? identity;
      const toolIdentity = data.toolCallId ?? data.toolExecutionId;
      if (toolIdentity) parentSpanId = deriveSpanId(traceId, 'tool', toolIdentity);
    } else if (lower.startsWith('mcp.')) {
      kind = 'mcp';
      name = String(data.toolName ?? data.serverName ?? 'MCP call');
      identity = data.correlationId ?? data.toolCallId ?? identity;
    } else if (lower === 'artifact.ready') {
      kind = 'artifact';
      name = 'Artifact submit';
      identity = data.artifactId ?? identity;
      const toolIdentity = data.toolCallId ?? data.toolExecutionId;
      if (toolIdentity) parentSpanId = deriveSpanId(traceId, 'tool', toolIdentity);
    } else if (lower.startsWith('session.')) {
      kind = 'session';
      name = lower.includes('snapshot') ? 'Pi session checkpoint' : 'Pi session';
      identity = data.snapshotId ?? event.eventId ?? identity;
    } else if (lower.startsWith('a2a.')) {
      kind = 'a2a';
      name = 'A2A projection';
    } else if (lower === 'error.occurred') {
      kind = 'error';
      name = 'Error';
      identity = data.errorId ?? identity;
    } else {
      // Timeline events are not spans. In particular, messages, process
      // output, approvals and datasets must not create permanent running
      // nodes merely because they share the Run event stream.
      return;
    }

    const explicit = maybeSpanId(event.spanId ?? event.span_id ?? context.spanId);
    const spanId = explicit ?? deriveSpanId(traceId, kind, identity);
    const lifecycle = eventLifecycle(eventType, data);
    const usage = usageFrom(data);
    const finishedAt = lifecycle === 'running' ? null : at;
    await this.upsert({
      ...owner,
      traceId,
      spanId,
      parentSpanId:
        maybeSpanId(data.parentSpanId ?? data.parent_span_id) ?? parentSpanId,
      runId,
      conversationId: context.conversationId ?? null,
      agentSessionId: context.agentSessionId ?? null,
      sandboxSessionId: context.sandboxSessionId ?? null,
      executionId: data.executionId ?? null,
      toolExecutionId: data.toolExecutionId ?? null,
      artifactId: data.artifactId ?? null,
      kind,
      name,
      status: lifecycle,
      startedAt: at,
      finishedAt,
      tokens: usage.tokens,
      cost: usage.cost,
      attributes: {
        eventType,
        toolCallId: data.toolCallId ?? null,
        toolExecutionId: data.toolExecutionId ?? null,
        toolName: data.toolName ?? null,
        source:
          data.source ?? data.toolSource ?? data.tool_source ?? null,
        modelId: data.modelId ?? data.model?.id ?? null,
        provider: data.provider ?? data.model?.provider ?? null,
        errorCode: data.errorCode ?? data.error_code ?? null,
      },
    });
  }

  /** Backfill/refresh spans from facts that survive Redis and process restarts. */
  async materializeRunFacts(run, scope) {
    const owner = requireOwnerScope(scope);
    const runId = assertUlid(run.runId ?? run.run_id, 'runId');
    const traceId = normalizeTraceId(run.traceId ?? run.trace_id);
    const root = runRootSpanId(traceId, runId);
    await this.ensureRunRoot(run, owner);

    const rootRow = await applyOwnerScope(
      this.db('trace_spans').where({
        trace_id: traceId,
        span_id: root,
        run_id: runId,
      }),
      owner,
    ).first();
    let afterSequence = projectedSequenceFrom(rootRow);
    let targetSequence = normalizeProjectedSequence(
      run.nextEventSequence ?? run.next_event_sequence,
    );
    if (targetSequence == null) {
      // Compatibility for direct repository callers that pass a partial Run.
      // The production query service supplies runs.next_event_sequence.
      const maxRow = await this.db('run_events')
        .where({ run_id: runId, trace_id: traceId })
        .max('sequence_no as max_seq')
        .first();
      targetSequence = normalizeProjectedSequence(maxRow?.max_seq) ?? 0;
    }

    // Artifact rows intentionally do not carry a ToolExecution FK. Preserve
    // the explicit relationship from artifact.ready while replaying events so
    // multiple submit_artifact calls retain their individual tree parents.
    const artifactParentRefs = new Map();
    while (afterSequence < targetSequence) {
      let eventQuery = this.db('run_events')
        .where({ run_id: runId, trace_id: traceId })
        .andWhere('sequence_no', '>', afterSequence)
        .orderBy('sequence_no', 'asc');
      if (targetSequence < Number.MAX_SAFE_INTEGER) {
        eventQuery = eventQuery.andWhere('sequence_no', '<', targetSequence + 1);
      }
      const events = await eventQuery.limit(TRACE_EVENT_PAGE_SIZE);
      if (!events?.length) {
        throw new Error('trace materialization did not reach its event watermark');
      }
      for (const event of events || []) {
        if (event.org_id != null && String(event.org_id) !== owner.orgId) {
          throw new Error('run event ownership mismatch while materializing trace');
        }
        const sequence = Number(event.sequenceNo ?? event.sequence_no);
        if (!Number.isSafeInteger(sequence) || sequence !== afterSequence + 1) {
          throw new Error('invalid run event sequence while materializing trace');
        }
        const eventType = String(
          event.eventType ?? event.event_type ?? '',
        ).toLowerCase();
        const payload = jsonObject(event.payloadJson ?? event.payload_json);
        const data =
          payload.data &&
          typeof payload.data === 'object' &&
          !Array.isArray(payload.data)
            ? payload.data
            : payload;
        if (eventType === 'artifact.ready' && data.artifactId) {
          artifactParentRefs.set(String(data.artifactId), {
            toolExecutionId:
              data.toolExecutionId ?? data.tool_execution_id ?? null,
            toolCallId: data.toolCallId ?? data.tool_call_id ?? null,
          });
        }
        await this.projectRunEvent(event, owner);
        afterSequence = sequence;
      }
    }

    const tools = await this.db('tool_executions')
      .where({ run_id: runId, trace_id: traceId })
      .orderBy('created_at', 'asc');
    const toolById = new Map();
    for (const tool of tools || []) {
      const toolIdentity = String(tool.tool_call_id || tool.tool_execution_id);
      const spanId = deriveSpanId(traceId, 'tool', toolIdentity);
      toolById.set(String(tool.tool_execution_id), spanId);
      const terminal = TERMINAL_TOOL.has(String(tool.status).toUpperCase());
      await this.upsert({
        ...owner,
        traceId,
        spanId,
        parentSpanId: root,
        runId,
        agentSessionId: tool.agent_session_id,
        toolExecutionId: tool.tool_execution_id,
        kind: String(tool.tool_source).toLowerCase() === 'mcp' ? 'mcp' : 'tool',
        name: String(tool.tool_name),
        status: publicStatus(tool.status),
        startedAt: tool.started_at ?? tool.created_at,
        finishedAt: terminal ? tool.completed_at ?? tool.created_at : null,
        // The ToolExecution ledger is authoritative after a restart and may
        // reconcile an earlier event projection (for example UNKNOWN).
        allowTerminalOverride: true,
        attributes: {
          toolCallId: tool.tool_call_id,
          toolExecutionId: tool.tool_execution_id,
          source: tool.tool_source,
          riskLevel: tool.risk_level,
          errorCode: tool.error_code,
        },
      });
    }

    const sandboxExecutions = await this.db('sandbox_executions')
      .where({ run_id: runId, org_id: owner.orgId, user_id: owner.userId })
      .orderBy('created_at', 'asc');
    for (const execution of sandboxExecutions || []) {
      if (execution.trace_id && normalizeTraceId(execution.trace_id) !== traceId) continue;
      const terminal = ['SUCCEEDED', 'SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT', 'UNKNOWN']
        .includes(String(execution.status).toUpperCase());
      await this.upsert({
        ...owner,
        traceId,
        spanId: deriveSpanId(traceId, 'sandbox', execution.execution_id),
        parentSpanId:
          toolById.get(String(execution.tool_execution_id)) ?? root,
        runId,
        agentSessionId: execution.agent_session_id,
        sandboxSessionId: execution.sandbox_session_id,
        executionId: execution.execution_id,
        toolExecutionId: execution.tool_execution_id,
        kind: 'sandbox',
        name: String(execution.kind || 'Sandbox execution'),
        status: publicStatus(execution.status),
        startedAt: execution.started_at ?? execution.created_at,
        finishedAt: terminal ? execution.completed_at ?? execution.created_at : null,
        // Sandbox execution rows are the durable outcome source for this
        // projection, so they may reconcile an event-derived terminal state.
        allowTerminalOverride: true,
        attributes: {
          kind: execution.kind,
          exitCode: execution.exit_code,
          errorCode: execution.error_code,
          toolCallId: execution.tool_call_id,
        },
      });
    }

    const artifacts = await this.db('artifacts')
      .where({ run_id: runId, org_id: owner.orgId, user_id: owner.userId })
      .orderBy('created_at', 'asc');
    const existingArtifactParents = new Map();
    if (artifacts?.length) {
      const existingArtifactSpans = await applyOwnerScope(
        this.db('trace_spans').where({
          run_id: runId,
          trace_id: traceId,
          kind: 'artifact',
        }),
        owner,
      );
      for (const span of existingArtifactSpans || []) {
        if (span.artifact_id != null && span.parent_span_id != null) {
          existingArtifactParents.set(
            String(span.artifact_id),
            String(span.parent_span_id),
          );
        }
      }
    }
    for (const artifact of artifacts || []) {
      const parentRef = artifactParentRefs.get(String(artifact.artifact_id));
      const artifactSpanId = deriveSpanId(traceId, 'artifact', artifact.artifact_id);
      let parentSpanId = parentRef?.toolExecutionId
        ? toolById.get(String(parentRef.toolExecutionId)) ??
          (parentRef.toolCallId
            ? deriveSpanId(traceId, 'tool', parentRef.toolCallId)
            : root)
        : parentRef?.toolCallId
          ? deriveSpanId(traceId, 'tool', parentRef.toolCallId)
          : null;
      if (!parentSpanId) {
        parentSpanId =
          existingArtifactParents.get(String(artifact.artifact_id)) ?? root;
      }
      await this.upsert({
        ...owner,
        traceId,
        spanId: artifactSpanId,
        parentSpanId,
        runId,
        conversationId: artifact.conversation_id,
        agentSessionId: artifact.agent_session_id,
        artifactId: artifact.artifact_id,
        kind: 'artifact',
        name: 'Artifact submit',
        status: publicStatus(artifact.status),
        startedAt: artifact.created_at,
        finishedAt: artifact.created_at,
        attributes: {
          artifactId: artifact.artifact_id,
          displayName: artifact.display_name,
          mimeType: artifact.mime_type,
          sizeBytes: artifact.size_bytes,
          sha256: artifact.sha256,
        },
      });
    }

    const a2aTasks = await this.db('a2a_tasks')
      .where({ run_id: runId, org_id: owner.orgId, user_id: owner.userId })
      .orderBy('created_at', 'asc');
    for (const task of a2aTasks || []) {
      await this.upsert({
        ...owner,
        traceId,
        spanId: deriveSpanId(traceId, 'a2a', task.a2a_task_id),
        parentSpanId: root,
        runId,
        conversationId: task.conversation_id,
        kind: 'a2a',
        name: 'A2A projection',
        status: publicStatus(run.status),
        startedAt: task.created_at,
        finishedAt: run.completedAt ?? run.completed_at ?? null,
        attributes: {
          taskId: task.a2a_task_id,
          clientId: task.client_id,
          agentId: task.agent_id,
        },
      });
    }

    // Advance only after every event and durable ledger fact above has been
    // projected successfully. Any exception leaves the previous watermark.
    await this.advanceRunProjectionWatermark(run, owner, targetSequence);
  }

  async listByRun(runId, traceId, scope, opts = {}) {
    const owner = requireOwnerScope(scope);
    const id = assertUlid(runId, 'runId');
    const trace = normalizeTraceId(traceId);
    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 1000);
    const cursor = opts.cursor == null || opts.cursor === ''
      ? null
      : normalizeSpanId(opts.cursor);
    let query = applyOwnerScope(
      this.db('trace_spans').where({ run_id: id, trace_id: trace }),
      owner,
    );
    if (cursor) query = query.andWhere('span_id', '>', cursor);

    if (opts.includePageInfo || cursor) {
      const rows = await query.orderBy('span_id', 'asc').limit(limit + 1);
      const truncated = (rows || []).length > limit;
      const pageRows = (rows || []).slice(0, limit);
      const spans = pageRows.map(mapTraceSpan);
      return {
        spans,
        truncated,
        nextCursor:
          truncated && pageRows.length > 0
            ? String(pageRows[pageRows.length - 1].span_id)
            : null,
      };
    }

    const rows = await query.orderBy('started_at', 'asc').limit(limit);
    return (rows || []).map(mapTraceSpan);
  }
}
