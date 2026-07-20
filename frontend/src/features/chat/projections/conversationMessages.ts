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

function looksLikeToolEnvelopeText(text: string): boolean {
  const t = text.trim();
  if (!t.startsWith('{')) return false;
  return (
    t.includes('"exitCode"') ||
    t.includes('"stdout"') ||
    t.includes('"stdoutTruncated"')
  );
}

/**
 * Stable chat order key: prefer run timeline, then role (user before assistant).
 */
function messageOrderKey(
  message: ChatMessage,
  runOrder: Map<string, number>,
): [number, number, string] {
  const runId = message._runId != null ? String(message._runId) : '';
  const runIdx =
    runId && runOrder.has(runId)
      ? (runOrder.get(runId) as number)
      : runId
        ? 1_000_000
        : -1; // committed history without run id stays first in relative order
  const roleRank =
    message.role === 'user' ? 0 : message.role === 'assistant' ? 1 : 2;
  const id = String(message._messageId || runId || messageText(message).slice(0, 32));
  return [runIdx, roleRank, id];
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
 * Merge server transcript rows with live per-Run projections.
 *
 * Ordering: runs by startedAt/createdAt/id; within a run user then assistant.
 * Late-finishing runs never append after a newer user turn via blind push —
 * they re-slot by `_runId`.
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
  const result: ChatMessage[] = tagExactTranscriptTurns(serverMessages, runs).filter((m) => {
    if (m.role !== 'assistant') return true;
    return !looksLikeToolEnvelopeText(messageText(m));
  });

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

    const projected = projectedAll.find((message) => message.role === 'assistant');
    if (!projected) continue;
    const text = messageText(projected);
    if (!text && !hasRuntimeDetail(projected)) continue;
    if (looksLikeToolEnvelopeText(text) && !hasRuntimeDetail(projected)) continue;

    const tagged = { ...projected, _runId: run.id };
    const stableSlot = result.findIndex(
      (message) => message.role === 'assistant' && message._runId === run.id,
    );

    if (stableSlot >= 0) {
      const serverMessage = result[stableSlot];
      if (hasRuntimeDetail(tagged) && !text && messageText(serverMessage)) {
        result[stableSlot] = {
          ...tagged,
          content: [
            ...serverMessage.content.filter((part) => part.type === 'text'),
            ...tagged.content,
          ],
        };
      } else {
        result[stableSlot] = tagged;
      }
      continue;
    }

    // Insert assistant after this run's user message, else after earlier runs.
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

  // Final stable sort for mixed committed + projected rows.
  return result
    .map((m, index) => ({ m, index }))
    .sort((a, b) => {
      const ka = messageOrderKey(a.m, runOrder);
      const kb = messageOrderKey(b.m, runOrder);
      for (let i = 0; i < ka.length; i += 1) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return a.index - b.index;
    })
    .map(({ m }) => m);
}
