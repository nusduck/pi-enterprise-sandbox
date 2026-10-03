/**
 * User message mutations for local optimistic updates and run controls.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { update, type ChatMessage, type ChatState } from '../../shared/state';

export interface UserMessageMutationsDeps {
  stateRef: MutableRefObject<ChatState>;
  setState: Dispatch<SetStateAction<ChatState>>;
}

export interface UserMessageMutations {
  appendUserMessage: (message: ChatMessage) => void;
  removeUserMessage: (messageId: string) => void;
  patchUserMessage: (messageId: string, patch: Partial<ChatMessage>) => void;
}

export function useUserMessageMutations({
  stateRef,
  setState,
}: UserMessageMutationsDeps): UserMessageMutations {
  const appendUserMessage = useCallback((message: ChatMessage) => {
    setState((s) => {
      const next = update(s, { messages: [...s.messages, message] });
      stateRef.current = next;
      return next;
    });
  }, [setState, stateRef]);

  const removeUserMessage = useCallback((messageId: string) => {
    const id = String(messageId || '').trim();
    if (!id) return;
    setState((s) => {
      const next = update(s, {
        messages: s.messages.filter((m) => m._messageId !== id),
      });
      stateRef.current = next;
      return next;
    });
  }, [setState, stateRef]);

  const patchUserMessage = useCallback(
    (messageId: string, patch: Partial<ChatMessage>) => {
      const id = String(messageId || '').trim();
      if (!id) return;
      setState((s) => {
        const messages = s.messages.map((m) =>
          m._messageId === id ? { ...m, ...patch } : m,
        );
        const next = update(s, { messages });
        stateRef.current = next;
        return next;
      });
    },
    [setState, stateRef],
  );

  return {
    appendUserMessage,
    removeUserMessage,
    patchUserMessage,
  };
}
