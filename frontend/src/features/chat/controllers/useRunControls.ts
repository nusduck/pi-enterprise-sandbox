import { useCallback, type RefObject } from 'react';
import {
  cancelRun,
  followUpRun as requestFollowUp,
  respondInteraction as requestInteractionResponse,
  resumeApproval,
  steerRun as requestSteer,
  type CreateRunResponse,
} from '../../../shared/api';
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
    cancelStream();
    if (runId) {
      void cancelRun(runId).catch((error) => {
        flashError((error as Error).message || 'Failed to cancel run');
      });
    }
    setStatus('Stopping…', '#f59e0b');
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
