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

  it('restores messages, tools, process handles, and submitted artifacts after refresh (D1 matrix)', async () => {
    const originalFetch = globalThis.fetch;
    const context = { runId: 'run_matrix', conversationId: 'conv_matrix' };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      assert.match(url, /\/api\/conversations\/conv_matrix\/events$/);
      return new Response(
        JSON.stringify({
          runs: [
            {
              run_id: 'run_matrix',
              conversation_id: 'conv_matrix',
              sandbox_session_id: 'session_matrix',
              status: 'SUCCEEDED',
            },
          ],
          events: [
            {
              run_id: 'run_matrix',
              sequence: 1,
              event_id: 'evt_user',
              type: 'message.completed',
              payload: {
                data: {
                  role: 'user',
                  message: {
                    role: 'user',
                    content: [{ type: 'text', text: 'run the job' }],
                  },
                },
                context,
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 2,
              event_id: 'evt_tool',
              type: 'tool_start',
              payload: {
                id: 'tool_proc',
                name: 'process_start',
                args: { command: 'sleep 1' },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 3,
              event_id: 'evt_process',
              type: 'process.started',
              payload: {
                data: {
                  process_id: 'proc_1',
                  command: 'sleep 1',
                  status: 'running',
                  tool_call_id: 'tool_proc',
                },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 4,
              event_id: 'evt_process_out',
              type: 'process.output',
              payload: {
                data: {
                  process_id: 'proc_1',
                  stream: 'stdout',
                  chunk: 'hello-process\n',
                },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 5,
              event_id: 'evt_process_done',
              type: 'process.completed',
              payload: {
                data: { process_id: 'proc_1', exit_code: 0 },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 6,
              event_id: 'evt_tool_end',
              type: 'tool_end',
              payload: {
                id: 'tool_proc',
                name: 'process_start',
                result: { process_id: 'proc_1', exit_code: 0 },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 7,
              event_id: 'evt_artifact',
              type: 'artifact.ready',
              payload: {
                data: {
                  artifact_id: 'art_1',
                  name: 'report.md',
                  sha256: 'a'.repeat(64),
                },
              },
            },
            {
              run_id: 'run_matrix',
              sequence: 8,
              event_id: 'evt_done',
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
      await bridge.rehydrateConversation('conv_matrix');
      const store = bridge.getStore();
      const run = store.runsById.run_matrix;
      assert.equal(run.status, 'succeeded');
      assert.equal(run.lastSequence, 8);

      // Messages
      const messages = run.messageIds.map((id) => store.messagesById[id]);
      assert.ok(
        messages.some((m) => m.role === 'user' && m.text.includes('run the job')),
        'user message must rehydrate',
      );

      // Tools
      assert.ok(
        run.toolExecutionIds.includes('tool_proc'),
        'tool execution id linked on run',
      );
      assert.equal(store.toolExecutionsById.tool_proc.name, 'process_start');
      assert.equal(store.toolExecutionsById.tool_proc.status, 'completed');

      // Process handle + output (D1 + D5 rehydrate floor)
      assert.deepEqual(run.processIds, ['proc_1']);
      assert.ok(store.processesById.proc_1, 'process entity must rehydrate');
      assert.equal(store.processesById.proc_1.command, 'sleep 1');
      assert.equal(store.processesById.proc_1.stdout, 'hello-process\n');
      assert.equal(store.processesById.proc_1.status, 'completed');
      assert.equal(store.processesById.proc_1.exitCode, 0);

      // Artifact (submit_artifact / artifact.ready only)
      assert.deepEqual(run.artifactIds, ['art_1']);
      assert.ok(store.artifactsById.art_1, 'artifact entity must rehydrate');
      assert.equal(store.artifactsById.art_1.name, 'report.md');
      assert.equal(store.artifactsById.art_1.source, 'submit_artifact');
      assert.equal(store.artifactsById.art_1.sessionId, 'session_matrix');
      assert.equal(store.artifactsById.art_1.sha256, 'a'.repeat(64));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('restores process/artifact from flat platform envelopes after refresh', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('/datasets')) {
        return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
      }
      assert.match(url, /\/api\/conversations\/conv_flat\/events$/);
      return new Response(
        JSON.stringify({
          runs: [
            {
              run_id: 'run_flat',
              conversation_id: 'conv_flat',
              sandbox_session_id: 'session_flat',
              status: 'SUCCEEDED',
            },
          ],
          events: [
            {
              run_id: 'run_flat',
              sequence: 1,
              event_id: '01HZEVTFLAT000000000000001',
              type: 'process.started',
              payload: {
                processId: 'proc_flat',
                command: 'python app.py',
                toolCallId: 'tc_flat',
              },
            },
            {
              run_id: 'run_flat',
              sequence: 2,
              event_id: '01HZEVTFLAT000000000000002',
              type: 'process.output',
              payload: {
                processId: 'proc_flat',
                stream: 'stderr',
                text: 'warn-line\n',
                cursor: 10,
              },
            },
            {
              run_id: 'run_flat',
              sequence: 3,
              event_id: '01HZEVTFLAT000000000000003',
              type: 'artifact.ready',
              payload: {
                artifactId: 'art_flat',
                name: 'out.xlsx',
                sha256: 'b'.repeat(64),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const bridge = createEntityBridge();
      await bridge.rehydrateConversation('conv_flat');
      const store = bridge.getStore();
      assert.equal(store.processesById.proc_flat?.command, 'python app.py');
      assert.equal(store.processesById.proc_flat?.stderr, 'warn-line\n');
      assert.equal(store.artifactsById.art_flat?.name, 'out.xlsx');
      assert.equal(store.artifactsById.art_flat?.source, 'submit_artifact');
      assert.deepEqual(store.runsById.run_flat.processIds, ['proc_flat']);
      assert.deepEqual(store.runsById.run_flat.artifactIds, ['art_flat']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('restores pending_input from GET detail after refresh (G6)', async () => {
    const { rehydrateRun } = await import('../src/shared/state/runReducer.ts');
    const { createEntityStore } = await import('../src/entities/index.ts');
    const next = rehydrateRun(createEntityStore(), {
      run_id: 'run_wait',
      conversation_id: 'conv_wait',
      status: 'WAITING_INPUT',
      pending_input: {
        interaction_id: '01K0G2PAV8FPMVC9QHJG7JPN57',
        interaction_type: 'select',
        title: 'Choose a region',
        message: 'Where?',
        options: ['eu', 'us'],
      },
    });
    const run = next.runsById.run_wait;
    assert.equal(run.status, 'waiting_input');
    assert.equal(run.pendingInput?.interactionId, '01K0G2PAV8FPMVC9QHJG7JPN57');
    assert.equal(run.pendingInput?.title, 'Choose a region');
    assert.deepEqual(run.pendingInput?.options, ['eu', 'us']);
  });

  it('rehydrateInProgress rediscovers WAITING_INPUT runs without status=running filter (G6)', async () => {
    const originalFetch = globalThis.fetch;
    const listUrls: string[] = [];
    const waitDetail = {
      run_id: 'run_wait_active',
      conversation_id: 'conv_wait_active',
      status: 'WAITING_INPUT',
      pending_input: {
        interaction_id: '01K0G2PAV8FPMVC9QHJG7JPN57',
        interaction_type: 'select',
        title: 'Pick one',
        message: null,
        options: ['a', 'b'],
      },
    };
    globalThis.fetch = (async (input) => {
      const url = String(input);
      // Individual GET /api/runs/:id (detail or tools/trace/events)
      if (/\/api\/runs\/run_wait_active(\/|$|\?)/.test(url)) {
        if (url.includes('/tools')) {
          return new Response(JSON.stringify({ tools: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/trace') || url.includes('/events')) {
          return new Response(JSON.stringify({ spans: [], events: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify(waitDetail), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // List endpoint
      if (url.includes('/api/runs') && !url.includes('/api/runs/')) {
        listUrls.push(url);
        return new Response(
          JSON.stringify({
            runs: [
              waitDetail,
              {
                run_id: 'run_done',
                conversation_id: 'conv_wait_active',
                status: 'SUCCEEDED',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const bridge = createEntityBridge();
    try {
      const runs = await bridge.rehydrateInProgress('conv_wait_active');
      assert.equal(runs.length, 1);
      assert.equal(runs[0].id, 'run_wait_active');
      assert.equal(runs[0].status, 'waiting_input');
      assert.equal(runs[0].pendingInput?.interactionId, '01K0G2PAV8FPMVC9QHJG7JPN57');
      assert.ok(
        listUrls.every((u) => !/[?&]status=running\b/.test(u)),
        `listRuns must not filter status=running only; got ${listUrls.join(',')}`,
      );
      const store = bridge.getStore();
      assert.equal(store.runsById.run_wait_active?.status, 'waiting_input');
      assert.equal(
        store.runsById.run_wait_active?.pendingInput?.title,
        'Pick one',
      );
    } finally {
      // rehydrateInProgress resumes SSE for active runs; tear down so the test exits.
      try {
        bridge.manager.disconnect('run_wait_active');
      } catch {
        /* ignore */
      }
      globalThis.fetch = originalFetch;
    }
  });
});
