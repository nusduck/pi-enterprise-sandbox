/**
 * Unified Event Reducer (plan §19.3) — applies RuntimeEvents / platform
 * envelopes to the normalized EntityStore.
 * Pure: no I/O or DOM mutation (F2 / ADR 0003 §13–15).
 *
 * Live SSE and historical replay share this path (reducePlatformEvent alias).
 */
import type {
  EntityStore,
  RunEntity,
  RunStatus,
  ToolSource,
} from '../../entities/types';
import {
  createAgentSession,
  createApproval,
  createArtifact,
  createDataset,
  createMessage,
  createProcess,
  createRun,
  createToolExecution,
  createTraceSpan,
  isTerminalRunStatus,
  setActiveConversation,
  upsertApproval,
  upsertAgentSession,
  upsertArtifact,
  upsertDataset,
  upsertMessage,
  upsertProcess,
  upsertRun,
  upsertToolExecution,
  upsertTraceSpan,
} from '../../entities/store';
import type { RuntimeEvent, ToolExecutionSnapshot } from '../schemas/events';
import { parseRuntimeEvent } from '../schemas/events';
import {
  appendCappedLog,
  capSeenEventIds,
  inferToolSource,
  isExternalRiskApproval,
  normalizeToRuntimeEvent,
} from './platformEventNormalize';

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
 * Durable submit_artifact id (server-issued). Reject adapter/path synth ids
 * so missing artifact_id never becomes a downloadable Workspace path card.
 */
export function isDurableArtifactId(
  artifactId: string | null | undefined,
  runId: string,
): boolean {
  if (artifactId == null) return false;
  const id = String(artifactId).trim();
  if (!id) return false;
  // Agent adapter synthesizes art_<runId>_<seq> when file_ready omits artifact_id
  if (runId && id.startsWith(`art_${runId}_`)) return false;
  if (id.startsWith('synth_') || id.startsWith('local_')) return false;
  return true;
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
  // Platform envelopes and legacy RuntimeEvents share one normalize path.
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
      let messageId = str(payload.message_id || payload.id);
      if (!messageId) {
        const run = next.runsById[runId];
        for (const id of [...(run?.messageIds || [])].reverse()) {
          const candidate = next.messagesById[id];
          if (candidate?.role === 'assistant' && candidate.status === 'streaming') {
            messageId = id;
            break;
          }
        }
      }
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
      } else {
        const text = str(payload.text);
        const role = str(payload.role, 'assistant') === 'user' ? 'user' : 'assistant';
        if (text || role === 'user') {
          next = upsertMessage(
            next,
            createMessage({
              id: messageId || `msg_${runId}_${ev.sequence}`,
              runId,
              conversationId: next.runsById[runId]?.conversationId || null,
              role,
              text,
              status: 'complete',
              createdAt: ts,
              updatedAt: ts,
            }),
          );
        }
      }
      break;
    }

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
              : existingAppr?.command ?? null,
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
      const existing = next.approvalsById[approvalId];
      if (!existing) {
        next = upsertApproval(
          next,
          createApproval({
            id: approvalId,
            runId,
            toolExecutionId: str(payload.tool_call_id) || null,
            status: (str(payload.status, 'approved') as 'approved' | 'rejected' | 'expired') || 'approved',
            reason: str(payload.reason),
            decidedAt: ts,
            createdAt: ts,
          }),
        );
      } else {
        const statusRaw = str(payload.status, 'approved');
        const status =
          statusRaw === 'rejected' || statusRaw === 'deny' || statusRaw === 'denied'
            ? 'rejected'
            : statusRaw === 'expired'
              ? 'expired'
              : 'approved';
        next = upsertApproval(next, {
          ...existing,
          status,
          decidedAt: ts,
        });
      }
      const toolId =
        str(payload.tool_call_id) ||
        next.approvalsById[approvalId]?.toolExecutionId ||
        null;
      if (toolId && next.toolExecutionsById[toolId]) {
        const tool = next.toolExecutionsById[toolId];
        next = upsertToolExecution(next, {
          ...tool,
          status: 'running',
          updatedAt: ts,
        });
      }
      // Resume run when no other pending approvals
      const stillPending = Object.values(next.approvalsById).some(
        (a) => a.runId === runId && a.status === 'pending',
      );
      if (!stillPending && next.runsById[runId]?.status === 'waiting_approval') {
        next = touchRun(next, runId, { status: 'running' });
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
          processId: existing?.processId ?? null,
          summary:
            payload.summary != null
              ? str(payload.summary)
              : existing?.summary ?? null,
          spanId: existing?.spanId ?? (payload.span_id != null ? str(payload.span_id) : null),
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

    case 'process.started': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      const toolCallId = str(payload.tool_call_id) || null;
      next = upsertProcess(
        next,
        createProcess({
          id: processId,
          runId,
          toolExecutionId: toolCallId,
          status: 'running',
          command: payload.command != null ? str(payload.command) : null,
          cursor: typeof payload.cursor === 'number' ? payload.cursor : 0,
          startedAt: ts,
          createdAt: ts,
        }),
      );
      if (toolCallId && next.toolExecutionsById[toolCallId]) {
        const tool = next.toolExecutionsById[toolCallId];
        next = upsertToolExecution(next, {
          ...tool,
          processId,
          updatedAt: ts,
        });
      }
      break;
    }

    case 'process.stdout':
    case 'process.stderr':
    case 'process.output': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      const proc =
        next.processesById[processId] ||
        createProcess({ id: processId, runId, status: 'running' });
      const chunk = str(payload.text || payload.chunk || payload.data);
      const stream = str(payload.stream, 'stdout').toLowerCase();
      const isStderr =
        ev.type === 'process.stderr' || stream === 'stderr' || stream === 'err';
      const out = isStderr
        ? appendCappedLog(proc.stderr, chunk)
        : appendCappedLog(proc.stdout, chunk);
      next = upsertProcess(next, {
        ...proc,
        runId,
        stdout: isStderr ? proc.stdout : out.text,
        stderr: isStderr ? out.text : proc.stderr,
        logTruncated: proc.logTruncated || out.truncated,
        cursor:
          typeof payload.cursor === 'number'
            ? payload.cursor
            : proc.cursor != null
              ? proc.cursor + chunk.length
              : chunk.length,
        status: 'running',
        updatedAt: ts,
      });
      break;
    }

    case 'process.completed':
    case 'process.failed':
    case 'process.cancelled': {
      const processId = str(payload.process_id || payload.id);
      if (!processId) break;
      const proc =
        next.processesById[processId] ||
        createProcess({ id: processId, runId });
      const status =
        ev.type === 'process.cancelled'
          ? 'cancelled'
          : ev.type === 'process.failed'
            ? 'failed'
            : 'completed';
      next = upsertProcess(next, {
        ...proc,
        runId,
        status,
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
      // Only durable server artifact_id from submit_artifact / artifact.ready.
      // Missing id → still advance event cursor below, but never create a
      // downloadable Artifact (no workspace path fallback).
      const artifactId = str(payload.artifact_id || payload.id);
      if (!isDurableArtifactId(artifactId, runId)) {
        break;
      }
      const existing = next.artifactsById[artifactId];
      next = upsertArtifact(
        next,
        createArtifact({
          id: artifactId,
          runId,
          sessionId:
            str(ev.session_id) ||
            str(payload.session_id) ||
            next.runsById[runId]?.sandboxSessionId ||
            existing?.sessionId ||
            null,
          name: str(payload.name, existing?.name || artifactId),
          path:
            payload.path != null
              ? str(payload.path)
              : existing?.path ?? null,
          mimeType:
            payload.mime_type != null
              ? str(payload.mime_type)
              : payload.mimeType != null
                ? str(payload.mimeType)
                : existing?.mimeType ?? null,
          size:
            typeof payload.size === 'number'
              ? payload.size
              : existing?.size ?? null,
          sha256:
            payload.sha256 != null
              ? str(payload.sha256)
              : existing?.sha256 ?? null,
          description:
            payload.description != null
              ? str(payload.description)
              : existing?.description ?? null,
          source: 'submit_artifact',
          createdAt: existing?.createdAt || ts,
        }),
      );
      next = upsertTraceSpan(
        next,
        createTraceSpan({
          id: `artspan_${artifactId}`,
          runId,
          parentId: null,
          kind: 'artifact',
          name: str(payload.name, artifactId),
          status: 'ok',
          startedAt: ts,
          finishedAt: ts,
          metadata: { artifactId },
        }),
      );
      break;
    }

    case 'dataset.upload.started':
    case 'dataset.upload.progress':
    case 'dataset.ready':
    case 'dataset.failed': {
      const datasetId = str(
        payload.dataset_id || payload.id,
        `ds_${runId}_${ev.sequence}`,
      );
      const existing = next.datasetsById[datasetId];
      const status =
        ev.type === 'dataset.ready'
          ? 'ready'
          : ev.type === 'dataset.failed'
            ? 'failed'
            : 'uploading';
      const progress =
        typeof payload.progress === 'number'
          ? Math.max(0, Math.min(100, payload.progress))
          : typeof payload.percent === 'number'
            ? Math.max(0, Math.min(100, payload.percent))
            : status === 'ready'
              ? 100
              : existing?.progress ?? null;
      next = upsertDataset(
        next,
        createDataset({
          id: datasetId,
          conversationId:
            str(payload.conversation_id) ||
            next.runsById[runId]?.conversationId ||
            existing?.conversationId ||
            null,
          sessionId:
            str(ev.session_id) ||
            str(payload.session_id) ||
            next.runsById[runId]?.sandboxSessionId ||
            existing?.sessionId ||
            null,
          runId,
          name: str(
            payload.name || payload.original_filename || existing?.name,
            datasetId,
          ),
          path:
            payload.path != null
              ? str(payload.path)
              : payload.stored_relative_path != null
                ? str(payload.stored_relative_path)
                : existing?.path ?? null,
          size:
            typeof payload.size === 'number'
              ? payload.size
              : typeof payload.size_bytes === 'number'
                ? payload.size_bytes
                : existing?.size ?? null,
          mimeType:
            payload.mime_type != null
              ? str(payload.mime_type)
              : existing?.mimeType ?? null,
          sha256:
            payload.sha256 != null ? str(payload.sha256) : existing?.sha256 ?? null,
          status,
          progress,
          agentVisible:
            payload.agent_visible === false
              ? false
              : existing?.agentVisible ?? true,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      break;
    }

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

    case 'run.context_updated': {
      const prior = next.runsById[runId]?.contextUsage;
      next = touchRun(next, runId, {
        contextUsage: {
          tokens: typeof payload.tokens === 'number' ? payload.tokens : prior?.tokens ?? null,
          contextWindow: typeof payload.context_window === 'number'
            ? payload.context_window
            : prior?.contextWindow ?? null,
          percent: typeof payload.percent === 'number' ? payload.percent : prior?.percent ?? null,
          warning: typeof payload.warning === 'boolean'
            ? payload.warning
            : prior?.warning === true,
        },
      });
      break;
    }

    case 'run.task_plan_updated': {
      const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
      next = touchRun(next, runId, {
        taskPlan: tasks.map((item) => {
          const task = item && typeof item === 'object' ? item as Record<string, unknown> : {};
          return {
            taskId: str(task.task_id),
            content: str(task.content),
            status: str(task.status, 'pending'),
            evidence: task.evidence != null ? str(task.evidence) : null,
          };
        }),
      });
      break;
    }

    case 'run.compaction_updated': {
      const status = str(payload.status, 'idle') as RunEntity['compactionStatus'];
      next = touchRun(next, runId, {
        compactionStatus: status,
        compactionError: payload.error != null ? str(payload.error) : null,
      });
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
 * Plan §19.3 public name — live and historical events share this reducer.
 */
export function reducePlatformEvent(
  store: EntityStore,
  raw: unknown,
  opts: { seenEventIds?: Set<string>; applyOutOfOrder?: boolean } = {},
): ReduceResult {
  return reduceRuntimeEvent(store, raw, opts);
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

export const reducePlatformEventBatch = reduceRuntimeEventBatch;

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
    budget?: unknown;
    budget_limits?: unknown;
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

  const budgetUsage =
    detail.budget && typeof detail.budget === 'object'
      ? (detail.budget as RunEntity['budgetUsage'])
      : null;
  const budgetLimits =
    detail.budget_limits && typeof detail.budget_limits === 'object'
      ? (detail.budget_limits as RunEntity['budgetLimits'])
      : null;

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
      lastSequence: detail.last_sequence ?? existing?.lastSequence ?? 0,
      lastEventId: detail.last_event_id ?? existing?.lastEventId ?? null,
      error: detail.error ?? existing?.error ?? null,
      budgetUsage: budgetUsage ?? existing?.budgetUsage ?? null,
      budgetLimits: budgetLimits ?? existing?.budgetLimits ?? null,
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
        createdAt: snapshot.created_at || existing?.createdAt || null,
        updatedAt: snapshot.updated_at || snapshot.finished_at || existing?.updatedAt || null,
      }),
    );
  }
  return next;
}
