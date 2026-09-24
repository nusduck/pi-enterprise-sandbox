import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore } from '../src/entities/index.ts';
import { reducePlatformEventBatch } from '../src/shared/state/runReducer.ts';
import { normalizeToRuntimeEvent } from '../src/shared/state/platformEventNormalize.ts';
import type { PlatformEvent } from '../src/shared/schemas/events.ts';

function platform(ev: Partial<PlatformEvent>): PlatformEvent {
  return {
    eventId: ev.eventId || 'evt_1',
    type: ev.type || 'unknown',
    sequence: ev.sequence ?? 1,
    timestamp: ev.timestamp || new Date().toISOString(),
    eventVersion: 1,
    context: {
      orgId: 'org_1',
      userId: 'user_1',
      conversationId: 'conv_1',
      agentSessionId: 'sess_1',
      runId: ev.runId || 'run_1',
      ...ev.context,
    },
    data: ev.data || {},
  };
}

describe('stream preview preservation and truncation normalization', () => {
  it('normalizes text_truncated=true when message.textTruncated=true even if top-level text_truncated was false', () => {
    const raw = platform({
      eventId: 'evt_norm',
      sequence: 4,
      type: 'message.completed',
      data: {
        role: 'assistant',
        text: `${'a'.repeat(512)}…`,
        text_truncated: false,
        message: {
          role: 'assistant',
          textTruncated: true,
          content: [{ type: 'text', text: `${'a'.repeat(512)}…`, truncated: true }],
        },
      },
    });

    const normalized = normalizeToRuntimeEvent(raw);
    assert.equal(normalized.payload.text_truncated, true);
  });

  it('does not replace streamed full text when message.completed carries a shorter ellipsis preview with text_truncated=false', () => {
    const runId = 'run_stream_preview';
    const fullText = 'a'.repeat(886);
    const previewText = `${'a'.repeat(512)}…`;

    const { store } = reducePlatformEventBatch(createEntityStore(), [
      platform({ eventId: 'p_1', sequence: 1, type: 'run.started', runId }),
      platform({
        eventId: 'p_2',
        sequence: 2,
        type: 'message.created',
        runId,
        data: { messageId: 'msg_stream', role: 'assistant' },
      }),
      platform({
        eventId: 'p_3',
        sequence: 3,
        type: 'message.delta',
        runId,
        data: { messageId: 'msg_stream', delta: fullText },
      }),
      platform({
        eventId: 'p_4',
        sequence: 4,
        type: 'message.completed',
        runId,
        data: {
          messageId: 'msg_stream',
          role: 'assistant',
          text: previewText,
          text_truncated: false,
          message: {
            role: 'assistant',
            textTruncated: true,
            content: [{ type: 'text', text: previewText, truncated: true }],
          },
        },
      }),
    ]);

    assert.equal(store.messagesById.msg_stream.text, fullText);
    assert.equal(store.messagesById.msg_stream.status, 'complete');
  });
});
