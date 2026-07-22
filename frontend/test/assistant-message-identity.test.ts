import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityStore } from '../src/entities/index.ts';
import { reduceRuntimeEvent } from '../src/shared/state/runReducer.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';

describe('assistant message identity fallback', () => {
  it('does not let a later legacy assistant message overwrite a completed one', () => {
    const runId = 'run_legacy_messages';
    let store = createEntityStore();
    const apply = (sequence: number, type: string, payload: Record<string, unknown>) => {
      store = reduceRuntimeEvent(store, makeRuntimeEvent({
        event_id: `event_${sequence}`,
        sequence,
        run_id: runId,
        type,
        payload,
      })).store;
    };

    apply(1, 'message.delta', { role: 'assistant', text: 'summary' });
    apply(2, 'message.completed', { role: 'assistant', text: 'summary' });
    apply(3, 'message.delta', { role: 'assistant', text: 'cleanup complete' });
    apply(4, 'message.completed', { role: 'assistant', text: 'cleanup complete' });

    const messages = store.runsById[runId].messageIds.map((id) => store.messagesById[id]);
    assert.deepEqual(messages.map((message) => message.text), ['summary', 'cleanup complete']);
    assert.deepEqual(messages.map((message) => message.status), ['complete', 'complete']);
  });
});
