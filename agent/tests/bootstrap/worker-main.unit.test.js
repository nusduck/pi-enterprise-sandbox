/**
 * Worker main fatal consumer failure (offline DI).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerMain } from '../../src/bootstrap/worker-main.js';
import { createStubRunExecutor } from '../../src/application/run-executor.js';

/**
 * 缩深闸门（worker-drain-gate）会读 `runs` 账本；这些用例只关心闸门之后的
 * 消费者装配，所以给一个「没有超深非终态 Run」的最小 knex 替身。
 */
function emptyLedger() {
  const builder = {
    then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
  };
  for (const op of ['whereIn', 'where', 'groupBy', 'select', 'count']) builder[op] = () => builder;
  const knex = () => builder;
  knex.raw = async () => [[{}]];
  return knex;
}

describe('startWorkerMain', () => {
  it('fails fatally when BullMQ consumer cannot start and cleans up', async () => {
    let shutdowns = 0;
    const fakeContainer = {
      env: {},
      // 缩深闸门只在配置**不服务**的层上查 key，探测会扫到 d8，全部返回「不存在」；
      // 账本里也没有超深的非终态 Run。
      redis: { type: async () => 'none' },
      knex: emptyLedger(),
      // Worker 在消费前问 session-turn-gate：替身只需提供会话锁的读接口。
      createSessionLockManager: async () => ({ getOwner: async () => null }),
      // 分层拓扑（ADR 0012）：消费者按层建，容器必须把拓扑交出来。
      runQueueTopology: {
        maxDepth: 0,
        totalConcurrency: 1,
        layers: [{ depth: 0, queueName: 'agent-runs', concurrency: 1 }],
      },
      async start() {
        return this;
      },
      async createWorkerServices() {
        return {
          workerRuntime: {
            async processJob() {},
            async start() {},
            async shutdown() {
              shutdowns += 1;
            },
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
        shutdowns += 1;
      },
    };

    await assert.rejects(
      () =>
        startWorkerMain(
          {
            AGENT_DATABASE_URL: 'mysql://u:p@h/db',
            AGENT_REDIS_URL: 'redis://localhost:6379/0',
            AGENT_ALLOW_STUB_EXECUTOR: 'true',
            NODE_ENV: 'development',
          },
          {
            createContainer: () => fakeContainer,
            startProbeServer: async () => ({ listening: false }),
            createRunWorker: () => {
              throw new Error('bullmq missing');
            },
          },
        ),
      /bullmq missing/,
    );
    assert.ok(shutdowns >= 1);
  });

  it('pre-injected factory is available; production without inject still needs ensure after start', async () => {
    const { createServiceContainer } = await import(
      '../../src/bootstrap/container.js'
    );
    const c = createServiceContainer({ DEPLOYMENT_ENV: 'production' });
    // Sync require: no pre-inject → not configured (async wire is ensure*)
    assert.throws(() => c.requireWorkerExecutorFactory(), (e) => {
      assert.equal(e.code, 'RUN_EXECUTOR_NOT_CONFIGURED');
      return true;
    });
    const c2 = createServiceContainer(
      { DEPLOYMENT_ENV: 'production' },
      { runExecutorFactory: () => createStubRunExecutor() },
    );
    assert.equal(typeof c2.requireWorkerExecutorFactory(), 'function');
  });

  it('forwards isolated BullMQ stall knobs without changing defaults', async () => {
    const fakeContainer = {
      env: {},
      // 缩深闸门只在配置**不服务**的层上查 key，探测会扫到 d8，全部返回「不存在」；
      // 账本里也没有超深的非终态 Run。
      redis: { type: async () => 'none' },
      knex: emptyLedger(),
      // Worker 在消费前问 session-turn-gate：替身只需提供会话锁的读接口。
      createSessionLockManager: async () => ({ getOwner: async () => null }),
      // 生产默认拓扑（ADR 0012）：maxDepth=2、总预算 4 → 2 / 1 / 1。
      runQueueTopology: {
        maxDepth: 2,
        totalConcurrency: 4,
        layers: [
          { depth: 0, queueName: 'agent-runs', concurrency: 2 },
          { depth: 1, queueName: 'agent-runs-d1', concurrency: 1 },
          { depth: 2, queueName: 'agent-runs-d2', concurrency: 1 },
        ],
      },
      async start() {
        return this;
      },
      async createWorkerServices() {
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
      async shutdown() {},
    };
    let options;
    await assert.rejects(
      () =>
        startWorkerMain(
          {
            AGENT_DATABASE_URL: 'mysql://u:p@h/db',
            AGENT_REDIS_URL: 'redis://localhost:6379/0',
            AGENT_ALLOW_STUB_EXECUTOR: 'true',
            NODE_ENV: 'development',
            AGENT_BULLMQ_LOCK_DURATION_MS: '3000',
            AGENT_BULLMQ_STALLED_INTERVAL_MS: '500',
            AGENT_BULLMQ_MAX_STALLED_COUNT: '2',
            AGENT_RUN_QUEUE_PREFIX: '{dsh-test-bull}',
          },
          {
            createContainer: () => fakeContainer,
            startProbeServer: async () => ({ listening: false }),
            createRunWorker: (_url, _processor, workerOptions) => {
              options = workerOptions;
              throw new Error('stop after option capture');
            },
          },
        ),
      /stop after option capture/,
    );
    assert.equal(options.lockDuration, 3000);
    assert.equal(options.stalledInterval, 500);
    assert.equal(options.maxStalledCount, 2);
    assert.equal(options.prefix, '{dsh-test-bull}');
    // 生产接线：每个消费者都带同会话依次执行的判定（plan §12 follow-up）。
    assert.equal(typeof options.shouldWait, 'function');

    let defaultOptions;
    await assert.rejects(
      () =>
        startWorkerMain(
          {
            AGENT_DATABASE_URL: 'mysql://u:p@h/db',
            AGENT_REDIS_URL: 'redis://localhost:6379/0',
            AGENT_ALLOW_STUB_EXECUTOR: 'true',
            NODE_ENV: 'development',
          },
          {
            createContainer: () => fakeContainer,
            startProbeServer: async () => ({ listening: false }),
            createRunWorker: (_url, _processor, workerOptions) => {
              defaultOptions = workerOptions;
              throw new Error('stop after default option capture');
            },
          },
        ),
      /stop after default option capture/,
    );
    assert.equal(defaultOptions.lockDuration, undefined);
    assert.equal(defaultOptions.stalledInterval, undefined);
    assert.equal(defaultOptions.maxStalledCount, undefined);
    assert.equal(defaultOptions.prefix, undefined);
    // 并发来自**这一层**的保留槽，不再是「总预算全给一个队列」：
    // 4 个槽在 maxDepth=2 下分成 2 / 1 / 1，深度 0 拿到 2。
    assert.equal(defaultOptions.concurrency, 2);
    assert.equal(defaultOptions.queueName, 'agent-runs');
    // 暂停期间在途取到的作业放回 delayed：谓词接到消费者暂停状态，延后时长等于依赖探测间隔。
    assert.equal(typeof defaultOptions.shouldDefer, 'function');
    assert.equal(defaultOptions.shouldDefer(), false, 'no consumer yet means not paused');
    assert.equal(defaultOptions.deferDelayMs, 5000);
  });

  it('SIGTERM stops intake at once and bounds the whole shutdown even when outbox hangs (K4)', async () => {
    // K8s 部署评审 K4：旧实现先 await outbox 循环再关消费者，outbox 在 MySQL 挂起时
    // 永不返回，期限计时器从未启动，消费者也一直在取任务。
    let publishCalls = 0;
    let containerShutdowns = 0;
    const closedAt = [];
    const fakeContainer = {
      env: {},
      redis: { type: async () => 'none', ping: async () => 'PONG' },
      knex: emptyLedger(),
      createSessionLockManager: async () => ({ getOwner: async () => null }),
      runQueueTopology: {
        maxDepth: 1,
        totalConcurrency: 2,
        layers: [
          { depth: 0, queueName: 'agent-runs', concurrency: 1 },
          { depth: 1, queueName: 'agent-runs-d1', concurrency: 1 },
        ],
      },
      async start() {
        return this;
      },
      async createWorkerServices() {
        return {
          workerRuntime: {
            async processJob() {},
            async start() {},
            async shutdown() {},
            isStarted: () => true,
            isShutdown: () => false,
          },
          recoveryService: { async scanAndRequeue() { return { actions: [] }; } },
        };
      },
      async createOutboxPublisher() {
        // 第一次正常，之后挂住——模拟 MySQL 挂起时 publishOnce 无上限。
        return {
          publishOnce: () => (++publishCalls === 1 ? Promise.resolve({}) : new Promise(() => {})),
        };
      },
      async shutdown() {
        containerShutdowns += 1;
      },
    };
    const fakeWorker = () => ({
      isRunning: () => true,
      isPaused: () => false,
      pause: async () => {},
      resume: () => {},
      close: async () => {
        closedAt.push(Date.now());
      },
    });

    const originalExit = process.exit;
    const exited = new Promise((resolve) => {
      process.exit = (code) => resolve(code);
    });
    const before = new Set(process.listeners('SIGTERM'));
    const beforeInt = new Set(process.listeners('SIGINT'));
    try {
      await startWorkerMain(
        {
          AGENT_DATABASE_URL: 'mysql://u:p@h/db',
          AGENT_REDIS_URL: 'redis://localhost:6379/0',
          AGENT_ALLOW_STUB_EXECUTOR: 'true',
          NODE_ENV: 'development',
          AGENT_OUTBOX_IDLE_MS: '1',
          AGENT_WORKER_DRAIN_TIMEOUT_MS: '1000',
        },
        {
          createContainer: () => fakeContainer,
          startProbeServer: async () => ({ listening: false }),
          startDependencyGuard: () => ({ pausedByGuard: () => false, checkNow: async () => {}, stop: async () => {} }),
          createRunWorker: () => ({ worker: fakeWorker(), connection: null }),
        },
      );
      // 等 outbox 进入挂起的第二次 publishOnce。
      while (publishCalls < 2) await new Promise((r) => setTimeout(r, 5));
      const handler = process.listeners('SIGTERM').find((l) => !before.has(l));
      assert.ok(handler, 'worker registered a SIGTERM handler');
      const signalledAt = Date.now();
      handler();
      const code = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve('no-exit'), 5_000)),
      ]);
      const elapsed = Date.now() - signalledAt;

      assert.equal(closedAt.length, 2, 'every layer closed');
      assert.ok(closedAt.every((t) => t - signalledAt < 200), 'intake stopped right away, not after outbox');
      assert.equal(code, 1, 'hung background loop hits the drain deadline');
      assert.ok(elapsed >= 900 && elapsed < 3_000, `bounded by the 1s budget, took ${elapsed}ms`);
      assert.equal(containerShutdowns, 0, 'no teardown while the outbox may still write');
    } finally {
      process.exit = originalExit;
      for (const l of process.listeners('SIGTERM')) if (!before.has(l)) process.removeListener('SIGTERM', l);
      for (const l of process.listeners('SIGINT')) if (!beforeInt.has(l)) process.removeListener('SIGINT', l);
    }
  });

  it('createWorkerServices assembly fails closed without MySQL/Redis start', async () => {
    const { createServiceContainer } = await import(
      '../../src/bootstrap/container.js'
    );
    const c = createServiceContainer({
      DEPLOYMENT_ENV: 'production',
      AGENT_DATABASE_URL: 'mysql://u:p@h/db',
      AGENT_REDIS_URL: 'redis://localhost:6379/0',
    });
    await assert.rejects(
      () => c.createWorkerServices(),
      /MySQL and Redis/,
    );
  });
});
