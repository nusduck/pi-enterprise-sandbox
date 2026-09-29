import { conversationTitleFromUserText, update, type ChatState } from '../../shared/state';

/** Bind an accepted run to the visible chat without losing the first-turn title. */
export function bindCreatedRunIdentity(
  state: ChatState,
  prior: ChatState,
  conversationId: string | null,
  sessionId: string | null,
  userText: string,
): ChatState {
  const existingConversation = (state.conversations || []).find(
    (conversation) => conversation.id === conversationId,
  );
  const hasPriorUserMessage = prior.messages.some((message) => message.role === 'user');
  const existingTitle = String(existingConversation?.title || '').trim().toLowerCase();
  const hasPlaceholderTitle = !existingTitle ||
    existingTitle === 'new chat' || existingTitle === 'new conversation';
  const shouldSetInitialTitle = Boolean(conversationId) &&
    (!prior.conversationId || (!hasPriorUserMessage && hasPlaceholderTitle));
  const now = new Date().toISOString();
  const conversations = shouldSetInitialTitle
    ? [
        {
          ...existingConversation,
          id: conversationId as string,
          title: conversationTitleFromUserText(userText),
          created_at: existingConversation?.created_at || now,
          updated_at: now,
        },
        ...(state.conversations || []).filter((conversation) => conversation.id !== conversationId),
      ]
    : state.conversations;
  return update(state, {
    ...(conversationId ? { conversationId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(shouldSetInitialTitle ? { conversations } : {}),
  });
}
