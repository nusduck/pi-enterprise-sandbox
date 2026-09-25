/**
 * message.* / thinking.* branch of the unified reducer (split out of
 * runReducer.ts, which is pinned by the layout ratchet).
 *
 * DSH message and thinking events carry no message_id: one model turn is
 * thinking.delta… → message.delta… → thinking.completed → tool starts →
 * message.completed, and the next turn opens with a fresh thinking.delta.
 * Segments are therefore implicit: a turn continues the streaming assistant
 * message and a new one starts when none is streaming. Every new message is
 * stamped with the event sequence that created it so the stream can
 * interleave text segments with the tool calls between them.
 */
import type { EntityStore } from '../../entities/types';
import { createMessage, upsertMessage } from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import { latestAssistantId, latestStreamingAssistantId } from './platformEventNormalize';

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback;
  return String(v);
}

/**
 * Roles that belong in the chat transcript EntityStore.
 * DSH emits `toolResult` / `tool` as message.completed after sandbox tools;
 * those must never become assistant bubbles (raw exitCode/stdout JSON).
 */
function normalizeChatMessageRole(
  raw: unknown,
): 'user' | 'assistant' | null {
  const role = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, '');
  if (!role || role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  // toolResult, tool, function, system, etc. — not chat transcript rows
  return null;
}

export function reduceMessageEvent(
  store: EntityStore,
  ev: RuntimeEvent,
  payload: Record<string, unknown>,
  ts: string | null,
): EntityStore {
  const runId = ev.run_id;
  const seq = ev.sequence;
  let next = store;

  switch (ev.type) {
    case 'message.started': {
      // Default assistant only when role is omitted; never mint chat rows for toolResult.
      const startedRole = normalizeChatMessageRole(
        payload.role == null || payload.role === '' ? 'assistant' : payload.role,
      );
      if (!startedRole) break;
      const messageId = str(payload.message_id || payload.id, `msg_${runId}_${seq}`);
      const existing = next.messagesById[messageId];
      next = upsertMessage(
        next,
        createMessage({
          id: messageId,
          runId,
          conversationId: next.runsById[runId]?.conversationId || null,
          role: startedRole,
          text: str(payload.text),
          status: 'streaming',
          seq: existing?.seq ?? seq,
          createdAt: ts,
        }),
      );
      break;
    }

    case 'message.delta': {
      // Deltas are model tokens only. toolResult never streams deltas, but if a
      // bad envelope appears, do not append tool JSON onto an assistant bubble.
      const deltaRole = normalizeChatMessageRole(
        payload.role == null || payload.role === '' ? 'assistant' : payload.role,
      );
      if (!deltaRole || deltaRole === 'user') break;
      let messageId = str(payload.message_id || payload.id);
      const delta = str(payload.text || payload.delta);
      if (!messageId) {
        messageId = latestStreamingAssistantId(next.runsById[runId], next.messagesById);
      }
      if (messageId && next.messagesById[messageId]) {
        const msg = next.messagesById[messageId];
        next = upsertMessage(next, {
          ...msg,
          text: msg.text + delta,
          status: 'streaming',
          updatedAt: ts,
        });
      } else {
        // Implicit start: create streaming message if missing
        const id = messageId || `msg_${runId}_stream_${seq}`;
        next = upsertMessage(
          next,
          createMessage({
            id,
            runId,
            conversationId: next.runsById[runId]?.conversationId || null,
            role: 'assistant',
            text: delta,
            status: 'streaming',
            seq,
            createdAt: ts,
            updatedAt: ts,
          }),
        );
      }
      break;
    }

    case 'thinking.started':
    case 'thinking.delta':
    case 'thinking.completed': {
      const completed = ev.type === 'thinking.completed';
      let messageId = str(payload.message_id || payload.id);
      if (!messageId) {
        const run = next.runsById[runId];
        // Streaming thinking opens a turn: with no assistant message streaming,
        // it belongs to a new segment, not to the previous (completed) turn.
        // Only a late thinking.completed may still attach to the last message.
        messageId = latestStreamingAssistantId(run, next.messagesById)
          || (completed ? latestAssistantId(run, next.messagesById) : '');
      }
      const id = messageId || `msg_${runId}_thinking_${seq}`;
      const existing = next.messagesById[id];
      const delta = str(payload.text || payload.delta);
      const thinking = completed
        ? payload.text != null && payload.text_truncated !== true
          ? str(payload.text)
          : existing?.thinking || delta
        : ev.type === 'thinking.delta'
          ? (existing?.thinking || '') + delta
          : existing?.thinking || '';
      next = upsertMessage(
        next,
        createMessage({
          ...existing,
          id,
          runId,
          conversationId:
            existing?.conversationId || next.runsById[runId]?.conversationId || null,
          role: 'assistant',
          text: existing?.text || '',
          thinking,
          thinkingStatus: completed ? 'complete' : 'streaming',
          status: existing?.status || 'streaming',
          seq: existing?.seq ?? seq,
          createdAt: existing?.createdAt || ts,
          updatedAt: ts,
        }),
      );
      break;
    }

    case 'message.completed': {
      const completedRole = normalizeChatMessageRole(
        payload.role == null || payload.role === '' ? 'assistant' : payload.role,
      );
      // DSH toolResult / tool messages: handled via tool.* events only.
      if (!completedRole) break;

      let messageId = str(payload.message_id || payload.id);
      if (!messageId && completedRole === 'assistant') {
        messageId = latestStreamingAssistantId(next.runsById[runId], next.messagesById);
      }
      if (messageId && next.messagesById[messageId]) {
        const msg = next.messagesById[messageId];
        // Never overwrite a real assistant bubble with a mismatched role payload.
        if (msg.role !== completedRole && completedRole !== 'assistant') {
          break;
        }
        // A message.completed event is a bounded, redacted observability
        // projection. It must not replace a complete live token buffer with
        // its shortened preview.
        const previewStr = payload.text != null ? str(payload.text) : '';
        const isTruncated =
          payload.text_truncated === true ||
          payload.textTruncated === true ||
          (Boolean(msg.text) && Boolean(previewStr) && msg.text.length > previewStr.length && previewStr.endsWith('…'));
        const finalText =
          payload.text != null && !isTruncated
            ? previewStr
            : msg.text;
        next = upsertMessage(next, {
          ...msg,
          text: finalText,
          status: 'complete',
          thinkingStatus: msg.thinkingStatus === 'streaming' ? 'complete' : msg.thinkingStatus,
          updatedAt: ts,
        });
      } else {
        const text = str(payload.text);
        if (text || completedRole === 'user') {
          next = upsertMessage(
            next,
            createMessage({
              id: messageId || `msg_${runId}_${seq}`,
              runId,
              conversationId: next.runsById[runId]?.conversationId || null,
              role: completedRole,
              text,
              status: 'complete',
              seq,
              createdAt: ts,
              updatedAt: ts,
            }),
          );
        }
      }
      break;
    }
  }
  return next;
}
