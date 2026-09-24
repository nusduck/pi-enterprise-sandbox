/**
 * R3 的**真实 BullMQ** 槽位饥饿实验（审查 2026-09-16 / ADR 0012）。
 *
 * 这不是「拓扑函数算得对不对」——那由 `run-queue-topology.unit.test.ts` 覆盖。
 * 这里要在真的 Redis + 真的 BullMQ Worker 上证明两件事：
 *
 * 1. **旧形态确实会饿死**：父子同队列时，父任务占满全部槽并前台等待子任务，
 *    子任务永远排不上，整个队列停住。这是修复前的基线，必须真的复现，
 *    否则「修好了」无从谈起。
 * 2. **分层 + 保留槽之后能推进**：同样的总并发预算、同样的饱和条件下，
 *    子任务拿到它那一层的保留槽，父任务因此能完成——不需要扩容、不需要
 *    取消父任务、也不需要等预算耗尽。
 *
 * 用真实队列与真实消费者；只有「执行什么」是受控的屏障（父任务等子任务，
 * 子任务立刻完成），因为这里要验的是**调度**，不是模型。
 *
 * 门禁：`TEST_REDIS_URL`。缺省跳过，离线 CI 仍绿。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import {
  allocateReservedSlots,
  planRunQueueTopology,
} from '../../src/infrastructure/redis/run-queue-topology.js';

/** 消费拓扑 = 路由拓扑 + 槽位分配（ADR 0012）。 */
const consumerTopology = (maxDepth, totalConcurrency) =>
  allocateReservedSlots(planRunQueueTopology({ maxDepth }), totalConcurrency);

const TEST_URL = process.env.TEST_REDIS_URL || '';
const require = createRequire(import.meta.url);

function bullmqAvailable() {
  try {
    require.resolve('bullmq');
    require.resolve('ioredis');
    return true;
  } catch {
    return false;
  }
}

const enabled = Boolean(TEST_URL.trim()) && bullmqAvailable();
const describeLive = enabled ? describe : describe.skip;

/** 一次实验的隔离命名空间：hash tag 让同队列的 key 落同一 slot。 */
function uniquePrefix() {
  return `{dsh-r3-${randomBytes(4).toString('hex')}}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('R3 subagent slot starvation gate', () => {
  it('documents skip conditions when TEST_REDIS_URL or bullmq are missing', () => {
    if (!enabled) {
      assert.ok(true, 'skipped: set TEST_REDIS_URL and install bullmq/ioredis to run');
    } else {
      assert.ok(true);
    }
  });
});

describeLive('R3 subagent slot starvation (real BullMQ)', () => {
  const teardown = [];
  after(async () => {
    for (const fn of teardown.reverse()) await fn().catch(() => undefined);
  });

  /**
   * 建一组消费者：父作业执行时**前台等待**自己的子作业完成，子作业立刻完成。
   * 这正是 `durable-subagent` provider 今天的等待形态（父不让出槽位）。
   *
   * @param layers 每层 `{ queueName, concurrency }`
   * @param routeChild 子作业投到哪个队列名
   */
  async function runExperiment({ prefix, layers, routeChild, parents, budgetMs }) {
    const { Queue, Worker } = require('bullmq');
    const connection = { url: TEST_URL };
    const queues = new Map();
    for (const layer of layers) {
      const q = new Queue(layer.queueName, { connection, prefix });
      q.on('error', () => undefined);
      queues.set(layer.queueName, q);
      teardown.push(() => q.obliterate({ force: true }).catch(() => undefined));
      teardown.push(() => q.close());
    }

    const childDone = new Map();
    const finishedParents = [];
    const finishedChildren = [];

    const workers = layers.map((layer) => {
      const w = new Worker(
        layer.queueName,
        async (job) => {
          if (job.data.kind === 'child') {
            finishedChildren.push(job.data.id);
            childDone.get(job.data.parentId)?.resolve();
            return 'child-done';
          }
          // 父任务：投出子作业，然后**前台等待**它——不让出这个消费槽。
          let resolve;
          const waited = new Promise((r) => {
            resolve = r;
          });
          childDone.set(job.data.id, { resolve });
          await queues.get(routeChild).add('execute', {
            kind: 'child',
            id: `${job.data.id}-c`,
            parentId: job.data.id,
          });
          await waited;
          finishedParents.push(job.data.id);
          return 'parent-done';
        },
        { connection, prefix, concurrency: layer.concurrency },
      );
      w.on('error', () => undefined);
      // **强制关闭**（`close(true)`）：基线用例里的父作业永远等不到子作业，
      // 默认的优雅关闭会一直等这个在途作业，测试进程就再也退不出来了。
      teardown.push(() => w.close(true));
      return w;
    });
    await Promise.all(workers.map((w) => w.waitUntilReady()));

    const rootQueue = queues.get(layers[0].queueName);
    for (let i = 0; i < parents; i += 1) {
      await rootQueue.add('execute', { kind: 'parent', id: `p${i}` });
    }

    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline && finishedParents.length < parents) {
      await sleep(100);
    }
    const observed = {
      finishedParents: [...finishedParents],
      finishedChildren: [...finishedChildren],
    };
    // 先把还在等的父作业放掉，再让 after 去关消费者——不留任何永远挂着的
    // 在途作业。观测值已经在上面快照过，放掉不影响断言。
    for (const waiter of childDone.values()) waiter.resolve();
    await sleep(50);
    return observed;
  }

  it('旧形态：父子同队列时，占满槽位的父任务把队列饿死', async () => {
    // 总预算 2、两个父任务 → 两个槽全被前台等待的父任务占住。
    const result = await runExperiment({
      prefix: uniquePrefix(),
      layers: [{ queueName: 'agent-runs', concurrency: 2 }],
      routeChild: 'agent-runs',
      parents: 2,
      budgetMs: 6_000,
    });
    assert.equal(
      result.finishedChildren.length,
      0,
      'baseline must starve: no child may run while both slots are held by waiting parents',
    );
    assert.equal(result.finishedParents.length, 0, 'baseline must starve: no parent completes');
  });

  it('分层 + 保留槽：同样的预算与饱和条件下，子任务拿到专属槽，队列继续推进', async () => {
    // 同一个总预算 2，按 ADR 0012 分成 depth0=1 / depth1=1。
    const topology = consumerTopology(1, 2);
    assert.deepEqual(
      topology.layers.map((l) => [l.queueName, l.concurrency]),
      [
        ['agent-runs', 1],
        ['agent-runs-d1', 1],
      ],
    );
    const result = await runExperiment({
      prefix: uniquePrefix(),
      layers: topology.layers.map((l) => ({
        queueName: l.queueName,
        concurrency: l.concurrency,
      })),
      routeChild: 'agent-runs-d1',
      parents: 2,
      budgetMs: 20_000,
    });
    assert.equal(result.finishedChildren.length, 2, 'both children must be consumed');
    assert.equal(
      result.finishedParents.length,
      2,
      'both parents must finish without extra capacity, cancellation, or budget exhaustion',
    );
  });

  it('深度 1 全部等待深度 2 时仍可完成（有限深度的保留槽逐层生效）', async () => {
    // 预算 3、最大深度 2 → 1 / 1 / 1。depth0 的父等 depth1，depth1 又等 depth2。
    const topology = consumerTopology(2, 3);
    const { Queue, Worker } = require('bullmq');
    const prefix = uniquePrefix();
    const connection = { url: TEST_URL };
    const queues = new Map();
    for (const layer of topology.layers) {
      const q = new Queue(layer.queueName, { connection, prefix });
      q.on('error', () => undefined);
      queues.set(layer.depth, q);
      teardown.push(() => q.obliterate({ force: true }).catch(() => undefined));
      teardown.push(() => q.close());
    }
    const waiters = new Map();
    const finished = [];
    const workers = topology.layers.map((layer) => {
      const w = new Worker(
        layer.queueName,
        async (job) => {
          const depth = job.data.depth;
          if (depth < topology.maxDepth) {
            // 还能往下生：投一个更深的子任务并前台等它。
            let resolve;
            const waited = new Promise((r) => {
              resolve = r;
            });
            waiters.set(job.data.id, { resolve });
            await queues.get(depth + 1).add('execute', {
              depth: depth + 1,
              id: `${job.data.id}.c`,
              parentId: job.data.id,
            });
            await waited;
          }
          finished.push(job.data.id);
          if (job.data.parentId) waiters.get(job.data.parentId)?.resolve();
          return 'done';
        },
        { connection, prefix, concurrency: layer.concurrency },
      );
      w.on('error', () => undefined);
      teardown.push(() => w.close(true));
      return w;
    });
    await Promise.all(workers.map((w) => w.waitUntilReady()));
    await queues.get(0).add('execute', { depth: 0, id: 'root' });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !finished.includes('root')) {
      await sleep(100);
    }
    assert.deepEqual(
      finished,
      ['root.c.c', 'root.c', 'root'],
      'the whole chain must drain bottom-up on reserved slots',
    );
  });
});
