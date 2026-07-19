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

/**
 * Merge server transcript rows with live per-Run projections.
 *
 * Critical UX: pure text streaming (token deltas) must replace the assistant
 * slot on every update. Previously we only wrote when tools/artifacts were
 * present, so the UI stayed blank until the first tool_end / run completion.
 */
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
    const projectedAll = projectRunMessages(run.id);
    // User turns from event rehydrate must appear even when GET conversation
    // returned messages: [] (legacy presentConversation).
    for (const userMsg of projectedAll.filter((m) => m.role === 'user')) {
      const utext = messageText(userMsg);
      if (!utext.trim()) continue;
      const already = result.some(
        (m) =>
          m.role === 'user' &&
          (m._runId === run.id ||
            (m._messageId != null &&
              userMsg._messageId != null &&
              m._messageId === userMsg._messageId) ||
            messageText(m) === utext),
      );
      if (!already) {
        // Insert before this run's assistant slot when possible; else append.
        const asstIdx = result.findIndex(
          (m) => m.role === 'assistant' && m._runId === run.id,
        );
        if (asstIdx >= 0) result.splice(asstIdx, 0, userMsg);
        else result.push(userMsg);
      }
    }

    const projected = projectedAll.find((message) => message.role === 'assistant');
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
    // Always apply live projection when it has text and/or runtime detail.
    // Token-only streaming has no tool_use yet; skipping it froze the bubble.
    if (hasRuntimeDetail(projected) && !text && messageText(serverMessage)) {
      // Persisted runtime may omit text after retention/compaction — keep
      // durable transcript text while attaching tools/artifacts.
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
  });

  return result;
}
