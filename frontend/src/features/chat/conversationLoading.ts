import type { ChatMessage, ChatState } from '../../shared/state/types';
import { update } from '../../shared/state/chatState';

/** Keep the raw transcript hidden until its Run timeline is ready to render. */
export function beginConversationRestore(state: ChatState, id: string): ChatState {
  return update(state, {
    restoringConversationId: id,
    messages: state.conversationId === id ? state.messages : [],
  });
}

export function finishConversationRestore(state: ChatState, id: string): ChatState {
  return state.restoringConversationId === id
    ? update(state, { restoringConversationId: null })
    : state;
}

/** A failed fetch leaves no selected target, allowing the sidebar to retry. */
export function failConversationRestore(state: ChatState, id: string): ChatState {
  if (state.restoringConversationId !== id) return state;
  return update(state, {
    restoringConversationId: null,
    conversationId: null,
    sessionId: null,
    messages: [],
    artifacts: [],
    attachments: [],
    traceId: null,
  });
}

export function conversationDisplay(state: ChatState, messages: ChatMessage[]) {
  const loading = state.restoringConversationId !== null;
  return { loading, messages: loading ? [] : messages };
}
