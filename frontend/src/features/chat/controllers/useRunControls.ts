import { useCallback, type RefObject } from 'react';
import {
  cancelRun,
  followUpRun as requestFollowUp,
  respondInteraction as requestInteractionResponse,
  resumeApproval,
  steerRun as requestSteer,
} from '../../../shared/api';
import type { ChatState } from '../../../shared/state';
import type { EntityBridge } from '../entityBridge';

type Options = {
  bridge: EntityBridge;
  stateRef: RefObject<ChatState>;
  setDraftText: (value: string) => void;
  setStatus: (text: string, color?: string) => void;
  flashError: (message: string) => void;
};

/** User-initiated Run controls, isolated from conversation/upload orchestration. */
export function useRunControls({
  bridge,
  stateRef,
  setDraftText,
  setStatus,
  flashError,
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
    try {
      await requestSteer(runId, {
        text: trimmed,
        conversation_id: stateRef.current.conversationId,
      });
      setDraftText('');
      setStatus('Steered', '#3b82f6');
      return true;
    } catch (error) {
      flashError((error as Error).message || 'Steer failed');
      return false;
    }
  }, [bridge, flashError, setDraftText, setStatus, stateRef]);

  const followUpRun = useCallback(async (text: string): Promise<boolean> => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const runId = bridge.getStore().activeRunId;
    if (!runId) {
      flashError('No active run for follow-up');
      return false;
    }
    try {
      await requestFollowUp(runId, {
        text: trimmed,
        conversation_id: stateRef.current.conversationId,
      });
      setDraftText('');
      setStatus('Follow-up queued', '#8b5cf6');
      return true;
    } catch (error) {
      flashError((error as Error).message || 'Follow-up failed');
      return false;
    }
  }, [bridge, flashError, setDraftText, setStatus, stateRef]);

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
