import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

describe('conversation history rehydration', () => {
  it('restores the real flattened platform-event contract after refresh', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      assert.match(url, /\/api\/conversations\/conv_platform\/events$/);
      const context = { runId: 'run_platform', conversationId: 'conv_platform' };
      return new Response(
        JSON.stringify({
          runs: [{
            run_id: 'run_platform',
            conversation_id: 'conv_platform',
            status: 'SUCCEEDED',
          }],
          events: [
            {
              run_id: 'run_platform',
              sequence: 1,
              event_id: 'evt-1',
              type: 'run.accepted',
              payload: { status: 'ACCEPTED' },
            },
            {
              run_id: 'run_platform',
              sequence: 2,
              event_id: 'evt-2',
              type: 'message.completed',
              payload: {
                data: {
                  role: 'user',
                  message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
                },
                context,
              },
            },
            {
              run_id: 'run_platform',
              sequence: 3,
              event_id: 'evt-3',
              type: 'message.delta',
              payload: { data: { role: 'assistant', delta: 'hello back' }, context },
            },
            {
              run_id: 'run_platform',
              sequence: 4,
              event_id: 'evt-4',
              type: 'message.completed',
              payload: {
                data: {
                  role: 'assistant',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hello back' }],
                  },
                },
                context,
              },
            },
            {
              run_id: 'run_platform',
              sequence: 5,
              event_id: 'evt-5',
              type: 'run.completed',
              payload: { status: 'SUCCEEDED' },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation('conv_platform');
      const store = bridge.getStore();
      const messages = store.runsById.run_platform.messageIds.map(
        (id) => store.messagesById[id],
      );
      assert.deepEqual(
        messages.map((message) => [message.role, message.text, message.status]),
        [
          ['user', 'hello', 'complete'],
          ['assistant', 'hello back', 'complete'],
        ],
      );
      assert.equal(store.runsById.run_platform.lastSequence, 5);
      assert.equal(store.runsById.run_platform.status, 'succeeded');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('restores completed tool calls from persisted events', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      assert.match(url, /\/api\/conversations\/conv_history\/events$/);
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

  it('restores persisted tools when a stale running Run has no live Agent log', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/api/conversations/conv_stale/events')) {
        return new Response(
          JSON.stringify({
            runs: [
              {
                run_id: 'run_stale',
                conversation_id: 'conv_stale',
                sandbox_session_id: 'session_stale',
                status: 'running',
                created_at: '2026-07-14T00:00:00Z',
              },
            ],
            events: [
              {
                run_id: 'run_stale',
                sequence: 1,
                event_id: 'evt_tool_start',
                type: 'tool_start',
                payload: { id: 'tool_stale', name: 'read', args: { path: 'README.md' } },
              },
              {
                run_id: 'run_stale',
                sequence: 2,
                event_id: 'evt_tool_end',
                type: 'tool_end',
                payload: { id: 'tool_stale', result: 'contents' },
              },
            ],
            last_run: { run_id: 'run_stale', status: 'running' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/runs/run_stale')) {
        return new Response(
          JSON.stringify({
            run_id: 'run_stale',
            conversation_id: 'conv_stale',
            status: 'running',
            runtime_available: false,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation('conv_stale');
      const store = bridge.getStore();
      assert.deepEqual(store.runsById.run_stale.toolExecutionIds, ['tool_stale']);
      assert.equal(store.toolExecutionsById.tool_stale.name, 'read');
      assert.equal(store.toolExecutionsById.tool_stale.status, 'completed');
      assert.equal(store.activeRunId, 'run_stale');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
