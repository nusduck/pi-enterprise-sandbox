/**
 * ADR 0009 D6 / 计划 H5：子 Agent 的 durable 面接到 `SubagentSpawnService`。
 *
 * ## 这条链在 2026-08-31 之前也是断的
 *
 * `SubagentSpawnService` 做的是真 durable 的事（锁父 Run、数活兄弟、建子 Run、
 * 入 BullMQ），但它挂在 `container-run-executor.ts` 的 `subagentSpawnPort` 上，
 * 而那个 port **只喂给 `extensionBundleFactory`**——一条终止在被
 * `runtime-factory.create()` 忽略的参数上的死链（那个文件自己的注释里就写着）。
 *
 * 与此同时 `durable-subagent.ts` 的 provider 用的是 `InMemoryDurableSubagentQueue`：
 * Worker 一重启，子 Run 全丢——正是那个 provider 文件头说要避免的事。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRunServices,
} from '../../src/application/durable-subagent-port.js';
import {
  createDurableSubagentProvider,
  InMemoryDurableSubagentQueue,
  InMemoryDurableSubagentStore,
} from '../../src/runtime/providers/durable-subagent.js';
import { runWithRunServices } from '../../src/runtime/providers/run-services.js';

function fakeSpawnPort() {
  const spawned: Array<Record<string, unknown>> = [];
  let status = 'RUNNING';
  return {
    spawned,
    setStatus: (s: string) => {
      status = s;
    },
    port: {
      async spawn(input: Record<string, unknown>) {
        spawned.push(input);
        return { childRunId: 'child-run-1' };
      },
      async getStatuses() {
        return [{ runId: 'child-run-1', status, resultSummary: 'done well' }];
      },
    },
  };
}

function providerWithFallback() {
  return createDurableSubagentProvider({
    name: 'spawn',
    // 兜底实现——**生产路径不该走到它**。这里留着是为了让下面那条
    // 「没有 Run 作用域时才回退」的用例能对比出差别。
    queue: new InMemoryDurableSubagentQueue(),
    store: new InMemoryDurableSubagentStore(),
    tenantOf: () => ({ orgId: 'org-1', userId: 'user-1', parentSessionId: 's1' }),
    generateId: () => 'job-1',
  });
}

function startRequest() {
  return {
    parent: {},
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'go do the thing' }] }],
    signal: new AbortController().signal,
    label: 'child',
  } as never;
}

test('H5 在 Run 作用域内，start() 走 durable spawn 而不是进程内队列', async () => {
  const { port, spawned } = fakeSpawnPort();
  const provider = providerWithFallback();

  const run = await runWithRunServices(
    buildRunServices({ spawnPort: port, parentRunId: 'parent-run', tenant: { orgId: 'org-1', userId: 'user-1' } }),
    async () => provider.start(startRequest()),
  );

  assert.equal(spawned.length, 1, '必须落到 durable spawn——进程内队列 Worker 一重启就丢');
  assert.equal(spawned[0]?.['parentRunId'], 'parent-run');
  assert.equal(spawned[0]?.['orgId'], 'org-1');
  assert.equal(spawned[0]?.['task'], 'go do the thing', 'prompt 的文本要转成 durable 面要的任务串');
  assert.equal(spawned[0]?.['toolCallId'], 'job-1', 'jobId 当幂等键：重复入队只得到同一个子 Run');
  await run.dispose();
});

test('H5 结果按子 Run 的终态兑现，未到终态时不返回', async () => {
  const { port, setStatus } = fakeSpawnPort();
  const provider = providerWithFallback();
  const services = buildRunServices({
    spawnPort: port,
    parentRunId: 'parent-run',
    tenant: { orgId: 'org-1', userId: 'user-1' },
  });

  await runWithRunServices(services, async () => {
    const run = await provider.start(startRequest());
    // 子 Run 还在跑：结果不该出来。
    assert.equal(await services.subagents.store.getResult('job-1'), null);
    setStatus('SUCCEEDED');
    const done = (await services.subagents.store.getResult('job-1')) as unknown as {
      output: Array<{ text: string }>;
      stopReason: string;
    } | null;
    assert.notEqual(done, null, '子 Run 到终态后必须能取到结果');
    assert.equal(done?.stopReason, 'end_turn');
    assert.match(String(done?.output?.[0]?.text), /done well/);
    await run.dispose();
  });
});

test('H5 没有 Run 作用域时才回退到进程内实现（单测路径，不是生产路径）', async () => {
  const { port, spawned } = fakeSpawnPort();
  const provider = providerWithFallback();
  const run = await provider.start(startRequest());
  assert.equal(spawned.length, 0, 'ALS 外不该碰 durable 面');
  await run.dispose();
  void port;
});
