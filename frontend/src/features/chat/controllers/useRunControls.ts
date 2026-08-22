import { useCallback, type RefObject } from 'react';
import {
  cancelRun,
  getRun,
  followUpRun as requestFollowUp,
  respondInteraction as requestInteractionResponse,
  resumeApproval,
  steerRun as requestSteer,
  type CreateRunResponse,
} from '../../../shared/api';
import { isTerminalRunStatus } from '../../../entities';
import type { ChatMessage, ChatState } from '../../../shared/state';
import type { EntityBridge } from '../entityBridge';

type Options = {
  bridge: EntityBridge;
  stateRef: RefObject<ChatState>;
  setDraftText: (value: string) => void;
  setStatus: (text: string, color?: string) => void;
  flashError: (message: string) => void;
  /**
   * Immediately surface a user turn in the chat transcript (optimistic).
   * Steer / follow-up previously only hit the network, so the bubble only
   * appeared after a full conversation rehydrate.
   */
  appendUserMessage: (message: ChatMessage) => void;
  /** Remove a failed optimistic bubble by `_messageId`. */
  removeUserMessage: (messageId: string) => void;
  /** Patch fields on an optimistic bubble (e.g. stamp durable ids). */
  patchUserMessage: (
    messageId: string,
    patch: Partial<ChatMessage>,
  ) => void;
};

type FollowUpRequest = (
  conversationId: string,
  body: { text: string },
) => Promise<CreateRunResponse>;

function newLocalMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `local_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

function buildOptimisticUserMessage(
  text: string,
  opts: { runId?: string | null; messageId?: string } = {},
): ChatMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    _messageId: opts.messageId || newLocalMessageId(),
    ...(opts.runId ? { _runId: opts.runId } : {}),
    createdAt: new Date().toISOString(),
  };
}

// A sandbox tool may finish its current process before the Agent terminalizes
// the Run. Keep this asynchronous poll independent from the UI stream for up
// to a minute, while using the cheap Run detail endpoint between final reads.
const CANCEL_RECONCILE_ATTEMPTS = 120;
const CANCEL_RECONCILE_DELAY_MS = 500;

function waitForCancelRetry(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, CANCEL_RECONCILE_DELAY_MS);
  });
}

/**
 * Reconcile a user-cancelled run until the Agent publishes a terminal state.
 * Kept separate from the React hook so the asynchronous cancellation contract
 * is testable without mounting the whole workbench.
 */
export async function reconcileCancelledRun(input: {
  bridge: Pick<EntityBridge, 'reconcileRun'>;
  runId: string;
  maxAttempts?: number;
  wait?: () => Promise<void>;
  readStatus?: () => Promise<unknown>;
}): Promise<Awaited<ReturnType<EntityBridge['reconcileRun']>>> {
  const maxAttempts = input.maxAttempts ?? CANCEL_RECONCILE_ATTEMPTS;
  const wait = input.wait || waitForCancelRetry;
  let latest: Awaited<ReturnType<EntityBridge['reconcileRun']>> = null;
  let latestStatus: unknown = null;
  const readStatus = input.readStatus || (async () => {
    latest = await input.bridge.reconcileRun(input.runId);
    return latest?.status;
  });

  for (
    let attempt = 0;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    try {
      latestStatus = await readStatus();
    } catch {
      // A transient status read should not strand the local UI in Running.
      latestStatus = null;
    }
    const normalizedStatus = String(latestStatus ?? '').trim().toLowerCase();
    if (
      isTerminalRunStatus(
        normalizedStatus === 'canceled' ? 'cancelled' : normalizedStatus,
      )
    ) {
      return input.readStatus
        ? input.bridge.reconcileRun(input.runId)
        : latest;
    }
    if (attempt === maxAttempts) break;
    await wait();
  }

  // One final authoritative entity read lets the caller render the latest
  // non-terminal state even if the bounded poll exhausted while the Agent was
  // still draining a long-running tool.
  return input.bridge.reconcileRun(input.runId);
}

/** Register the follow-up as its own Run and tail its durable event stream. */
export async function queueConversationFollowUp(input: {
  bridge: EntityBridge;
  conversationId: string;
  text: string;
  sessionId?: string | null;
  request?: FollowUpRequest;
  /** Local optimistic message id so callers can stamp `_runId` after create. */
  localMessageId?: string;
}): Promise<{ runId: string; localMessageId?: string }> {
  const store = input.bridge.getStore();
  const currentRun = store.activeRunId
    ? store.runsById[store.activeRunId]
    : null;
  const created = await (input.request || requestFollowUp)(
    input.conversationId,
    { text: input.text },
  );
  const runId = input.bridge.beginRun({
    runId: created.run_id,
    conversationId: created.conversation_id || input.conversationId,
    agentSessionId:
      created.agent_session_id || currentRun?.agentSessionId || null,
    sessionId:
      created.session_id ||
      currentRun?.sandboxSessionId ||
      input.sessionId ||
      null,
  });
  input.bridge.manager.connect(runId);
  return { runId, localMessageId: input.localMessageId };
}

/** User-initiated Run controls, isolated from conversation/upload orchestration. */
export function useRunControls({
  bridge,
  stateRef,
  setDraftText,
  setStatus,
  flashError,
  appendUserMessage,
  removeUserMessage,
  patchUserMessage,
}: Options) {
  const cancelStream = useCallback(() => {
    const runId = bridge.getStore().activeRunId;
    if (runId) bridge.abortRun(runId);
  }, [bridge]);

  const stopRun = useCallback(() => {
    const runId = bridge.getStore().activeRunId;
    if (!runId) return;

    setStatus('Stopping…', '#f59e0b');
    cancelStream();
    void (async () => {
      try {
        const { cancelledDescendants } = await cancelRun(runId);
        // A fan-out stops as a tree; say so rather than reporting only the
        // parent, which would read as "the sub-agents are still going".
        const alsoStopped = cancelledDescendants.length
          ? ` · ${cancelledDescendants.length} sub-agent${cancelledDescendants.length > 1 ? 's' : ''}`
          : '';

        // Cancelling is asynchronous on the Agent. The user stop also closes
        // SSE, so no terminal event is guaranteed to reach this tab. Re-read
        // the durable Run until it is terminal and let EntityBridge publish
        // that authoritative state to every run consumer.
        const latest = await reconcileCancelledRun({
          bridge,
          runId,
          readStatus: async () => (await getRun(runId)).status,
        });

        if (latest?.status === 'cancelled') {
          setStatus(`Cancelled${alsoStopped}`, '#64748b');
        } else if (latest && isTerminalRunStatus(latest.status)) {
          setStatus(`Run ${latest.status}`, '#64748b');
        }
      } catch (error) {
        flashError((error as Error).message || 'Failed to cancel run');
        // The cancel request may have succeeded before its response was lost.
        // One best-effort read avoids leaving a stale Running badge when that
        // is the only failure.
        try {
          await bridge.reconcileRun(runId);
        } catch {
          /* The next page refresh can still recover the durable state. */
        }
      }
    })();
  }, [bridge, cancelStream, flashError, setStatus]);

  const steerRun = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const runId = bridge.getStore().activeRunId;
    if (!runId) {
      flashError('No active run to steer');
      return false;
    }
    const optimistic = buildOptimisticUserMessage(trimmed, { runId });
    const localId = String(optimistic._messageId);
    appendUserMessage(optimistic);
    setDraftText('');
    try {
      const result = await requestSteer(runId, {
        text: trimmed,
        conversation_id: stateRef.current.conversationId,
      });
      const data =
        result?.data && typeof result.data === 'object'
          ? (result.data as Record<string, unknown>)
          : null;
      const durableId = data
        ? String(data.messageId || data.message_id || '').trim()
        : '';
      if (durableId) {
        patchUserMessage(localId, { _messageId: durableId, _runId: runId });
      }
      setStatus('Steered', '#3b82f6');
      return true;
    } catch (error) {
      removeUserMessage(localId);
      flashError((error as Error).message || 'Steer failed');
      return false;
    }
  }, [
    appendUserMessage,
    bridge,
    flashError,
    patchUserMessage,
    removeUserMessage,
    setDraftText,
    setStatus,
    stateRef,
  ]);

  const followUpRun = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const store = bridge.getStore();
    const activeRun = store.activeRunId
      ? store.runsById[store.activeRunId]
      : null;
    const conversationId =
      stateRef.current.conversationId || activeRun?.conversationId;
    if (!conversationId) {
      flashError('No active conversation for follow-up');
      return false;
    }
    const optimistic = buildOptimisticUserMessage(trimmed);
    const localId = String(optimistic._messageId);
    appendUserMessage(optimistic);
    setDraftText('');
    try {
      const { runId } = await queueConversationFollowUp({
        bridge,
        conversationId,
        text: trimmed,
        sessionId: stateRef.current.sessionId,
        localMessageId: localId,
      });
      patchUserMessage(localId, { _runId: runId });
      setStatus('Follow-up queued', '#8b5cf6');
      return true;
    } catch (error) {
      removeUserMessage(localId);
      flashError((error as Error).message || 'Follow-up failed');
      return false;
    }
  }, [
    appendUserMessage,
    bridge,
    flashError,
    patchUserMessage,
    removeUserMessage,
    setDraftText,
    setStatus,
    stateRef,
  ]);

  const resumeInterrupted = useCallback(async () => {
    const store = bridge.getStore();
    const runId = store.activeRunId;
    const run = runId ? store.runsById[runId] : null;

    if (run?.status === 'waiting_approval' && runId) {
      try {
        await resumeApproval(runId, {});
        setStatus('Resuming approval…', '#fbbf24');
        return;
      } catch (error) {
        flashError((error as Error).message || 'Resume failed');
        return;
      }
    }

    const conversationId = stateRef.current.conversationId;
    if (conversationId) {
      try {
        await bridge.rehydrateInProgress(conversationId);
      } catch {
        // The next explicit user action will surface a recovery failure.
      }
    }

    setStatus('Ready to continue — type a message', '#22c55e');
    window.setTimeout(() => {
      const element = document.getElementById('input') as HTMLTextAreaElement | null;
      element?.focus();
    }, 0);
  }, [bridge, flashError, setStatus, stateRef]);

  const respondInteraction = useCallback(async (response: unknown): Promise<boolean> => {
    const store = bridge.getStore();
    const runId = store.activeRunId;
    const pending = runId ? store.runsById[runId]?.pendingInput : null;
    if (!runId || !pending?.interactionId) {
      flashError('No pending interaction');
      return false;
    }
    try {
      await requestInteractionResponse(runId, pending.interactionId, response);
      setStatus('Input submitted', '#3b82f6');
      return true;
    } catch (error) {
      flashError((error as Error).message || 'Input response failed');
      return false;
    }
  }, [bridge, flashError, setStatus]);

  return {
    cancelStream,
    stopRun,
    steerRun,
    followUpRun,
    resumeInterrupted,
    respondInteraction,
  };
}
