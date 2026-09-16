/**
 * 分层 Run 队列的拓扑与路由（ADR 0012 / 审查 R3）。
 *
 * R3 的现象：父子 Run 共用一个队列、一批消费槽。父任务前台等待子任务结果、
 * 自己不让出槽位，于是 N 个父 Run 占满 N 个槽之后子 Run 永远排不上——把并发
 * 调到任意有限值都有同样的饱和条件。这里钉住修复的三条性质：
 *
 * 1. 每个允许的深度都有**专属**消费槽，根任务拿不到深层的保留槽；
 * 2. 并发总预算是显式的一个数，不按层翻倍；
 * 3. 路由只看权威深度；越界深度拒绝，不夹到最深那层。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allocateReservedSlots,
  assertNoStrandedLayers,
  layerForDepth,
  planRunQueueTopology,
  queueNamesToProbe,
  routeRunToQueue,
  runQueueNameForDepth,
} from '../../src/infrastructure/redis/run-queue-topology.js';

/** 消费拓扑 = 路由拓扑 + 槽位分配。投递方只用前者。 */
function consumerTopology(maxDepth: number, totalConcurrency: number, base?: string) {
  return allocateReservedSlots(
    planRunQueueTopology({ maxDepth, ...(base !== undefined ? { baseQueueName: base } : {}) }),
    totalConcurrency,
  );
}

test('深度 → 队列名：0 沿用历史名字，深层加后缀', () => {
  assert.equal(runQueueNameForDepth(0), 'agent-runs');
  assert.equal(runQueueNameForDepth(1), 'agent-runs-d1');
  assert.equal(runQueueNameForDepth(2), 'agent-runs-d2');
  // 自定义基名（`AGENT_RUNS_QUEUE_NAME`）时深层从它派生。
  assert.equal(runQueueNameForDepth(0, 'pi-runs'), 'pi-runs');
  assert.equal(runQueueNameForDepth(2, 'pi-runs'), 'pi-runs-d2');
  assert.throws(() => runQueueNameForDepth(-1), /non-negative integer/);
  assert.throws(() => runQueueNameForDepth(1.5), /non-negative integer/);
});

test('路由拓扑不含并发——HTTP 进程只投递，不该被消费者的预算卡住', () => {
  const routing = planRunQueueTopology({ maxDepth: 2 });
  assert.equal(routing.totalConcurrency, null);
  assert.deepEqual(
    routing.layers.map((l) => l.queueName),
    ['agent-runs', 'agent-runs-d1', 'agent-runs-d2'],
  );
  // 路由拓扑照样能路由：队列名与深度的对应关系不依赖并发。
  assert.equal(routeRunToQueue(routing, 1), 'agent-runs-d1');
});

test('每层都有保留槽，总预算不按层翻倍', () => {
  // 执行方案里点名的例子：最大深度 2、总预算 4 → 2 / 1 / 1。
  const topology = consumerTopology(2, 4);
  assert.equal(topology.totalConcurrency, 4);
  assert.deepEqual(
    topology.layers.map((l) => [l.depth, l.queueName, l.concurrency]),
    [
      [0, 'agent-runs', 2],
      [1, 'agent-runs-d1', 1],
      [2, 'agent-runs-d2', 1],
    ],
  );
  // 分配之和必须正好等于预算——多一个槽就是悄悄扩容。
  assert.equal(
    topology.layers.reduce((sum, l) => sum + l.concurrency, 0),
    4,
  );
});

test('不允许子任务时只有一层，整份预算给根任务', () => {
  const topology = consumerTopology(0, 4);
  assert.deepEqual(
    topology.layers.map((l) => [l.depth, l.concurrency]),
    [[0, 4]],
  );
});

test('预算不足以给每层留一个槽时拒绝，而不是把某层降成 0 个消费者', () => {
  assert.throws(() => consumerTopology(2, 2), /at least 3 so every subagent depth/);
  // 刚好够的边界必须通过——不能靠「一律拒绝」假通过。
  const tight = consumerTopology(2, 3);
  assert.deepEqual(
    tight.layers.map((l) => l.concurrency),
    [1, 1, 1],
  );
});

test('非法配置拒绝', () => {
  assert.throws(() => planRunQueueTopology({ maxDepth: -1 }), /MAX_DEPTH/);
  assert.throws(() => consumerTopology(1, 0), /CONCURRENCY/);
  assert.throws(() => consumerTopology(1, 2.5), /positive integer/);
});

test('路由按权威深度选层；越界拒绝，不夹到最深那层', () => {
  const topology = consumerTopology(2, 4);
  assert.equal(routeRunToQueue(topology, 0), 'agent-runs');
  assert.equal(routeRunToQueue(topology, 1), 'agent-runs-d1');
  assert.equal(routeRunToQueue(topology, 2), 'agent-runs-d2');
  assert.throws(() => routeRunToQueue(topology, 3), /only serves 0\.\.2/);
  assert.equal(layerForDepth(topology, 3), undefined);
});

test('回滚闸门：本配置不服务的层里还有存量就拒绝启动，并点名队列与条数', () => {
  const shrunk = consumerTopology(1, 4);
  // 深度 2 的队列还有 7 个作业，而现在没人消费它。
  assert.throws(
    () => assertNoStrandedLayers(shrunk, { 'agent-runs': 3, 'agent-runs-d1': 1, 'agent-runs-d2': 7 }),
    /agent-runs-d2=7/,
  );
  // 空的不服务队列不阻断启动。
  assert.doesNotThrow(() =>
    assertNoStrandedLayers(shrunk, { 'agent-runs': 3, 'agent-runs-d1': 1, 'agent-runs-d2': 0 }),
  );
  // 服务中的队列有多少存量都不该拦启动——那正是它该消费的东西。
  assert.doesNotThrow(() => assertNoStrandedLayers(shrunk, { 'agent-runs': 999 }));
});

test('探测覆盖到配置之外的深层队列', () => {
  assert.deepEqual(queueNamesToProbe(2), ['agent-runs', 'agent-runs-d1', 'agent-runs-d2']);
  assert.deepEqual(queueNamesToProbe(1, 'pi-runs'), ['pi-runs', 'pi-runs-d1']);
});
