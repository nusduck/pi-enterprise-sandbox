import type { EntityStore } from '../../../entities';
import type { ChatMessage } from '../../../shared/state/types';

export function messageText(message: ChatMessage): string {
  return message.content
    .filter((part) => part.type === 'text' && 'text' in part)
    .map((part) => String((part as { text?: unknown }).text || ''))
    .join('');
}

function hasRuntimeDetail(message: ChatMessage): boolean {
  return (
    message.content.some((part) => part.type === 'tool_use') ||
    Boolean(message._fileLinks?.length) ||
    Boolean(message.interrupted)
  );
}

/** Merge server transcript rows with normalized per-Run runtime projections. */
export function projectConversationMessages(options: {
  serverMessages: ChatMessage[];
  conversationId: string | null;
  store: EntityStore;
  activeRunId: string | null;
  projectRunMessages: (runId: string) => ChatMessage[];
}): ChatMessage[] {
  const { serverMessages, conversationId, store, activeRunId, projectRunMessages } = options;
  const result = [...serverMessages];
  const runs = Object.values(store.runsById)
    .filter((run) => {
      if (!run) return false;
      if (!conversationId) return false;
      return run.conversationId === conversationId || run.id === activeRunId;
    })
    .sort((a, b) => {
      const ta = a.startedAt || a.createdAt || a.id;
      const tb = b.startedAt || b.createdAt || b.id;
      return String(ta).localeCompare(String(tb));
    });

  const assistantSlots = result.flatMap((message, index) =>
    message.role === 'assistant' ? [index] : [],
  );

  runs.forEach((run, runIndex) => {
    const projected = projectRunMessages(run.id).find(
      (message) => message.role === 'assistant',
    );
    if (!projected) return;
    const text = messageText(projected);
    if (!text && !hasRuntimeDetail(projected)) return;

    const stableSlot = result.findIndex(
      (message) => message.role === 'assistant' && message._runId === run.id,
    );
    const slot = stableSlot >= 0 ? stableSlot : assistantSlots[runIndex];
    if (slot == null) {
      result.push(projected);
      assistantSlots.push(result.length - 1);
      return;
    }

    const serverMessage = result[slot];
    if (hasRuntimeDetail(projected)) {
      // Persisted runtime events may omit text after retention or compaction.
      // Preserve the durable transcript text while adding tools/artifacts.
      if (!text && messageText(serverMessage)) {
        result[slot] = {
          ...projected,
          content: [
            ...serverMessage.content.filter((part) => part.type === 'text'),
            ...projected.content,
          ],
        };
      } else {
        result[slot] = projected;
      }
    }
  });

  return result;
}
