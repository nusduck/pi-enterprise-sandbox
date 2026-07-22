import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createObservabilityExtension } from '../../src/extensions/observability/index.js';

const RUN_CONTEXT = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
};

describe('observability assistant message identities', () => {
  it('keeps each streamed assistant message distinct through completion', async () => {
    const records = [];
    const handlers = new Map();
    const extension = createObservabilityExtension({
      runContext: RUN_CONTEXT,
      deps: { recorder: { record: async (record) => records.push(record) } },
    });
    await extension({
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
      },
    });

    const emit = async (event, payload) => {
      for (const handler of handlers.get(event) || []) await handler(payload);
    };
    await emit('message_update', {
      assistantMessageEvent: { type: 'text_delta', delta: 'summary' },
    });
    await emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'summary' }] },
    });
    await emit('message_update', {
      assistantMessageEvent: { type: 'text_delta', delta: 'cleanup complete' },
    });
    await emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'cleanup complete' }] },
    });

    const events = records.filter((record) => record.type.startsWith('message.'));
    assert.deepEqual(events.map((record) => record.data.messageId), [
      `assistant:${RUN_CONTEXT.runId}:seq1`,
      `assistant:${RUN_CONTEXT.runId}:seq1`,
      `assistant:${RUN_CONTEXT.runId}:seq2`,
      `assistant:${RUN_CONTEXT.runId}:seq2`,
    ]);
  });
});
