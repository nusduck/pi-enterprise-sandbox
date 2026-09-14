/**
 * UPRedis 队列放行测试（设计 §8「放行测试」，ADR 0011 D9）。
 *
 * 用项目自己的 Queue/Worker 工厂与参数化的生产 prefix，经真实 Redis（或 UPRedis Proxy）跑：
 * 立即任务、延迟任务、重试、stalled 恢复、取消与状态查询，外加单 key CAS（Run lease、
 * 会话锁、取消信号）。每个用例结束逐个 key 核对没有遗留，清理失败直接判失败。
 *
 * 门控（缺任一项整组 skip，离线 CI 保持绿）：
 *   TEST_UPREDIS_URL          redis://host:port/0（不带口令）
 *   TEST_UPREDIS_PASSWORD     口令（可空）
 *   TEST_UPREDIS_PREFIX       生产 prefix，默认 {bull}
 *   TEST_UPREDIS_EXPECT_ROUTING=1  目标是按 key 路由的代理（真 UPRedis 或
 *                             scripts/dev/upredis-sim-proxy.mjs）时打开负对照
 *   TEST_UPREDIS_REQUIRE_NOEVICTION=1  要求 CONFIG GET 能读到 noeviction（代理不放行
 *                             CONFIG 时不要打开，改由运维在各后端节点核验）
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  CancelSignal,
  createRedisClient,
  createRunQueue,
  createRunWorker,
  destroyRedisClient,
  destroyRunQueue,
  destroyRunWorker,
  enqueueRunJob,
  LeaseManager,
  resolveRunQueuePrefix,
  SessionLockManager,
} from '../../src/infrastructure/redis/index.js';

const require = createRequire(import.meta.url);
const URL_ = String(process.env.TEST_UPREDIS_URL || '').trim();
const PASSWORD = process.env.TEST_UPREDIS_PASSWORD || undefined;
const PREFIX = resolveRunQueuePrefix(process.env.TEST_UPREDIS_PREFIX);
const EXPECT_ROUTING = process.env.TEST_UPREDIS_EXPECT_ROUTING === '1';
const REQUIRE_NOEVICTION = process.env.TEST_UPREDIS_REQUIRE_NOEVICTION === '1';
const describeLive = URL_ ? describe : describe.skip;

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const TRACE = 'd'.repeat(32);
const STAMP = Date.now().toString(36);
const runId = (n) => `01K0G2PAV8FPMVC9QHJG7JPN${'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[n]}${'ABCDEFGHJK'[n % 10]}`;

// BullMQ 5 的队列级 key 后缀；全部按单 key EXISTS 核对，不依赖 SCAN/KEYS 穿过代理。
const QUEUE_KEY_SUFFIXES = [
  'id', 'meta', 'wait', 'paused', 'active', 'delayed', 'prioritized', 'completed', 'failed',
  'stalled', 'stalled-check', 'limiter', 'repeat', 'events', 'marker', 'pc', 'de',
  'waiting-children', 'metrics:completed', 'metrics:failed',
];

function waitFor(emitter, event, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(...args) {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      emitter.off(event, onEvent);
      resolve(args);
    }
    emitter.on(event, onEvent);
  });
}

describeLive('UPRedis queue release probe', () => {
  let redis;
  const opened = [];

  const openQueue = (queueName) => {
    const handle = createRunQueue(URL_, { queueName, prefix: PREFIX, password: PASSWORD });
    opened.push({ kind: 'queue', handle, queueName });
    return handle;
  };
  const openWorker = (queueName, processor, extra = {}) => {
    const handle = createRunWorker(URL_, processor, {
      queueName, prefix: PREFIX, password: PASSWORD, concurrency: 1, ...extra,
    });
    opened.push({ kind: 'worker', handle });
    return handle;
  };

  async function assertQueueGone(prefix, queueName, jobIds) {
    const keys = [
      ...QUEUE_KEY_SUFFIXES.map((s) => `${prefix}:${queueName}:${s}`),
      ...jobIds.flatMap((id) => [`${prefix}:${queueName}:${id}`, `${prefix}:${queueName}:${id}:lock`, `${prefix}:${queueName}:${id}:logs`]),
    ];
    const leftovers = [];
    for (const key of keys) {
      if ((await redis.exists(key)) !== 0) leftovers.push(key);
    }
    assert.deepEqual(leftovers, [], 'probe keys left behind');
  }

  async function obliterate(queue, prefix, queueName, jobIds) {
    await queue.obliterate({ force: true });
    await assertQueueGone(prefix, queueName, jobIds);
  }

  before(async () => {
    redis = createRedisClient(URL_, { password: PASSWORD, connectionRole: 'upredis-probe' });
    await redis.ping();
  });

  after(async () => {
    for (const item of opened.reverse()) {
      if (item.kind === 'worker') await destroyRunWorker(item.handle);
      else await destroyRunQueue(item.handle);
    }
    await destroyRedisClient(redis);
  });

  it('records server version and eviction policy', async (t) => {
    const info = String(await redis.info('server'));
    const version = /redis_version:([^\r\n]+)/.exec(info)?.[1];
    t.diagnostic(`redis_version=${version} prefix=${PREFIX} expectRouting=${EXPECT_ROUTING}`);
    assert.ok(version, 'INFO server must expose redis_version (BullMQ picks LPOS-free scripts below 6.0.6)');
    try {
      const [, policy] = await redis.config('GET', 'maxmemory-policy');
      t.diagnostic(`maxmemory-policy=${policy}`);
      if (REQUIRE_NOEVICTION) assert.equal(policy, 'noeviction');
    } catch (err) {
      if (REQUIRE_NOEVICTION) throw err;
      t.diagnostic(`CONFIG GET unavailable: ${err.message}`);
    }
  });

  it('negative controls: keyless EVAL and an untagged BullMQ prefix are rejected by the proxy', { skip: !EXPECT_ROUTING }, async () => {
    await assert.rejects(() => redis.eval('return 1', 0), /wrong number of arguments/);
    assert.equal(await redis.eval('return 1', 1, `${PREFIX}:probe:eval`), 1, 'allow control: one key passes');

    // 绕过工厂校验，直接用 bullmq 构造旧前缀的 Queue，证明代理确实会拒绝多 key 脚本。
    const { Queue } = require('bullmq');
    const queueName = `upredis-untagged-${STAMP}`;
    const untagged = new Queue(queueName, {
      prefix: 'bull',
      connection: { url: URL_, password: PASSWORD, maxRetriesPerRequest: null },
    });
    untagged.on('error', () => {});
    try {
      await assert.rejects(
        () => untagged.add('execute', { runId: runId(0), orgId: ORG, traceId: TRACE }),
        /keys must route to same node/,
      );
    } finally {
      await untagged.close();
    }
    // 实测：脚本被拒之前 BullMQ 已用单 key 命令写入队列 meta（版本标记），按单 key 清理并核对。
    assert.equal(await redis.del(`bull:${queueName}:meta`), 1, 'untagged probe should leave exactly its meta key');
    await assertQueueGone('bull', queueName, [runId(0)]);
  });

  it('immediate and delayed jobs complete, with state queries along the way', async () => {
    const queueName = `upredis-basic-${STAMP}`;
    const { queue } = openQueue(queueName);
    const processed = [];
    const { worker } = openWorker(queueName, async (ref) => {
      processed.push(ref.runId);
      return 'ok';
    });
    await worker.waitUntilReady();

    const doneImmediate = waitFor(worker, 'completed', (job) => job.id === runId(1));
    const immediate = await enqueueRunJob(queue, { runId: runId(1), orgId: ORG, traceId: TRACE }, { removeOnComplete: false });
    await doneImmediate;
    assert.equal(await immediate.getState(), 'completed');

    const startedAt = Date.now();
    const doneDelayed = waitFor(worker, 'completed', (job) => job.id === runId(2));
    const delayed = await enqueueRunJob(queue, { runId: runId(2), orgId: ORG, traceId: TRACE }, { delay: 1_200, removeOnComplete: false });
    assert.equal(await delayed.getState(), 'delayed');
    await doneDelayed;
    assert.ok(Date.now() - startedAt >= 1_000, 'delayed job must not run early');
    assert.equal(await delayed.getState(), 'completed');
    assert.deepEqual(processed, [runId(1), runId(2)]);

    await worker.close();
    await obliterate(queue, PREFIX, queueName, [runId(1), runId(2)]);
  });

  it('a failed attempt is retried with backoff and then completes', async () => {
    const queueName = `upredis-retry-${STAMP}`;
    const { queue } = openQueue(queueName);
    let attempts = 0;
    const { worker } = openWorker(queueName, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first attempt fails');
      return 'ok';
    });
    await worker.waitUntilReady();
    const done = waitFor(worker, 'completed', (job) => job.id === runId(3));
    const job = await enqueueRunJob(
      queue,
      { runId: runId(3), orgId: ORG, traceId: TRACE },
      { attempts: 2, backoff: { type: 'fixed', delay: 300 }, removeOnComplete: false },
    );
    const [completed] = await done;
    assert.equal(attempts, 2);
    assert.equal(completed.attemptsMade, 2);
    assert.equal(await job.getState(), 'completed');
    await worker.close();
    await obliterate(queue, PREFIX, queueName, [runId(3)]);
  });

  it('a job whose worker dies mid-flight is recovered as stalled by another worker', async () => {
    const queueName = `upredis-stalled-${STAMP}`;
    const { queue } = openQueue(queueName);
    let releaseHang;
    const hang = new Promise((resolve) => { releaseHang = resolve; });
    const timings = { lockDuration: 1_000, stalledInterval: 500, maxStalledCount: 1 };

    const a = openWorker(queueName, async () => { await hang; }, timings);
    await a.worker.waitUntilReady();
    const activeOnA = waitFor(a.worker, 'active', (job) => job.id === runId(4));
    await enqueueRunJob(queue, { runId: runId(4), orgId: ORG, traceId: TRACE }, { removeOnComplete: false });
    await activeOnA;
    // 强制关闭：不等处理结束、不再续锁，等价于进程被杀后锁自然过期。
    await a.worker.close(true);

    const b = openWorker(queueName, async () => 'recovered', timings);
    const stalled = waitFor(b.worker, 'stalled', (jobId) => jobId === runId(4));
    const done = waitFor(b.worker, 'completed', (job) => job.id === runId(4));
    await Promise.all([stalled, done]);
    releaseHang();
    assert.equal(await (await queue.getJob(runId(4))).getState(), 'completed');
    await b.worker.close();
    await obliterate(queue, PREFIX, queueName, [runId(4)]);
  });

  it('a waiting job can be cancelled and its state queried as gone', async () => {
    const queueName = `upredis-cancel-${STAMP}`;
    const { queue } = openQueue(queueName);
    const job = await enqueueRunJob(queue, { runId: runId(5), orgId: ORG, traceId: TRACE }, { delay: 60_000 });
    assert.equal(await job.getState(), 'delayed');
    assert.equal((await queue.getJobCounts('delayed')).delayed, 1);
    await job.remove();
    assert.equal(await queue.getJob(runId(5)), undefined);
    assert.equal((await queue.getJobCounts('delayed')).delayed, 0);
    await obliterate(queue, PREFIX, queueName, [runId(5)]);
  });

  it('single-key CAS: run lease, session lock and cancel signal', async () => {
    const run = runId(6);
    const session = runId(7);
    const leases = new LeaseManager(redis, { ttlMs: 5_000 });
    assert.equal(await leases.acquire(run, 'owner-a'), true);
    assert.equal(await leases.acquire(run, 'owner-b'), false);
    assert.equal(await leases.renew(run, 'owner-b'), false);
    assert.equal(await leases.release(run, 'owner-b'), false);
    assert.equal(await leases.renew(run, 'owner-a'), true);
    assert.equal(await leases.release(run, 'owner-a'), true);
    assert.equal(await leases.getOwner(run), null);

    const locks = new SessionLockManager(redis, { ttlMs: 5_000 });
    assert.equal(await locks.acquire(session, 'owner-a'), true);
    assert.equal(await locks.acquire(session, 'owner-b'), false);
    assert.equal(await locks.release(session, 'owner-b'), false);
    assert.equal(await locks.renew(session, 'owner-a'), true);
    assert.equal(await locks.release(session, 'owner-a'), true);
    assert.equal(await locks.getOwner(session), null);

    const cancel = new CancelSignal(redis, { ttlMs: 5_000 });
    await cancel.request(run, { reason: 'probe' });
    assert.equal(await cancel.isRequested(run), true);
    await cancel.clear(run);
    assert.equal(await cancel.isRequested(run), false);
  });
});
