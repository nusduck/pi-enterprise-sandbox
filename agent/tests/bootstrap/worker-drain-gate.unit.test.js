/**
 * Worker 缩深闸门（ADR 0012；2026-09-16 修复后复核 F2 / F3）。
 *
 * F2：读 Redis 失败曾被当成「队列为空」放行——之后 Redis 恢复、依赖探针变绿，
 *     不会重做被跳过的检查，遗留层永远没人消费。
 * F3：只查 Redis 不够。子 Run 停在 WAITING_APPROVAL / WAITING_INPUT 时队列里
 *     没有作业，但 MySQL 里仍是非终态；缩深放行后，审批/应答恢复入队会被
 *     `routeRunToQueue` 拒绝。
 *
 * 全部经 `startWorkerMain` 这条生产入口验证，并断言**拒启时没有任何消费者、
 * 恢复扫描或 outbox 被启动**；每个拒绝都配一个合法放行的对照。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerMain } from '../../src/bootstrap/worker-main.js';

const ENV = {
  AGENT_DATABASE_URL: 'mysql://u:p@h/db',
  AGENT_REDIS_URL: 'redis://localhost:6379/0',
  AGENT_ALLOW_STUB_EXECUTOR: 'true',
  NODE_ENV: 'development',
};

/** 缩深后的拓扑：只服务 0..1，深度 2 的层已不再消费。 */
const SHRUNK = {
  maxDepth: 1,
  totalConcurrency: null,
  layers: [
    { depth: 0, queueName: 'agent-runs', concurrency: 0 },
    { depth: 1, queueName: 'agent-runs-d1', concurrency: 0 },
  ],
};

/**
 * 记录查询形状的最小 knex 替身：`knex('runs').whereIn().where().groupBy().select().count()`
 * 可 await，结果由 `rows` 决定（或抛 `error`）。
 */
function fakeKnex({ rows = [], error } = {}) {
  const calls = [];
  const knex = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const builder = {
      then(resolve, reject) {
        return (error ? Promise.reject(error) : Promise.resolve(rows)).then(resolve, reject);
      },
    };
    for (const op of ['whereIn', 'where', 'andWhere', 'groupBy', 'select', 'count']) {
      builder[op] = (...args) => {
        q.ops.push([op, ...args]);
        return builder;
      };
    }
    return builder;
  };
  knex.raw = async () => [[{}]];
  knex.calls = calls;
  return knex;
}

function fakeContainer({ redis, knex, topology = SHRUNK }) {
  const started = { workerServices: 0, shutdowns: 0 };
  const container = {
    env: {},
    redis,
    knex,
    runQueueTopology: topology,
    // Worker 在消费前问 session-turn-gate：替身只需提供会话锁的读接口。
    createSessionLockManager: async () => ({ getOwner: async () => null }),
    async start() {
      return this;
    },
    async createWorkerServices() {
      started.workerServices += 1;
      return {
        workerRuntime: {
          async processJob() {},
          async start() {},
          async shutdown() {},
          isStarted: () => true,
          isShutdown: () => false,
        },
        recoveryService: {
          async scanAndRequeue() {
            return { actions: [] };
          },
        },
      };
    },
    async createOutboxPublisher() {
      return { publishOnce: async () => ({}) };
    },
    async shutdown() {
      started.shutdowns += 1;
    },
  };
  return { container, started };
}

const emptyRedis = { type: async () => 'none' };

async function start(container) {
  let consumers = 0;
  const outcome = startWorkerMain(ENV, {
    createContainer: () => container,
    startProbeServer: async () => ({ listening: false }),
    createRunWorker: () => {
      consumers += 1;
      throw new Error('gate passed: consumer creation reached');
    },
  });
  return { outcome, consumers: () => consumers };
}

describe('worker drain gate', () => {
  it('F2: Redis 读取失败时拒启，而不是当成空队列放行', async () => {
    const redis = {
      type: async () => {
        throw new Error('READONLY You can\'t write against a read only replica');
      },
    };
    const { container, started } = fakeContainer({ redis, knex: fakeKnex() });
    const run = await start(container);
    await assert.rejects(run.outcome, /cannot verify.*agent-runs-d2/i);
    assert.equal(run.consumers(), 0, 'no consumer may start when the drain check could not run');
    assert.equal(started.workerServices, 0, 'recovery/outbox must not start before the gate');
    assert.ok(started.shutdowns >= 1, 'container is shut down on refusal');
  });

  it('F2: 不认识的 key 类型同样拒启（不能证明为空）', async () => {
    const redis = { type: async () => 'hash' };
    const { container } = fakeContainer({ redis, knex: fakeKnex() });
    const run = await start(container);
    await assert.rejects(run.outcome, /cannot verify/i);
    assert.equal(run.consumers(), 0);
  });

  it('Redis 队列有存量时拒启并点名（既有行为保留）', async () => {
    const redis = {
      type: async (key) => (key.endsWith(':agent-runs-d2:wait') ? 'list' : 'none'),
      llen: async () => 3,
    };
    const { container } = fakeContainer({ redis, knex: fakeKnex() });
    const run = await start(container);
    await assert.rejects(run.outcome, /agent-runs-d2=3/);
    assert.equal(run.consumers(), 0);
  });

  it('F3: MySQL 里有超出目标深度的非终态 Run（队列为空）时拒启，并点名深度与条数', async () => {
    const knex = fakeKnex({ rows: [{ subagent_depth: 2, n: '2' }] });
    const { container } = fakeContainer({ redis: emptyRedis, knex });
    const run = await start(container);
    await assert.rejects(run.outcome, /depth 2=2/);
    assert.equal(run.consumers(), 0);

    // 查询形状：权威账本 runs 表、非终态全集（含 WAITING_*）、只看超出目标深度的层。
    const q = knex.calls.find((c) => c.table === 'runs');
    assert.ok(q, 'gate must read the runs ledger');
    const whereIn = q.ops.find(([op]) => op === 'whereIn');
    assert.equal(whereIn[1], 'status');
    for (const status of ['WAITING_APPROVAL', 'WAITING_INPUT', 'QUEUED', 'RUNNING', 'RETRYING']) {
      assert.ok(whereIn[2].includes(status), `non-terminal set must include ${status}`);
    }
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
      assert.ok(!whereIn[2].includes(status), `terminal ${status} must not block`);
    }
    assert.deepEqual(q.ops.find(([op]) => op === 'where'), ['where', 'subagent_depth', '>', 1]);
  });

  it('F3: 读 MySQL 失败时拒启', async () => {
    const knex = fakeKnex({ error: new Error('ER_LOCK_WAIT_TIMEOUT') });
    const { container } = fakeContainer({ redis: emptyRedis, knex });
    const run = await start(container);
    await assert.rejects(run.outcome, /cannot verify.*runs/i);
    assert.equal(run.consumers(), 0);
  });

  it('对照：队列为空且账本里没有超深的非终态 Run → 放行到消费者创建', async () => {
    const { container, started } = fakeContainer({ redis: emptyRedis, knex: fakeKnex({ rows: [] }) });
    const run = await start(container);
    await assert.rejects(run.outcome, /gate passed/);
    assert.ok(run.consumers() >= 1, 'consumers are created once the gate passes');
    assert.equal(started.workerServices, 1);
  });
});
