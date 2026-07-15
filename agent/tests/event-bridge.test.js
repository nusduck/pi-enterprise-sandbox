import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEventBridge } from '../runtime/event-bridge.js';

function sessionHarness() {
  let listener = null;
  return {
    session: {
      subscribe(fn) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    },
    publish(event) {
      listener?.(event);
    },
  };
}

describe('event bridge persistence lifecycle', () => {
  it('serializes token and tool boundary persistence and drains before flush', async () => {
    const harness = sessionHarness();
    const order = [];
    const bridge = createEventBridge({
      session: harness.session,
      isCancelled: () => false,
      onToken: () => {},
      emit: () => {},
      budget: {
        recordToolCall: () => ({}),
        recordToolResult: () => ({}),
      },
      enforceBudgetOrAbort: async () => false,
      flushSessionEntries: async () => {},
      persistEvent: async (type) => {
        order.push(`start:${type}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${type}`);
      },
    });

    harness.publish({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'hello' },
    });
    harness.publish({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'skill_edit',
      args: { path: 'demo/a.md', content: 'large content' },
    });
    await bridge.flush();

    assert.deepEqual(order, [
      'start:token_batch',
      'end:token_batch',
      'start:tool_start',
      'end:tool_start',
    ]);
    await bridge.dispose();
  });

  it('exposes a semantic persistence failure to the draining caller', async () => {
    const harness = sessionHarness();
    const bridge = createEventBridge({
      session: harness.session,
      isCancelled: () => false,
      onToken: () => {},
      emit: () => {},
      budget: { recordToolCall: () => ({}), recordToolResult: () => ({}) },
      enforceBudgetOrAbort: async () => false,
      flushSessionEntries: async () => {},
      persistEvent: async (type, _payload, options) => {
        if (options?.required && type === 'tool_end') throw new Error('db unavailable');
      },
    });

    harness.publish({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'skill_edit',
      result: { content: [] },
      isError: false,
    });

    await assert.rejects(() => bridge.flush(), /db unavailable/);
    await bridge.dispose();
  });

  it('does not let a later background boundary consume an earlier failure', async () => {
    const harness = sessionHarness();
    let failed = false;
    const bridge = createEventBridge({
      session: harness.session,
      isCancelled: () => false,
      onToken: () => {},
      emit: () => {},
      budget: { recordToolCall: () => ({}), recordToolResult: () => ({}) },
      enforceBudgetOrAbort: async () => false,
      flushSessionEntries: async () => {},
      persistEvent: async (type, _payload, options) => {
        if (options?.required && type === 'tool_start' && !failed) {
          failed = true;
          throw new Error('tool_start write failed');
        }
      },
    });

    harness.publish({
      type: 'tool_execution_start',
      toolCallId: 'tc1',
      toolName: 'skill_edit',
      args: { path: 'a.md', content: 'a' },
    });
    harness.publish({
      type: 'tool_execution_end',
      toolCallId: 'tc1',
      toolName: 'skill_edit',
      result: { content: [] },
      isError: false,
    });

    await assert.rejects(() => bridge.flush(), /tool_start write failed/);
    await bridge.dispose();
  });
});
