import type { EntityStore } from '../../entities';

/** Replayed/background runs update entities but never steal detached UI focus. */
export function canFocusStartedRun(
  store: EntityStore,
  runId: string,
  conversationId: string | null,
): boolean {
  return Boolean(conversationId &&
    store.activeRunId === runId &&
    store.activeConversationId === conversationId);
}
