/**
 * Refreshing mid-Run must not lose the assistant answer.
 *
 * `rehydrateConversation` used to skip persisted-event replay whenever the Run
 * row still said RUNNING, and rely entirely on the SSE reconnect. When the Run
 * finished during the refresh, the reconnect had nothing left to deliver, so
 * the bubble kept its `Agent Execution Steps` (restored from the durable tool
 * ledger, which is always replayed) but lost `message.delta` /
 * `message.completed` — the answer text only reappeared after the user sent
 * another message and the projection re-merged persisted history.
 *
 * Durable replay is safe to always run: the reducer dedupes on event id.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';

const CONV = 'conv_refresh';
const RUN = 'run_refresh';
const context = { runId: RUN, conversationId: CONV };

/** Timeline says RUNNING; GET /api/runs says it already finished. */
function installFetch(runtimeAvailable: boolean) {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith(`/api/conversations/${CONV}/events`)) {
      return new Response(
        JSON.stringify({
          runs: [
            {
              run_id: RUN,
              conversation_id: CONV,
              sandbox_session_id: 'session_refresh',
              status: 'running',
              created_at: '2026-08-25T07:51:33Z',
            },
          ],
          events: [
            {
              run_id: RUN,
              sequence: 1,
              event_id: 'evt-1',
              type: 'run.started',
              payload: { status: 'RUNNING' },
            },
            {
              run_id: RUN,
              sequence: 2,
              event_id: 'evt-2',
              type: 'message.completed',
              payload: {
                data: {
                  role: 'user',
                  message: { role: 'user', content: [{ type: 'text', text: '分析一下' }] },
                },
                context,
              },
            },
            {
              run_id: RUN,
              sequence: 3,
              event_id: 'evt-3',
              type: 'message.delta',
              payload: { data: { role: 'assistant', delta: '分析结果：' }, context },
            },
            {
              run_id: RUN,
              sequence: 4,
              event_id: 'evt-4',
              type: 'message.completed',
              payload: {
                data: {
                  role: 'assistant',
                  message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: '分析结果：一切正常。' }],
                  },
                },
                context,
              },
            },
          ],
          last_run: { run_id: RUN, status: 'running' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.endsWith(`/api/runs/${RUN}`)) {
      // The Run finished between the timeline read and this detail read.
      return new Response(
        JSON.stringify({
          run_id: RUN,
          conversation_id: CONV,
          status: 'SUCCEEDED',
          runtime_available: runtimeAvailable,
          next_sequence: 5,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/tools')) {
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }
    if (url.includes('/datasets')) {
      return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
    }
    if (url.includes('/processes') || url.includes('/trace')) {
      return new Response(JSON.stringify({}), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; }, seen };
}

function assistantText(bridge: ReturnType<typeof createEntityBridge>) {
  return bridge
    .projectRunMessages(RUN)
    .filter((m) => m.role === 'assistant')
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content ?? ''),
    )
    .join('');
}

describe('refresh during an active Run', () => {
  it('keeps the assistant answer when the Run finishes during rehydrate', async () => {
    const { restore } = installFetch(true);
    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation(CONV);
      const text = assistantText(bridge);
      assert.ok(
        text.includes('分析结果'),
        `assistant text must survive refresh, got: ${JSON.stringify(text)}`,
      );
    } finally {
      restore();
    }
  });

  it('keeps the user message too', async () => {
    const { restore } = installFetch(true);
    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation(CONV);
      const roles = bridge.projectRunMessages(RUN).map((m) => m.role);
      assert.ok(roles.includes('user'), `expected a user message, got ${roles}`);
    } finally {
      restore();
    }
  });

  it('replays exactly once — no duplicated assistant turn', async () => {
    const { restore } = installFetch(false);
    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation(CONV);
      const assistants = bridge
        .projectRunMessages(RUN)
        .filter((m) => m.role === 'assistant');
      assert.equal(
        assistants.length,
        1,
        'runtime_available:false used to replay a second time',
      );
    } finally {
      restore();
    }
  });
});
