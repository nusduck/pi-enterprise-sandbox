import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

describe('conversation history rehydration', () => {
  it('restores completed tool calls from persisted events', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /\/api\/conversations\/conv_history\/events$/);
      return new Response(
        JSON.stringify({
          runs: [
            {
              run_id: 'run_history',
              conversation_id: 'conv_history',
              sandbox_session_id: 'session_history',
              status: 'completed',
              created_at: '2026-07-14T00:00:00Z',
            },
          ],
          events: [
            {
              run_id: 'run_history',
              sequence: 1,
              event_id: 'evt_session',
              type: 'session',
              payload: {
                session_id: 'session_history',
                conversation_id: 'conv_history',
              },
            },
            {
              run_id: 'run_history',
              sequence: 2,
              event_id: 'evt_tool_start',
              type: 'tool_start',
              payload: { id: 'tool_1', name: 'bash', args: { command: 'pwd' } },
            },
            {
              run_id: 'run_history',
              sequence: 3,
              event_id: 'evt_tool_end',
              type: 'tool_end',
              payload: { id: 'tool_1', name: 'bash', result: '/workspace' },
            },
            {
              run_id: 'run_history',
              sequence: 4,
              event_id: 'evt_done',
              type: 'done',
              payload: { status: 'completed' },
            },
          ],
          last_run: { run_id: 'run_history', status: 'completed' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      const restored = await bridge.rehydrateConversation('conv_history');
      assert.equal(restored.length, 1);
      const store = bridge.getStore();
      assert.equal(store.runsById.run_history.status, 'succeeded');
      assert.deepEqual(store.runsById.run_history.toolExecutionIds, ['tool_1']);
      assert.equal(store.toolExecutionsById.tool_1.name, 'bash');
      assert.equal(store.toolExecutionsById.tool_1.status, 'completed');
      assert.equal(store.toolExecutionsById.tool_1.result, '/workspace');
      assert.equal(store.activeConversationId, 'conv_history');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
