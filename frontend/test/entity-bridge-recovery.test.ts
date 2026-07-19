import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  createEntityBridge,
  rehydrateTraceSpans,
} from '../src/features/chat/entityBridge.ts';
import {
  createEntityStore,
  createRun,
  createTraceSpan,
  upsertRun,
  upsertTraceSpan,
} from '../src/entities/index.ts';
import { createRunSSEManager } from '../src/shared/sse/manager.ts';
import { makeRuntimeEvent } from '../src/shared/schemas/events.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('reconcileRun fetches authoritative run and tool snapshots', async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/runs/run_recover') {
      return new Response(JSON.stringify({
        run_id: 'run_recover',
        status: 'completed',
        runtime_available: false,
      }), { status: 200 });
    }
    if (url === '/api/runs/run_recover/tools') {
      return new Response(JSON.stringify([{
        tool_call_id: 'tc_unknown',
        run_id: 'run_recover',
        status: 'unknown',
        tool_name: 'skill_edit',
        arguments: { path: 'large.md', content_bytes: 123456 },
        result_summary: 'terminal outcome could not be confirmed',
        created_at: '2026-07-15T00:00:00.000Z',
        updated_at: '2026-07-15T00:00:01.000Z',
      }]), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  bridge.beginRun({ runId: 'run_recover' });
  const run = await bridge.reconcileRun('run_recover');
  const store = bridge.getStore();

  assert.equal(run?.status, 'succeeded');
  assert.deepEqual(requests, ['/api/runs/run_recover', '/api/runs/run_recover/tools']);
  assert.equal(store.toolExecutionsById.tc_unknown.status, 'failed');
  assert.equal(store.toolExecutionsById.tc_unknown.isError, true);
  assert.match(
    store.toolExecutionsById.tc_unknown.summary || '',
    /Outcome unconfirmed; do not retry automatically/i,
  );
});

test('reconcileRun replaces transient spans with the durable trace tree', async () => {
  const traceId = 'a'.repeat(32);
  const rootSpan = 'b'.repeat(16);
  const toolSpan = 'c'.repeat(16);
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/runs/run_trace') {
      return new Response(JSON.stringify({
        run_id: 'run_trace',
        trace_id: traceId,
        status: 'completed',
      }), { status: 200 });
    }
    if (url === '/api/runs/run_trace/tools') {
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }
    if (url === '/api/runs/run_trace/trace') {
      return new Response(JSON.stringify({
        traceId,
        runId: 'run_trace',
        truncated: true,
        nextCursor: rootSpan,
        spans: [
          {
            traceId,
            spanId: rootSpan,
            parentSpanId: null,
            runId: 'run_trace',
            orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
            userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
            kind: 'run',
            name: 'Run',
            status: 'ok',
            startedAt: '2026-07-19T00:00:00.000Z',
            finishedAt: '2026-07-19T00:00:01.000Z',
            durationMs: 1000,
            attributes: { attempt: 1 },
          },
        ],
      }), { status: 200 });
    }
    if (url === `/api/runs/run_trace/trace?cursor=${rootSpan}`) {
      return new Response(JSON.stringify({
        traceId,
        runId: 'run_trace',
        truncated: false,
        nextCursor: null,
        spans: [
          {
            traceId,
            spanId: toolSpan,
            parentSpanId: rootSpan,
            runId: 'run_trace',
            kind: 'tool',
            name: 'bash',
            status: 'error',
            attributes: { errorCode: 'EXIT_1' },
          },
        ],
      }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  bridge.beginRun({ runId: 'run_trace' });
  bridge.ingestAgentEvent('run_trace', { type: 'trace', trace_id: traceId });
  await bridge.reconcileRun('run_trace');
  const store = bridge.getStore();
  assert.deepEqual(requests, [
    '/api/runs/run_trace',
    '/api/runs/run_trace/tools',
    '/api/runs/run_trace/trace',
    `/api/runs/run_trace/trace?cursor=${rootSpan}`,
  ]);
  assert.deepEqual(store.runsById.run_trace.traceSpanIds, [
    `${traceId}:${rootSpan}`,
    `${traceId}:${toolSpan}`,
  ]);
  assert.equal(
    store.traceSpansById[`${traceId}:${toolSpan}`].parentId,
    `${traceId}:${rootSpan}`,
  );
  assert.equal(
    store.traceSpansById[`${traceId}:${rootSpan}`].orgId,
    '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  );
  assert.equal(
    store.traceSpansById[`${traceId}:${rootSpan}`].userId,
    '01K0G2PAV8FPMVC9QHJG7JPN50',
  );
  assert.equal(store.traceSpansById[`${traceId}:${toolSpan}`].error, 'EXIT_1');
  assert.equal(store.traceSpansById.runspan_run_trace, undefined);
  bridge.dispose();
});

test('a truncated trace page cannot erase live spans', () => {
  const traceId = 'a'.repeat(32);
  let store = upsertRun(
    createEntityStore(),
    createRun({ id: 'run_partial', traceId }),
  );
  store = upsertTraceSpan(
    store,
    createTraceSpan({
      id: 'live-span',
      runId: 'run_partial',
      kind: 'model',
      name: 'live model',
    }),
  );

  const next = rehydrateTraceSpans(store, 'run_partial', {
    traceId,
    runId: 'run_partial',
    truncated: true,
    nextCursor: null,
    spans: [
      {
        traceId,
        runId: 'run_partial',
        spanId: 'b'.repeat(16),
        kind: 'run',
        name: 'Run',
        status: 'running',
      },
    ],
  });

  assert.ok(next.traceSpansById['live-span']);
  assert.ok(next.traceSpansById[`${traceId}:${'b'.repeat(16)}`]);
});

test('reconnect exhaustion uses recovery instead of synthesizing success', async () => {
  let manager: ReturnType<typeof createRunSSEManager>;
  let reconciliations = 0;
  manager = createRunSSEManager(
    createEntityStore(),
    {
      maxRetries: 0,
      fetchImpl: async () => { throw new Error('connection dropped'); },
      reconcileRun: async () => {
        reconciliations += 1;
        manager.handleRuntimeEvent(makeRuntimeEvent({
          event_id: 'authoritative_failed',
          sequence: 2,
          run_id: 'run_lost',
          type: 'run.failed',
          payload: { message: 'authoritative failure' },
        }));
      },
    },
  );
  manager.handleRuntimeEvent(makeRuntimeEvent({
    event_id: 'started',
    sequence: 1,
    run_id: 'run_lost',
    type: 'run.started',
  }));
  manager.connect('run_lost');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(reconciliations, 1);
  assert.equal(manager.getStore().runsById.run_lost.status, 'failed');
  assert.equal(manager.getConnection('run_lost')?.connectionStatus, 'closed');
});

test('coalesces concurrent reconciliation requests for one Run', async () => {
  const requests: string[] = [];
  let releaseRun: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/runs/run_singleflight') {
      return new Promise<Response>((resolve) => {
        releaseRun = resolve;
      });
    }
    if (url === '/api/runs/run_singleflight/tools') {
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  bridge.beginRun({ runId: 'run_singleflight' });
  const first = bridge.reconcileRun('run_singleflight');
  const second = bridge.reconcileRun('run_singleflight');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, ['/api/runs/run_singleflight']);
  releaseRun?.(
    new Response(
      JSON.stringify({ run_id: 'run_singleflight', status: 'completed' }),
      { status: 200 },
    ),
  );
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a?.status, 'succeeded');
  assert.equal(b?.status, 'succeeded');
  assert.deepEqual(requests, [
    '/api/runs/run_singleflight',
    '/api/runs/run_singleflight/tools',
  ]);
  bridge.dispose();
});

test('does not commit a stale snapshot after a newer live event', async () => {
  let releaseRun: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/runs/run_race') {
      return new Promise<Response>((resolve) => {
        releaseRun = resolve;
      });
    }
    if (url === '/api/runs/run_race/tools') {
      return new Response(JSON.stringify({ tools: [] }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  bridge.beginRun({ runId: 'run_race' });
  const pending = bridge.reconcileRun('run_race');
  await new Promise((resolve) => setTimeout(resolve, 0));
  bridge.ingestAgentEvent('run_race', {
    event_id: 'live-failed',
    sequence: 1,
    run_id: 'run_race',
    type: 'run.failed',
    payload: { message: 'live failure' },
  });
  releaseRun?.(
    new Response(
      JSON.stringify({ run_id: 'run_race', status: 'completed' }),
      { status: 200 },
    ),
  );
  await pending;
  assert.equal(bridge.getStore().runsById.run_race.status, 'failed');
  assert.equal(bridge.getStore().runsById.run_race.error, 'live failure');
  bridge.dispose();
});

test('reconciliation of one Run preserves an SSE update for another Run', async () => {
  let releaseTools: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/runs/run_target') {
      return new Response(
        JSON.stringify({ run_id: 'run_target', status: 'completed' }),
        { status: 200 },
      );
    }
    if (url === '/api/runs/run_target/tools') {
      return new Promise<Response>((resolve) => {
        releaseTools = resolve;
      });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  bridge.beginRun({ runId: 'run_target' });
  bridge.beginRun({ runId: 'run_live' });
  const pending = bridge.reconcileRun('run_target');
  await new Promise((resolve) => setTimeout(resolve, 0));

  bridge.ingestAgentEvent('run_live', {
    event_id: 'live-failed',
    sequence: 1,
    run_id: 'run_live',
    type: 'run.failed',
    payload: { message: 'live failure must survive reconciliation' },
  });
  releaseTools?.(
    new Response(JSON.stringify({ tools: [] }), { status: 200 }),
  );
  await pending;

  const store = bridge.getStore();
  assert.equal(store.runsById.run_target.status, 'succeeded');
  assert.equal(store.runsById.run_live.status, 'failed');
  assert.equal(
    store.runsById.run_live.error,
    'live failure must survive reconciliation',
  );
  bridge.dispose();
});

test('conversation trace rehydrate rebases around a background Run update', async () => {
  const traceId = 'd'.repeat(32);
  const spanId = 'e'.repeat(16);
  let releaseTrace: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === '/api/conversations/conv_trace_race/events') {
      return new Response(
        JSON.stringify({
          runs: [
            {
              run_id: 'run_trace_target',
              conversation_id: 'conv_trace_race',
              trace_id: traceId,
              status: 'completed',
            },
          ],
          events: [],
        }),
        { status: 200 },
      );
    }
    if (url === '/api/runs/run_trace_target/trace') {
      return new Promise<Response>((resolve) => {
        releaseTrace = resolve;
      });
    }
    if (url.includes('/datasets')) {
      return new Response(JSON.stringify({ datasets: [] }), { status: 200 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const bridge = createEntityBridge();
  const pending = bridge.rehydrateConversation('conv_trace_race');
  for (let attempt = 0; attempt < 10 && !releaseTrace; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(releaseTrace, 'trace request should be in flight');

  bridge.ingestAgentEvent('run_background', {
    event_id: 'background-failed',
    sequence: 1,
    run_id: 'run_background',
    type: 'run.failed',
    payload: { message: 'background update must survive trace rehydrate' },
  });
  releaseTrace?.(
    new Response(
      JSON.stringify({
        traceId,
        runId: 'run_trace_target',
        truncated: false,
        nextCursor: null,
        spans: [
          {
            traceId,
            runId: 'run_trace_target',
            spanId,
            kind: 'run',
            name: 'Run',
            status: 'ok',
          },
        ],
      }),
      { status: 200 },
    ),
  );
  await pending;

  const store = bridge.getStore();
  assert.equal(store.runsById.run_background.status, 'failed');
  assert.equal(
    store.traceSpansById[`${traceId}:${spanId}`].runId,
    'run_trace_target',
  );
  bridge.dispose();
});
