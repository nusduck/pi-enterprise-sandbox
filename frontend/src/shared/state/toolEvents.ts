/**
 * tool.* / approval.* branch of the unified reducer (split out of
 * runReducer.ts, which is pinned by the layout ratchet).
 */
import type {
  EntityStore,
  ToolSource,
} from '../../entities/types';
import {
  createApproval,
  createRun,
  createToolExecution,
  createTraceSpan,
  upsertApproval,
  upsertRun,
  upsertToolExecution,
  upsertTraceSpan,
} from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import {
  inferToolSource,
  isExternalRiskApproval,
} from './platformEventNormalize';

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
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

export function reduceToolEvent(
  store: EntityStore,
  ev: RuntimeEvent,
  payload: Record<string, unknown>,
  ts: string | null,
): EntityStore {
  const runId = ev.run_id;
  let next = store;

  switch (ev.type) {
    case 'tool.prepared':
    case 'tool.started':
    case 'tool.progress': {
      const toolId = str(payload.tool_call_id || payload.id || payload.tool_id);
      if (!toolId) break;
      const existing = next.toolExecutionsById[toolId];
      const name = str(payload.name || existing?.name, 'tool');
      const source = (existing?.source && existing.source !== 'unknown'
        ? existing.source
        : inferToolSource(name, payload)) as ToolSource;
      next = upsertToolExecution(
        next,
        createToolExecution({
          id: toolId,
          runId,
          name,
          source,
          status:
            ev.type === 'tool.prepared'
              ? 'prepared'
              : existing?.status === 'waiting_approval'
                ? 'waiting_approval'
                : 'running',
          input: payload.input ?? payload.args ?? existing?.input ?? null,
          summary:
            payload.summary != null
              ? str(payload.summary)
              : existing?.summary ?? null,
          spanId:
            payload.span_id != null
              ? str(payload.span_id)
              : existing?.spanId ?? null,
          approvalId: existing?.approvalId ?? null,
          processId: existing?.processId ?? null,
          result: existing?.result ?? null,
          isError: existing?.isError ?? false,
          seq: existing?.seq ?? ev.sequence,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      // Trace span for tool
      if (ev.type === 'tool.started' || ev.type === 'tool.prepared') {
        const spanId = str(payload.span_id, `toolspan_${toolId}`);
        next = upsertTraceSpan(
          next,
          createTraceSpan({
            id: spanId,
            runId,
            parentId: next.runsById[runId]?.traceId
              ? `runspan_${runId}`
              : null,
            kind: source === 'mcp' ? 'mcp' : source === 'sandbox' ? 'sandbox' : 'tool',
            name,
            status: 'running',
            spanId: payload.span_id != null ? str(payload.span_id) : null,
            startedAt: existing?.createdAt || ts,
            metadata: { toolCallId: toolId, source },
          }),
        );
      }
      if (ev.type === 'tool.started') {
        next = touchRun(next, runId, { status: 'running' });
      }
      break;
    }

    case 'tool.approval_required': {
      const approvalId = str(payload.approval_id || payload.id);
      const toolId = str(payload.tool_call_id || payload.tool_id) || null;
      if (!approvalId) break;
      const toolName =
        toolId && next.toolExecutionsById[toolId]
          ? next.toolExecutionsById[toolId].name
          : str(payload.tool_name || payload.name);
      // Plan §19.9: ordinary Bash must not open the approval panel.
      if (!isExternalRiskApproval(payload, toolName)) {
        break;
      }
      const existingAppr = next.approvalsById[approvalId];
      next = upsertApproval(
        next,
        createApproval({
          id: approvalId,
          runId,
          toolExecutionId: toolId || existingAppr?.toolExecutionId || null,
          idempotencyKey:
            payload.idempotency_key != null
              ? str(payload.idempotency_key)
              : existingAppr?.idempotencyKey ?? null,
          status: existingAppr?.status === 'approved' || existingAppr?.status === 'rejected'
            ? existingAppr.status
            : 'pending',
          reason: str(payload.reason || payload.command || existingAppr?.reason),
          command:
            payload.command != null
              ? str(payload.command)
              : existingAppr?.command ?? (toolName || null),
          risk:
            payload.risk != null
              ? str(payload.risk)
              : payload.risk_level != null
                ? str(payload.risk_level)
                : existingAppr?.risk ?? null,
          expiresAt:
            payload.expires_at != null
              ? str(payload.expires_at)
              : existingAppr?.expiresAt ?? null,
          createdAt: existingAppr?.createdAt || ts,
          decidedAt: existingAppr?.decidedAt ?? null,
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
      if (!existingAppr || existingAppr.status === 'pending') {
        next = touchRun(next, runId, { status: 'waiting_approval' });
      }
      break;
    }

    case 'approval.resolved': {
      const approvalId = str(payload.approval_id || payload.id);
      if (!approvalId) break;
      // Normalize decision vocabulary (approve/deny aliases → entity statuses).
      const statusRaw = str(payload.status, 'approved').toLowerCase();
      const decision: 'approved' | 'rejected' | 'expired' =
        statusRaw === 'rejected' ||
        statusRaw === 'deny' ||
        statusRaw === 'denied' ||
        statusRaw === 'reject'
          ? 'rejected'
          : statusRaw === 'expired'
            ? 'expired'
            : 'approved';
      const existing = next.approvalsById[approvalId];
      const toolCallFromPayload = str(payload.tool_call_id) || null;
      if (!existing) {
        next = upsertApproval(
          next,
          createApproval({
            id: approvalId,
            runId,
            toolExecutionId: toolCallFromPayload,
            status: decision,
            reason: str(payload.reason),
            decidedAt: ts,
            createdAt: ts,
          }),
        );
      } else {
        next = upsertApproval(next, {
          ...existing,
          status: decision,
          reason: str(payload.reason) || existing.reason,
          decidedAt: ts,
        });
      }
      const toolId =
        toolCallFromPayload ||
        next.approvalsById[approvalId]?.toolExecutionId ||
        null;
      if (toolId && next.toolExecutionsById[toolId]) {
        const tool = next.toolExecutionsById[toolId];
        // Approve: worker will claim/replay → show running.
        // Reject/expire: backend terminalizes tool (FAILED); do not flash running.
        const toolStatus =
          decision === 'approved'
            ? 'running'
            : decision === 'expired'
              ? 'cancelled'
              : 'failed';
        next = upsertToolExecution(next, {
          ...tool,
          status: toolStatus,
          isError: decision !== 'approved',
          updatedAt: ts,
        });
      }
      // Only optimistically leave waiting_approval when an approval was granted
      // and no other approvals remain pending. Reject/expire keep the run parked
      // until durable run.status_changed (worker may re-enter RUNNING with a
      // failed tool result).
      if (decision === 'approved') {
        const stillPending = Object.values(next.approvalsById).some(
          (a) => a.runId === runId && a.status === 'pending',
        );
        if (!stillPending && next.runsById[runId]?.status === 'waiting_approval') {
          next = touchRun(next, runId, { status: 'running' });
        }
      }
      break;
    }

    case 'tool.completed':
    case 'tool.failed': {
      const toolId = str(payload.tool_call_id || payload.id || payload.tool_id);
      if (!toolId) break;
      const existing = next.toolExecutionsById[toolId];
      const name = str(payload.name || existing?.name, 'tool');
      const source = (existing?.source && existing.source !== 'unknown'
        ? existing.source
        : inferToolSource(name, payload)) as ToolSource;
      // Never promote a completed write/edit into an artifact — only
      // artifact.created / artifact.ready (submit_artifact) does that.
      next = upsertToolExecution(
        next,
        createToolExecution({
          id: toolId,
          runId,
          name,
          source,
          status: ev.type === 'tool.failed' ? 'failed' : 'completed',
          input: existing?.input ?? payload.input ?? payload.args ?? null,
          result: payload.result ?? existing?.result ?? null,
          isError: ev.type === 'tool.failed' || Boolean(payload.is_error || payload.isError),
          approvalId: existing?.approvalId ?? null,
          // process_start returns its handle on completion — this is what links
          // the tool step to its process console.
          processId: str(payload.process_id) || existing?.processId || null,
          summary:
            payload.summary != null
              ? str(payload.summary)
              : existing?.summary ?? null,
          spanId: existing?.spanId ?? (payload.span_id != null ? str(payload.span_id) : null),
          seq: existing?.seq ?? ev.sequence,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      const spanKey = existing?.spanId
        ? Object.keys(next.traceSpansById).find(
            (id) =>
              next.traceSpansById[id].runId === runId &&
              (next.traceSpansById[id].id === existing.spanId ||
                next.traceSpansById[id].metadata?.toolCallId === toolId),
          )
        : Object.keys(next.traceSpansById).find(
            (id) => next.traceSpansById[id].metadata?.toolCallId === toolId,
          );
      if (spanKey) {
        const span = next.traceSpansById[spanKey];
        next = upsertTraceSpan(next, {
          ...span,
          status: ev.type === 'tool.failed' ? 'error' : 'ok',
          finishedAt: ts,
          durationMs:
            span.startedAt && ts
              ? Math.max(0, Date.parse(ts) - Date.parse(span.startedAt))
              : span.durationMs,
          error:
            ev.type === 'tool.failed'
              ? str(payload.message || payload.error, 'tool failed')
              : null,
        });
      }
      break;
    }

    default:
      break;
  }

  return next;
}
