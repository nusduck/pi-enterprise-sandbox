import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createEntityBridge } from '../src/features/chat/entityBridge.ts';
import { createEntityStore } from '../src/entities/index.ts';
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
