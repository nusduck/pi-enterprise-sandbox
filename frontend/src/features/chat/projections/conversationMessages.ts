import type { EntityStore } from '../../../entities';
import type { ChatMessage } from '../../../shared/state/types';

export function messageText(message: ChatMessage): string {
  return message.content
    .filter((part) => part.type === 'text' && 'text' in part)
    .map((part) => String((part as { text?: unknown }).text || ''))
    .join('');
}

/** The turn did more than emit text: runtime steps, deliverables or an abort. */
function hasRuntimeDetail(message: ChatMessage): boolean {
  return (
    Boolean(message._hasRuntimeSteps) ||
    message.content.some((part) => part.type === 'tool_use') ||
    Boolean(message.thinking) ||
    Boolean(message._fileLinks?.length) ||
    Boolean(message.interrupted)
  );
}

function looksLikeToolEnvelopeText(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  return (
    t.includes('"exitCode"') ||
    t.includes('"stdout"') ||
    t.includes('"stdoutTruncated"')
  );
}

const LEGACY_HISTORY_BUCKET = Number.MAX_SAFE_INTEGER;

/**
 * Stable chat order key. Persisted rows use their database sequence only;
 * unsequenced legacy and live rows retain the order in which the merge put
 * them. In particular, no role is ever used as a cross-message sort key.
 */
function messageOrderKey(
  message: ChatMessage,
  originalIndex: number,
): [number, number, string] {
  const sequence = Number(message.sequenceNo);
  if (Number.isFinite(sequence)) {
    return [sequence, 0, String(message._messageId || '')];
  }

  const runId = message._runId != null ? String(message._runId) : '';
  if (!runId) {
    // Legacy history has no durable run or sequence linkage. Preserve the API
    // array order instead of reconstructing turns from user/assistant roles.
    return [LEGACY_HISTORY_BUCKET, originalIndex, ''];
  }
  return [LEGACY_HISTORY_BUCKET, originalIndex, String(message._messageId || '')];
}

function sortServerMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const ka = messageOrderKey(a.message, a.index);
      const kb = messageOrderKey(b.message, b.index);
      for (let i = 0; i < ka.length; i += 1) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return a.index - b.index;
    })
    .map(({ message }) => message);
}

/**
 * The conversation API transcript predates durable run/message linkage.  When
 * it is an exact sequence of user/assistant turns for the runs in this view,
 * recover that linkage by ordinal position before merging live projections.
 *
 * Deliberately do nothing for a partial/history-mixed transcript: guessing in
 * those cases can attach a new run to an older user turn.
 */
function tagExactTranscriptTurns(
  serverMessages: ChatMessage[],
  runs: Array<{ id: string }>,
): ChatMessage[] {
  if (!runs.length || serverMessages.some((message) => message._runId != null)) {
    return serverMessages;
  }
  const userIndexes = serverMessages.flatMap((message, index) =>
    message.role === 'user' ? [index] : [],
  );
  const assistantIndexes = serverMessages.flatMap((message, index) =>
    message.role === 'assistant' ? [index] : [],
  );
  if (userIndexes.length !== runs.length || assistantIndexes.length !== runs.length) {
    return serverMessages;
  }

  const tagged = [...serverMessages];
  runs.forEach((run, index) => {
    tagged[userIndexes[index]] = { ...tagged[userIndexes[index]], _runId: run.id };
    tagged[assistantIndexes[index]] = {
      ...tagged[assistantIndexes[index]],
      _runId: run.id,
    };
  });
  return tagged;
}

/**
 * Collapse the assistant rows of one run into a single bubble.
 *
 * A run that emits text, calls a tool, then emits more text produces several
 * durable assistant rows. Rendered one bubble each, a single answer reads as a
 * stack of disconnected fragments that each repeat the avatar and agent name,
 * and the run's step rail can only hang off one of them. The run *is* the turn,
 * so its assistant rows are concatenated into one message whose content parts
 * render as consecutive markdown blocks.
 *
 * Only adjacent rows of the same run merge: a user turn between two runs, or a
 * row belonging to a different run, still ends the bubble. Identity fields come
 * from the first row so the bubble keeps a stable React key and its turn-start
 * timestamp while later rows stream in; liveness fields (thinking status, the
 * interrupted banner) come from the last row, which is the one still moving.
 */
function mergeThinking(
  serverMessage: ChatMessage,
  tagged: ChatMessage,
): Pick<ChatMessage, 'thinking' | 'thinkingStatus'> {
  const thinking = tagged.thinking || serverMessage.thinking;
  if (!thinking) {
    return {
      thinking: tagged.thinking,
      thinkingStatus: tagged.thinkingStatus ?? serverMessage.thinkingStatus,
    };
  }
  const liveStreaming = Boolean(tagged.thinking) && tagged.thinkingStatus === 'streaming';
  return {
    thinking,
    thinkingStatus: liveStreaming ? 'streaming' : 'complete',
  };
}

function mergeAssistantTurns(messages: ChatMessage[]): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const mergeable =
      message.role === 'assistant' &&
      message._runId != null &&
      previous != null &&
      previous.role === 'assistant' &&
      previous._runId === message._runId;
    if (!mergeable) {
      merged.push(message);
      continue;
    }

    const thinking = [previous.thinking, message.thinking]
      .filter((part) => Boolean(part && String(part).trim()))
      .join('\n\n');
    const fileLinks = [...(previous._fileLinks || []), ...(message._fileLinks || [])];

    merged[merged.length - 1] = {
      ...previous,
      content: [...previous.content, ...message.content],
      // A turn did runtime work if any of its rows did.
      _hasRuntimeSteps: Boolean(previous._hasRuntimeSteps || message._hasRuntimeSteps),
      ...(thinking ? { thinking } : {}),
      thinkingStatus: message.thinkingStatus ?? previous.thinkingStatus,
      // Only the final row can report how the turn ended.
      interrupted: message.interrupted,
      status: message.status,
      stopReason: message.stopReason,
      ...(fileLinks.length ? { _fileLinks: fileLinks } : {}),
    };
  }
  return merged;
}

/**
 * Merge server transcript rows with live per-Run projections.
 *
 * Persisted history remains ordered by `sequenceNo`; live projections are
 * inserted beside their matching `_runId` user turn. Late-finishing runs never
 * append after a newer user turn via blind push — they re-slot by `_runId`.
 */
export function projectConversationMessages(options: {
  serverMessages: ChatMessage[];
  conversationId: string | null;
  store: EntityStore;
  activeRunId: string | null;
  projectRunMessages: (runId: string) => ChatMessage[];
}): ChatMessage[] {
  const { serverMessages, conversationId, store, activeRunId, projectRunMessages } =
    options;

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

  const runOrder = new Map<string, number>();
  runs.forEach((run, i) => runOrder.set(run.id, i));

  // Start from server/chat history but drop leaked tool-envelope assistant rows.
  const result: ChatMessage[] = sortServerMessages(
    tagExactTranscriptTurns(serverMessages, runs).filter((m) => {
      if (m.role !== 'assistant') return true;
      return !looksLikeToolEnvelopeText(messageText(m));
    }),
  );

  for (const run of runs) {
    const projectedAll = projectRunMessages(run.id);
    const runIdx = runOrder.get(run.id) ?? 0;

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
      if (already) continue;

      // Insert after previous run's messages, before this run's assistant if any.
      const asstIdx = result.findIndex(
        (m) => m.role === 'assistant' && m._runId === run.id,
      );
      if (asstIdx >= 0) {
        result.splice(asstIdx, 0, { ...userMsg, _runId: run.id });
        continue;
      }
      // After last message belonging to an earlier run (or end of history).
      let insertAt = result.length;
      for (let i = result.length - 1; i >= 0; i -= 1) {
        const rid = result[i]._runId;
        if (rid == null) {
          // Keep before any later-run messages; stop at committed prefix end.
          continue;
        }
        const otherIdx = runOrder.get(String(rid));
        if (otherIdx != null && otherIdx < runIdx) {
          insertAt = i + 1;
          break;
        }
        if (otherIdx != null && otherIdx > runIdx) {
          insertAt = i;
        }
      }
      // If only later runs exist, place before the first later-run message.
      const firstLater = result.findIndex((m) => {
        const rid = m._runId;
        if (rid == null) return false;
        const oi = runOrder.get(String(rid));
        return oi != null && oi > runIdx;
      });
      if (firstLater >= 0) insertAt = Math.min(insertAt, firstLater);
      result.splice(insertAt, 0, { ...userMsg, _runId: run.id });
    }

    const assistants = projectedAll.filter(
      (message) => message.role === 'assistant',
    );
    for (
      let assistantIndex = 0;
      assistantIndex < assistants.length;
      assistantIndex += 1
    ) {
      const projected = assistants[assistantIndex];
      const text = messageText(projected);
      if (!text && !hasRuntimeDetail(projected)) continue;
      if (looksLikeToolEnvelopeText(text) && !hasRuntimeDetail(projected)) continue;

      const tagged = { ...projected, _runId: run.id };
      const serverAssistantSlots = result.flatMap((message, index) =>
        message.role === 'assistant' && message._runId === run.id ? [index] : [],
      );
      const stableSlot =
        tagged._messageId == null || tagged._messageId === ''
          ? serverAssistantSlots[assistantIndex] ?? -1
          : result.findIndex(
              (message) =>
                message.role === 'assistant' &&
                message._runId === run.id &&
                message._messageId === tagged._messageId,
            );
      // Older conversation rows may not carry run/message linkage. If there is
      // exactly one unlinked assistant row with the same text, treat it as the
      // durable copy of this projection instead of appending a second bubble.
      // Requiring uniqueness avoids attaching identical replies from distinct
      // runs to the wrong turn.
      const equivalentUnlinkedSlots = result.flatMap((message, index) =>
        message.role === 'assistant' &&
        message._runId == null &&
        messageText(message) === text
          ? [index]
          : [],
      );
      const equivalentUnlinkedSlot =
        equivalentUnlinkedSlots.length === 1
          ? equivalentUnlinkedSlots[0]
          : -1;
      const matchedSlot =
        stableSlot >= 0
          ? stableSlot
          : equivalentUnlinkedSlot >= 0
            ? equivalentUnlinkedSlot
            : (serverAssistantSlots[assistantIndex] ?? -1);

      if (matchedSlot >= 0) {
        const serverMessage = result[matchedSlot];
        const serverText = messageText(serverMessage);
        if (hasRuntimeDetail(tagged) && serverText) {
          // A turn that already did runtime work is no longer streaming, so the
          // committed row holds the authoritative text — a rehydrated live
          // projection may only carry a truncated preview of it.
          result[matchedSlot] = {
            ...serverMessage,
            ...tagged,
            content: serverMessage.content,
            sequenceNo: serverMessage.sequenceNo,
            createdAt: serverMessage.createdAt || tagged.createdAt,
            ...mergeThinking(serverMessage, tagged),
          };
        } else {
          // The live projection adds transient tool/stream detail, but a
          // committed row keeps its database-assigned placement and timestamp.
          result[matchedSlot] = {
            ...serverMessage,
            ...tagged,
            sequenceNo: serverMessage.sequenceNo,
            createdAt: serverMessage.createdAt || tagged.createdAt,
            ...mergeThinking(serverMessage, tagged),
          };
        }
        continue;
      }

      // Insert assistant after the prior assistant in the same run, then its
      // user message, else before later runs. This preserves multi-message
      // assistant turns while they stream and after a refresh.
      const lastAssistantSlot = serverAssistantSlots.at(-1);
      if (lastAssistantSlot != null) {
        result.splice(lastAssistantSlot + 1, 0, tagged);
        continue;
      }
      const userSlot = result.findIndex(
        (m) => m.role === 'user' && m._runId === run.id,
      );
      if (userSlot >= 0) {
        result.splice(userSlot + 1, 0, tagged);
        continue;
      }

      let insertAt = result.length;
      const firstLater = result.findIndex((m) => {
        const rid = m._runId;
        if (rid == null) return false;
        const oi = runOrder.get(String(rid));
        return oi != null && oi > runIdx;
      });
      if (firstLater >= 0) insertAt = firstLater;
      result.splice(insertAt, 0, tagged);
    }
  }

  // Server history was sorted before live rows were inserted. Do not sort the
  // combined list again: an uncommitted projection deliberately occupies the
  // slot immediately after its matching user turn.
  // A replay and a local optimistic projection can still converge on the same
  // durable message id through different event paths. Durable ids are the only
  // safe identity key here; identical text alone is intentionally not enough
  // because a run may legitimately emit two different assistant messages.
  const seenAssistantIds = new Set<string>();
  const deduped = result.filter((message) => {
    if (message.role !== 'assistant' || !message._runId || !message._messageId) {
      return true;
    }
    const key = `${message._runId}:${message._messageId}`;
    if (seenAssistantIds.has(key)) return false;
    seenAssistantIds.add(key);
    return true;
  });

  // Merge last: dedupe above keys on durable message ids, which a merged row no
  // longer carries one-to-one.
  return mergeAssistantTurns(deduped);
}
