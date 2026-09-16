/**
 * 唯一 enqueue 入口的路由规则（ADR 0012 / 审查 R3）。
 *
 * 五条投递路径（普通创建、cron、子任务、审批/交互恢复、失败恢复）都经过
 * `ServiceContainer.createRunQueueAdapter()`，所以规则只需要在这一处钉住：
 * **按 MySQL 里的权威 `subagent_depth` 选队列**，不看调用方给的任何提示。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildRunQueueAdapter,
  resolveRunDepth,
  resolveSubagentMaxDepth,
  resolveWorkerConcurrency,
  startLayeredRunQueues,
} from '../../src/bootstrap/container-run-queue.js';
import {
  allocateReservedSlots,
  planRunQueueTopology,
} from '../../src/infrastructure/redis/run-queue-topology.js';

/** 最小 knex 替身：只答 `runs` 表按主键的那一条查询。 */
function fakeKnex(rows: Record<string, { subagent_depth: number }>): any {
  return (table: string) => {
    assert.equal(table, 'runs');
    let key = '';
    const builder = {
      select: () => builder,
      where: (w: Record<string, string>) => {
        key = `${w.run_id}|${w.org_id}`;
        return builder;
      },
      first: async () => rows[key] ?? undefined,
    };
    return builder;
  };
}

const TOPOLOGY = planRunQueueTopology({ maxDepth: 2 });

function handlesFor(names: string[]): Map<number, any> {
  const handles = new Map<number, any>();
  names.forEach((queueName, depth) => {
    handles.set(depth, { queue: { name: queueName } });
  });
  return handles;
}

test('按权威深度投递到对应的层', async () => {
  const seen: { queue: string; ref: any }[] = [];
  const adapter = buildRunQueueAdapter({
    handles: handlesFor(['agent-runs', 'agent-runs-d1', 'agent-runs-d2']),
    topology: TOPOLOGY,
    knex: fakeKnex({
      'run_root|org_1': { subagent_depth: 0 },
      'run_child|org_1': { subagent_depth: 1 },
      'run_grandchild|org_1': { subagent_depth: 2 },
    }),
    enqueueRunJob: async (queue, ref) => {
      seen.push({ queue: queue.name, ref });
      return { id: ref.runId };
    },
  });

  await adapter.enqueue({ runId: 'run_root', orgId: 'org_1', traceId: 't' });
  await adapter.enqueue({ runId: 'run_child', orgId: 'org_1', traceId: 't' });
  await adapter.enqueue({ runId: 'run_grandchild', orgId: 'org_1', traceId: 't' });

  assert.deepEqual(
    seen.map((s) => s.queue),
    ['agent-runs', 'agent-runs-d1', 'agent-runs-d2'],
  );
});

test('调用方给的队列提示不影响路由——权威只有 MySQL 的深度', async () => {
  let landed = '';
  const adapter = buildRunQueueAdapter({
    handles: handlesFor(['agent-runs', 'agent-runs-d1', 'agent-runs-d2']),
    topology: TOPOLOGY,
    knex: fakeKnex({ 'run_child|org_1': { subagent_depth: 1 } }),
    enqueueRunJob: async (queue) => {
      landed = queue.name;
    },
  });
  await adapter.enqueue({
    runId: 'run_child',
    orgId: 'org_1',
    traceId: 't',
    // 这两个字段都是「提示」，都不该被采信。
    queueName: 'agent-runs',
    subagentDepth: 0,
  } as any);
  assert.equal(landed, 'agent-runs-d1');
});

test('queueNameFor 与 enqueue 的目的地一致——账本与实际不分叉', async () => {
  let landed = '';
  const adapter = buildRunQueueAdapter({
    handles: handlesFor(['agent-runs', 'agent-runs-d1', 'agent-runs-d2']),
    topology: TOPOLOGY,
    knex: fakeKnex({ 'run_child|org_1': { subagent_depth: 2 } }),
    enqueueRunJob: async (queue) => {
      landed = queue.name;
    },
  });
  const ref = { runId: 'run_child', orgId: 'org_1', traceId: 't' };
  const declared = await adapter.queueNameFor(ref);
  await adapter.enqueue(ref);
  assert.equal(declared, landed);
  assert.equal(declared, 'agent-runs-d2');
});

test('查不到 Run 时拒绝投递，不猜成深度 0 抢根任务的槽', async () => {
  const adapter = buildRunQueueAdapter({
    handles: handlesFor(['agent-runs', 'agent-runs-d1', 'agent-runs-d2']),
    topology: TOPOLOGY,
    knex: fakeKnex({}),
    enqueueRunJob: async () => assert.fail('must not enqueue an unknown run'),
  });
  await assert.rejects(
    () => adapter.enqueue({ runId: 'run_missing', orgId: 'org_1', traceId: 't' }),
    /refusing to guess its queue depth/,
  );
});

test('越界深度拒绝投递，不夹到最深那层', async () => {
  const adapter = buildRunQueueAdapter({
    handles: handlesFor(['agent-runs', 'agent-runs-d1', 'agent-runs-d2']),
    topology: TOPOLOGY,
    knex: fakeKnex({ 'run_deep|org_1': { subagent_depth: 5 } }),
    enqueueRunJob: async () => assert.fail('must not enqueue beyond the served depth'),
  });
  await assert.rejects(
    () => adapter.enqueue({ runId: 'run_deep', orgId: 'org_1', traceId: 't' }),
    /only serves 0\.\.2/,
  );
});

test('resolveRunDepth 要求 runId 与 orgId，跨租户不会误读别人的行', async () => {
  const knex = fakeKnex({ 'run_a|org_1': { subagent_depth: 1 } });
  assert.equal(await resolveRunDepth(knex, { runId: 'run_a', orgId: 'org_1' }), 1);
  await assert.rejects(
    () => resolveRunDepth(knex, { runId: 'run_a', orgId: 'org_2' }),
    /not found/,
  );
  await assert.rejects(() => resolveRunDepth(knex, { runId: 'run_a' }), /requires runId and orgId/);
});

test('装配：按拓扑逐层建队列，深度 0 沿用历史名字', () => {
  const created: { queueName: string; prefix?: string }[] = [];
  const { topology, handles } = startLayeredRunQueues({
    env: { AGENT_SUBAGENT_MAX_DEPTH: '1', AGENT_WORKER_CONCURRENCY: '3' },
    createRunQueue: (_url: string, opts: any) => {
      created.push({ queueName: opts.queueName, prefix: opts.prefix });
      return { queue: { name: opts.queueName } };
    },
    planRunQueueTopology,
    redisUrl: 'redis://localhost:6379/0',
  });
  assert.deepEqual(
    created.map((c) => c.queueName),
    ['agent-runs', 'agent-runs-d1'],
  );
  // 装配只算**路由**；并发由消费者侧的 `allocateReservedSlots()` 另外分配。
  assert.equal(topology.totalConcurrency, null);
  assert.deepEqual(
    allocateReservedSlots(topology, 3).layers.map((l) => l.concurrency),
    [2, 1],
  );
  assert.equal(handles.size, 2);
});

test('环境解析：缺省取内置值，非法值不静默变成别的数', () => {
  assert.equal(resolveSubagentMaxDepth({}), 2);
  assert.equal(resolveSubagentMaxDepth({ AGENT_SUBAGENT_MAX_DEPTH: '0' }), 0);
  assert.equal(resolveSubagentMaxDepth({ AGENT_SUBAGENT_MAX_DEPTH: 'nope' }), 2);
  assert.equal(resolveWorkerConcurrency({}), 4);
  assert.equal(resolveWorkerConcurrency({ AGENT_WORKER_CONCURRENCY: '8' }), 8);
  assert.equal(resolveWorkerConcurrency({ AGENT_WORKER_CONCURRENCY: '0' }), 4);
});
