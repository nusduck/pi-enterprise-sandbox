/**
 * Bridge from Agent run events into the normalized entity runtime.
 *
 * - Reduces runtime events exactly once via RunSSEManager
 * - Conversation switch does NOT disconnect background run managers
 * - Owns per-run fetch controllers and durable-history projections
 */
import {
  createEntityStore,
  createRun,
  setActiveConversation,
  upsertApproval,
  upsertRun,
  type ApprovalStatus,
  type EntityStore,
  type MessageEntity,
  type RunEntity,
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
import { rehydrateRun } from '../../shared/state/runReducer';
import {
  getRun,
  listRuns,
  type RunDetail,
} from '../../shared/api/runs';
import { getConversationEvents } from '../../shared/api/client';
import type { PersistedAgentEvent } from '../../shared/schemas/events';
import type { ChatMessage } from '../../shared/state/types';
import type { ContentPart, ToolUsePart } from '../../shared/state/types';
import { getArtifactDownloadUrl, getDownloadUrl } from '../../shared/api/client';
import { makeRuntimeEvent } from '../../shared/schemas/events';

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
};

/**
 * Create the F2 entity bridge. Safe to construct once per ChatProvider.
 */
export function createEntityBridge(
  onStoreChange?: (store: EntityStore) => void,
): EntityBridge {
  let store = createEntityStore();
  const eventAdapters = new Map<string, AgentEventAdapterState>();
  const transports = new Map<string, AbortController>();

  function localRunId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid ? `local_${uuid}` : `local_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  const manager = createRunSSEManager(store, {
    onStoreChange: (s) => {
      store = s;
      onStoreChange?.(s);
    },
  });

  function beginRun(
    opts: {
      runId?: string;
      conversationId?: string | null;
      sessionId?: string | null;
    } = {},
  ): string {
    const runId = opts.runId || localRunId();
    store = upsertRun(
      store,
      createRun({
        id: runId,
        conversationId: opts.conversationId || null,
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

  function dispose(): void {
    for (const controller of transports.values()) controller.abort();
    transports.clear();
    manager.disconnectAll();
  }

  async function rehydrateInProgress(
    conversationId?: string | null,
  ): Promise<RunEntity[]> {
    const details = await listRuns({
      conversation_id: conversationId || undefined,
      status: 'running',
    });
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
      const status = String(detail.status || '');
      const activelyStreaming = status === 'pending' || status === 'queued' || status === 'running';
      const resumable = status === 'waiting_approval' || status === 'waiting_input';

      if (!activelyStreaming) {
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
      }

      if (activelyStreaming || resumable) {
        const live = await getRun(runId);
        if (live) {
          store = rehydrateRun(manager.getStore(), live);
          manager.setStore(store);
        }
        const liveCursor = resumable && live?.next_sequence
          ? Math.max(0, live.next_sequence - 1)
          : 0;
        manager.connect(runId, { lastSequence: liveCursor });
      }

      const run = manager.getStore().runsById[runId];
      if (run) restored.push(run);
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
        ...(m.status === 'interrupted'
          ? { interrupted: true, status: 'interrupted' as const }
          : {}),
      }));
    const content: ContentPart[] = [];
    let assistant: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') {
        assistant = messages[i];
        break;
      }
    }
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
        isError: tool.isError,
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

    const fileLinks = run.artifactIds.flatMap((artifactId) => {
      const artifact = s.artifactsById[artifactId];
      if (!artifact) return [];
      const sessionId = artifact.sessionId || run.sandboxSessionId;
      const isServerArtifact = !artifact.id.startsWith(`art_${runId}_`);
      const url = sessionId
        ? isServerArtifact
          ? getArtifactDownloadUrl(sessionId, artifact.id)
          : artifact.path
            ? getDownloadUrl(sessionId, artifact.path)
            : null
        : null;
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
      if (run.status === 'interrupted' || run.status === 'cancelled') {
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
    dispose,
    rehydrateInProgress,
    rehydrateConversation,
    projectRunMessages,
    getAgentEventAdapter: (runId) => eventAdapters.get(runId) || null,
    markApproval,
  };
}
