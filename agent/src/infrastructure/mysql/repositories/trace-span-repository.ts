/** Durable owner-scoped trace-span projection over formal Agent MySQL facts. */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import { toMysqlDateTime } from '../row-mappers.js';
import {
  TERMINAL_RUN,
  TERMINAL_SPAN_STATUS,
  TERMINAL_TOOL,
  TRACE_EVENT_PAGE_SIZE,
  TRACE_PROJECTED_SEQUENCE_KEY,
  asRecord,
  deriveSpanId,
  durationMs,
  eventLifecycle,
  isSemanticNoop,
  jsonObject,
  mapTraceSpan,
  maybeSpanId,
  normalizeProjectedSequence,
  normalizeSpanId,
  normalizeTraceId,
  projectedSequenceFrom,
  publicStatus,
  runRootSpanId,
  serializeStoredTraceAttributes,
  usageFrom,
} from './trace-span-projections.js';

// 这几个纯函数原本定义在本模块，拆分后仍从这里导出——外部消费者
// （trace-query-service、subagent-spawn-service、repositories/index）
// 引的是它们的既有位置，没有理由为一次内部拆分而改动。
export {
  deriveSpanId,
  mapTraceSpan,
  normalizeSpanId,
  normalizeTraceId,
  runRootSpanId,
  serializeTraceAttributes,
} from './trace-span-projections.js';

/** 过渡期宽松类型：注入的 knex executor 仍是 JS 侧对象。 */
type Loose = any;

/** Owner-scoped 查询的租户边界。 */
type OwnerScope = { orgId: string; userId: string };


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

export class TraceSpanRepository {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  db: Loose;
  now: Loose;

  /** @param {import('knex').Knex | import('knex').Knex.Transaction} db */
  constructor(db: Loose, opts: { now?: () => Date } = {}) {
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
    // REPEATABLE READ: a non-locking SELECT freezes a snapshot for the whole
    // transaction, so CAS retries livelock against a newer committed row
    // (streaming watermark vs GET /trace materialize). Locking reads see the
    // latest version and serialize writers on this span.
    let existingQuery = this.db('trace_spans').where({
      trace_id: traceId,
      span_id: spanId,
    });
    if (this.db.isTransaction === true) {
      existingQuery = existingQuery.forUpdate();
    }
    const existing = await existingQuery.first();

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
      // Watermark lives in attributes_json; pair it with updated_at so a
      // status-only writer still invalidates a stale merge.
      if (existing.attributes_json == null) {
        update = update.whereNull('attributes_json');
      } else if (typeof update.whereRaw === 'function' && this.db.client) {
        // CAST: MySQL treats JSON vs quoted string as different types.
        update = update.whereRaw('attributes_json = CAST(? AS JSON)', [
          JSON.stringify(jsonObject(existing.attributes_json)),
        ]);
      } else {
        update = update.andWhere('attributes_json', existing.attributes_json);
      }
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
        // Concurrent first-writers: re-read the winner and merge.
        if ((err as { code?: string })?.code !== 'ER_DUP_ENTRY') {
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
    const data = asRecord(payload.data) ?? payload;
    const context = asRecord(payload.context) ?? {};
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
      name = String(data.modelId ?? asRecord(data.model)?.id ?? 'Model call');
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
        modelId: data.modelId ?? asRecord(data.model)?.id ?? null,
        provider: data.provider ?? asRecord(data.model)?.provider ?? null,
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
        const data = asRecord(payload.data) ?? payload;
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

  async listByRun(
    runId: string,
    traceId: string,
    scope: OwnerScope,
    opts: { cursor?: string | null; includePageInfo?: boolean; limit?: number } = {},
  ) {
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
