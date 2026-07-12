/**
 * Bridge from the legacy /chat transport into the normalized entity runtime.
 *
 * - Reduces runtime events exactly once via RunSSEManager
 * - Conversation switch does NOT disconnect background run managers
 * - Owns per-run legacy fetch controllers and entity projections
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
  createLegacyAdapterState,
  legacyEventToRuntime,
  type LegacyAdapterState,
} from '../../shared/sse/legacyAdapter';
import type { SSEEvent } from '../../shared/sse/parser';
import { rehydrateRun } from '../../shared/state/runReducer';
import {
  getRun,
  listRuns,
  syntheticRunId,
  type RunDetail,
} from '../../shared/api/runs';
import type { ChatMessage } from '../../shared/state/types';
import type { ContentPart, ToolUsePart } from '../../shared/state/types';
import { getArtifactDownloadUrl, getDownloadUrl } from '../../shared/api/client';
import { makeRuntimeEvent } from '../../shared/schemas/events';

export type EntityBridge = {
  manager: RunSSEManager;
  getStore: () => EntityStore;
  /**
   * Start tracking a new run (local synthetic id or server run_id).
   * Returns the runId used for subsequent legacy SSE reduction.
   */
  beginRun: (opts?: {
    runId?: string;
    conversationId?: string | null;
    sessionId?: string | null;
  }) => string;
  /** Reduce one legacy /chat SSE event into the entity store. */
  ingestLegacyEvent: (runId: string, ev: SSEEvent) => void;
  /** Register/release the legacy fetch transport owned by a run. */
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
  /** Rehydrate in-progress runs after refresh (API may stub empty). */
  rehydrateInProgress: (conversationId?: string | null) => Promise<RunEntity[]>;
  /** Project run assistant messages to ChatMessage[] for UI. */
  projectRunMessages: (runId: string) => ChatMessage[];
  /** Adapter state for a run (tests). */
  getLegacyAdapter: (runId: string) => LegacyAdapterState | null;
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
  const legacyAdapters = new Map<string, LegacyAdapterState>();
  const transports = new Map<string, AbortController>();

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
    const runId = opts.runId || syntheticRunId();
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
    legacyAdapters.set(
      runId,
      createLegacyAdapterState({
        runId,
        conversationId: opts.conversationId || null,
        sessionId: opts.sessionId || null,
      }),
    );
    onStoreChange?.(store);
    return runId;
  }

  function ingestLegacyEvent(runId: string, ev: SSEEvent): void {
    let adapter = legacyAdapters.get(runId);
    if (!adapter) {
      adapter = createLegacyAdapterState({
        runId,
        sequence: manager.getStore().runsById[runId]?.lastSequence || 0,
      });
      legacyAdapters.set(runId, adapter);
    }
    const runtimeEvents = legacyEventToRuntime(adapter, ev);
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
    let adapter = legacyAdapters.get(runId);
    if (!adapter) {
      adapter = createLegacyAdapterState({
        runId,
        sequence: manager.getStore().runsById[runId]?.lastSequence || 0,
      });
      legacyAdapters.set(runId, adapter);
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
      messages.push({ role: 'assistant', content: [] });
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
    ingestLegacyEvent,
    attachTransport,
    releaseTransport,
    abortRun,
    focusConversation,
    stopRun,
    interruptRun,
    failRun,
    dispose,
    rehydrateInProgress,
    projectRunMessages,
    getLegacyAdapter: (runId) => legacyAdapters.get(runId) || null,
    markApproval,
  };
}
