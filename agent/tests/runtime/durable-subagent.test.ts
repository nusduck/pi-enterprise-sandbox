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

// ── R5 回归：轮询的监听器基线与退避（2026-09-16 审查） ───────────────
//
// 审查时的现象：每一轮等待都新增一个 `{ once: true }` 的 abort 监听器，
// 而 `once` 只在 abort 真的发生时才摘——正常轮询完成、dispose 都不清理。
// 探针跑五轮后仍留着 5 个监听器；等一分钟约积累 1200 个。同时 50 ms 的
// 定频轮询让每个等待中的父任务恒定产生约 20 次/秒的数据库事务。

function pollingProvider(resolveAfter: number, opts: { onQuery?: () => void } = {}) {
  let reads = 0;
  return createDurableSubagentProvider({
    queue: { add: async () => undefined },
    store: {
      putResult: async () => undefined,
      getResult: async () => {
        reads += 1;
        opts.onQuery?.();
        return reads >= resolveAfter ? ({ output: [], stopReason: 'completed' } as never) : null;
      },
    },
    tenantOf: () => ({ orgId: 'o', userId: 'u', parentSessionId: 's' }),
  });
}

test('R5: 轮询结束后 abort 监听器回到基线', async () => {
  const { getEventListeners } = await import('node:events');
  const controller = new AbortController();
  const provider = pollingProvider(4);
  const before = getEventListeners(controller.signal, 'abort').length;
  const run = await provider.start({
    parent: { id: 'p' } as never,
    prompt: [{ type: 'text', text: 'probe' } as never],
    signal: controller.signal,
  } as never);
  const result = await run.result;
  await run.dispose();
  assert.equal(result.stopReason, 'completed');
  assert.equal(
    getEventListeners(controller.signal, 'abort').length,
    before,
    'every poll must remove the abort listener it registered',
  );
});

test('R5: 取消立刻唤醒，不等下一个轮询周期，并且不留监听器', async () => {
  const { getEventListeners } = await import('node:events');
  const controller = new AbortController();
  // 永远不返回结果：唯一的出口是取消。
  const provider = pollingProvider(Number.MAX_SAFE_INTEGER, {
    onQuery: () => {
      // 第一次查询之后就取消——此时 provider 正准备进入 200 ms 的等待。
      queueMicrotask(() => controller.abort());
    },
  });
  const started = Date.now();
  const run = await provider.start({
    parent: { id: 'p' } as never,
    prompt: [{ type: 'text', text: 'probe' } as never],
    signal: controller.signal,
  } as never);
  const result = await run.result;
  await run.dispose();
  assert.equal(result.stopReason, 'aborted');
  assert.ok(Date.now() - started < 1_000, 'cancellation must not wait out the backoff');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('R5: 轮询有界退避——固定等待时长内的查询次数远低于定频', async () => {
  const controller = new AbortController();
  let queries = 0;
  const provider = pollingProvider(Number.MAX_SAFE_INTEGER, {
    onQuery: () => {
      queries += 1;
    },
  });
  const run = await provider.start({
    parent: { id: 'p' } as never,
    prompt: [{ type: 'text', text: 'probe' } as never],
    signal: controller.signal,
  } as never);
  await new Promise((r) => setTimeout(r, 1_000));
  controller.abort();
  await run.result;
  await run.dispose();
  // 改前：50 ms 定频 → 1 秒约 20 次。改后：200/400/800/1600… → ≤4 次。
  assert.ok(queries <= 6, `expected bounded backoff, got ${queries} store queries in 1s`);
  assert.ok(queries >= 2, `provider must actually poll, got ${queries}`);
});
