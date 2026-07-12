/**
 * Bridge between legacy ChatState SSE path and F2 entity architecture.
 *
 * - Dual-writes runtime events into EntityStore via RunSSEManager
 * - Conversation switch does NOT disconnect background run managers
 * - Projects entity messages for optional UI consumption
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

export type EntityBridge = {
  manager: RunSSEManager;
  getStore: () => EntityStore;
  /**
   * Start tracking a new run (local synthetic id or server run_id).
   * Returns the runId used for subsequent legacy SSE dual-write.
   */
  beginRun: (opts?: {
    runId?: string;
    conversationId?: string | null;
    sessionId?: string | null;
  }) => string;
  /** Dual-write one legacy /chat SSE event into the entity store. */
  ingestLegacyEvent: (runId: string, ev: SSEEvent) => void;
  /**
   * Focus a conversation without cancelling background runs.
   * Unlike ChatState.switchConversation, this never aborts SSE managers.
   */
  focusConversation: (conversationId: string | null) => void;
  /** User-initiated stop: disconnect SSE for this run only. */
  stopRun: (runId: string) => void;
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
      adapter = createLegacyAdapterState({ runId });
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

  function dispose(): void {
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
    return run.messageIds
      .map((id) => s.messagesById[id])
      .filter((m): m is MessageEntity => Boolean(m))
      .map((m) => ({
        role: m.role,
        content: [{ type: 'text' as const, text: m.text }],
        ...(m.status === 'interrupted'
          ? { interrupted: true, status: 'interrupted' as const }
          : {}),
      }));
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
    focusConversation,
    stopRun,
    dispose,
    rehydrateInProgress,
    projectRunMessages,
    getLegacyAdapter: (runId) => legacyAdapters.get(runId) || null,
    markApproval,
  };
}
