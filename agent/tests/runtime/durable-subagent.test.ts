/**
 * durable-subagent 单测——决定与执行分离，纯函数不依赖 BullMQ。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDurableJobSpec, createDurableSubagentProvider, InMemoryDurableSubagentQueue, InMemoryDurableSubagentStore } from '../../src/runtime/providers/durable-subagent.js';

function fakeSignal(aborted = false): AbortSignal {
  const c = new AbortController();
  if (aborted) c.abort();
  return c.signal;
}

test('buildDurableJobSpec 规整 prompt 与 tenant', () => {
  const spec = buildDurableJobSpec(
    { prompt: [{ type: 'text', text: 'hi' } as unknown as never], parent: {} as never, signal: fakeSignal() },
    { orgId: 'o1', userId: 'u1', parentSessionId: 's1' },
    { now: () => 1000, generateId: () => 'sub_abc' },
  );
  assert.equal(spec.jobId, 'sub_abc');
  assert.equal(spec.tenant.orgId, 'o1');
  assert.equal(spec.prompt.length, 1);
});

test('空 prompt 抛错', () => {
  assert.throws(() =>
    buildDurableJobSpec(
      { prompt: [] as never, parent: {} as never, signal: fakeSignal() } as never,
      { orgId: 'o', userId: 'u', parentSessionId: 's' },
    ),
  );
});

test('maxDepth 非负整数校验', () => {
  assert.throws(() =>
    buildDurableJobSpec(
      { prompt: [{ type: 'text', text: 'x' } as never], parent: {} as never, signal: fakeSignal(), maxDepth: -1 as never } as never,
      { orgId: 'o', userId: 'u', parentSessionId: 's' },
    ),
  );
});

test('已 abort 的信号抛错', () => {
  assert.throws(() =>
    buildDurableJobSpec(
      { prompt: [{ type: 'text', text: 'x' } as never], parent: {} as never, signal: fakeSignal(true) } as never,
      { orgId: 'o', userId: 'u', parentSessionId: 's' },
    ),
  );
});

test('provider start 入队并可通过 store 兑现结果', async () => {
  const queue = new InMemoryDurableSubagentQueue();
  const store = new InMemoryDurableSubagentStore();
  const provider = createDurableSubagentProvider({
    queue,
    store,
    tenantOf: () => ({ orgId: 'o', userId: 'u', parentSessionId: 's' }),
    now: () => 1,
    generateId: () => 'jid1',
  });

  const signal = fakeSignal();
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'do' } as never],
    parent: {} as never,
    signal,
    descriptor: {} as never,
  } as never);

  assert.equal(queue.specs.length, 1);
  assert.equal(run.localAgent, undefined);
  // 模拟 Worker 完成
  await store.putResult('jid1', { output: [], stopReason: 'completed' } as never);
  const result = await run.result;
  assert.equal((result as unknown as { stopReason: string }).stopReason, 'completed');
  await run.dispose();
});

test('trusted same-process 差异：请求被序列化为平面 jobSpec，不含 Agent 活对象', async () => {
  const queue = new InMemoryDurableSubagentQueue();
  const store = new InMemoryDurableSubagentStore();
  const provider = createDurableSubagentProvider({
    queue,
    store,
    tenantOf: () => ({ orgId: 'o', userId: 'u', parentSessionId: 's' }),
    generateId: () => 'jid2',
  });
  const run = await provider.start({
    prompt: [{ type: 'text', text: 'x' } as never],
    parent: { session: { id: 'live-agent-object' } } as never,
    signal: fakeSignal(),
    descriptor: {} as never,
  } as never);
  const spec = queue.specs[0]!;
  // spec 中不应包含 parent 活对象，只含 tenant 平面字段
  assert.equal((spec as unknown as Record<string, unknown>)['parent' as string], undefined);
  assert.ok(Array.isArray(spec.prompt));
  assert.equal(run.localAgent, undefined);
  await run.dispose();
});
