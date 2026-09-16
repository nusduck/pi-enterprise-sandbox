/**
 * Agent Worker process entry (PR-04 T3/T4).
 *
 * Separate from HTTP. Binds BullMQ consumer → ExecuteRunService, runs bounded
 * recovery scan (failure is logged; consumer still required), OutboxPublisher
 * loop, graceful shutdown.
 *
 * BullMQ consumer creation failure is fatal: cleanup started resources and throw.
 * Initial recovery failure is degraded (logged) but process continues.
 *
 * Does not import agent/server.js or process-local RunManager.
 * Production wires real Pi RunExecutor via container.createWorkerServices →
 * ensureWorkerRunExecutorFactory. Stub only with AGENT_ALLOW_STUB_EXECUTOR=true
 * in non-production (never production).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServiceContainer } from './container.js';
import { startRunWorkerRuntime } from './run-worker.js';
import { startTelemetry } from '../infrastructure/telemetry.js';
import { CronScheduler } from '../application/cron-job-service.js';
import {
  closeWorkerProbeServer,
  pingDependencies,
  resolveWorkerProbePort,
  startWorkerProbeServer,
} from './worker-probe.js';
import {
  resolveDependencyCheckInterval,
  startWorkerDependencyGuard,
} from './worker-dependency-guard.js';

/** Foreground durable subagents need a slot while their child Run executes. */
export const DEFAULT_AGENT_WORKER_CONCURRENCY = 4;

function optionalSafeInteger(value: unknown, minimum: number): number | undefined {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum
    ? parsed
    : undefined;
}

/**
 * 回滚 / 缩容的安全闸门：本配置**不服务**的 Run 队列里还有存量作业就拒绝启动。
 *
 * 升级方向不需要排空——深度 0 沿用 `agent-runs`，旧队列里按旧规则投进去的
 * 子 Run 仍由深度 0 的消费者处理（处理器与深度无关）。危险的是**回滚**：
 * 换回旧镜像或调小 `AGENT_SUBAGENT_MAX_DEPTH` 之后，没有人消费
 * `agent-runs-d1/d2`，里面的作业会永远躺着。这里在启动时反向数一遍，
 * 有存量就 fail-closed 并点名队列与条数，让运维先排空再切。
 *
 * 数不到（队列 key 还不存在、Redis 瞬时失败）按 0 处理：这是一条**额外**的
 * 保护，不该让它自己成为启动的新故障点；真正的连接可用性由依赖守卫与
 * `/ready` 负责。
 */
async function assertNoStrandedRunQueues(container: any, topology: any): Promise<void> {
  const { assertNoStrandedLayers, queueNamesToProbe, MAX_PROBE_DEPTH } = await import(
    '../infrastructure/redis/run-queue-topology.js'
  );
  const { resolveRunQueuePrefix } = await import(
    '../infrastructure/redis/run-queue.js'
  );
  const served = new Set(topology.layers.map((l: any) => l.queueName));
  const base = topology.layers.find((l: any) => l.depth === 0)?.queueName;
  const prefix = resolveRunQueuePrefix(container.env?.AGENT_RUN_QUEUE_PREFIX);
  // BullMQ 各状态的底层类型不一样（wait/paused/active 是 list，
  // delayed/prioritized 是 zset），而且跨版本改过。按 key 的实际类型来数，
  // 不把版本细节写死在这里。
  const countKey = async (key: string): Promise<number> => {
    try {
      const type = await container.redis.type(key);
      if (type === 'list') return Number(await container.redis.llen(key)) || 0;
      if (type === 'zset') return Number(await container.redis.zcard(key)) || 0;
      return 0;
    } catch {
      return 0;
    }
  };
  const counts: Record<string, number> = {};
  for (const queueName of queueNamesToProbe(MAX_PROBE_DEPTH, base)) {
    if (served.has(queueName)) continue;
    let total = 0;
    for (const state of ['wait', 'paused', 'active', 'delayed', 'prioritized']) {
      total += await countKey(`${prefix}:${queueName}:${state}`);
    }
    counts[queueName] = total;
  }
  assertNoStrandedLayers(topology, counts);
}

/** 测试用的注入缝。生产不传，走真实实现。 */
export interface WorkerMainHooks {
  readonly createContainer?: typeof createServiceContainer;
  readonly createRunWorker?: (...args: any[]) => any;
  readonly startProbeServer?: typeof startWorkerProbeServer;
  readonly startDependencyGuard?: typeof startWorkerDependencyGuard;
}

export async function startWorkerMain(
  env: NodeJS.ProcessEnv = process.env,
  hooks: WorkerMainHooks = {},
) {
  // 端口 / 探测间隔非法在任何连接之前拒绝启动。
  const probePort = resolveWorkerProbePort(env.AGENT_WORKER_PROBE_PORT);
  const dependencyCheckIntervalMs = resolveDependencyCheckInterval(
    env.AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS,
  );
  const probe = {
    started: false,
    shuttingDown: false,
    container: null as any,
    /** 深度 0 的消费者句柄（既有调用方与测试夹具只认这一个）。 */
    workerHandle: null as any,
    /** 全部分层消费者（ADR 0012）。readiness 要求**每一层**都在跑。 */
    workerHandles: [] as any[],
  };
  // 探针先于容器启动：启动期间 liveness 可达、readiness 为 503。
  const server = await (hooks.startProbeServer || startWorkerProbeServer)(
    {
      started: () => probe.started,
      shuttingDown: () => probe.shuttingDown,
      // 任何一个**必需层**的消费者没在跑，整个 Worker 就不就绪——分层之后
      // 「深度 1 的消费者挂了」等于子任务永远没人消费，不能还报告就绪。
      consumerRunning: () =>
        probe.workerHandles.length > 0 &&
        probe.workerHandles.every((h) => h?.worker?.isRunning?.() === true),
      consumerPaused: () =>
        probe.workerHandles.some((h) => h?.worker?.isPaused?.() === true),
      pingMysql: () => probe.container.knex.raw('select 1'),
      pingRedis: () => probe.container.redis.ping(),
    },
    { port: probePort, host: env.AGENT_WORKER_PROBE_HOST || undefined },
  );
  try {
    return await runWorkerMain(env, hooks, probe, server, dependencyCheckIntervalMs);
  } catch (err) {
    probe.shuttingDown = true;
    await closeWorkerProbeServer(server).catch(() => {});
    throw err;
  }
}

async function runWorkerMain(
  env: NodeJS.ProcessEnv,
  hooks: WorkerMainHooks,
  probe: {
    started: boolean;
    shuttingDown: boolean;
    container: any;
    workerHandle: any;
    workerHandles: any[];
  },
  probeServer: Awaited<ReturnType<typeof startWorkerProbeServer>>,
  dependencyCheckIntervalMs: number,
) {
  const telemetry = await startTelemetry(env, {
    serviceName: 'pi-enterprise-agent-worker',
  });
  const createContainer = hooks.createContainer || createServiceContainer;
  const container = createContainer(env);
  probe.container = container;
  // schema 只读核对在 container.start 里，先于消费任务、恢复扫描与 outbox 发布。
  await container.start({
    role: 'agent-worker',
    connectMysql: true,
    connectRedis: true,
  });

  let workerRuntime;
  let recoveryService;
  let cronJobService;
  try {
    ({ workerRuntime, recoveryService, cronJobService } = await container.createWorkerServices());
  } catch (err) {
    await container.shutdown().catch(() => {});
    throw err;
  }

  await startRunWorkerRuntime(workerRuntime);

  // Cron is intentionally co-located with the durable Agent worker. It only
  // creates standard Run records; it never executes tools or Pi sessions.
  // Older isolated bootstrap fakes do not expose the optional control-plane
  // service. Real ServiceContainer wiring always does; retaining this guard
  // keeps the Run worker's failure semantics independently testable.
  const cronScheduler = cronJobService
    ? new CronScheduler({
        cronJobService,
        intervalMs: Number(env.AGENT_CRON_SCHEDULER_INTERVAL_MS) || 30_000,
        claimRetryMs: Number(env.AGENT_CRON_CLAIM_RETRY_MS) || 120_000,
        batchSize: Number(env.AGENT_CRON_BATCH_SIZE) || 25,
      })
    : null;
  await cronScheduler?.start();

  // Bounded recovery scan before accepting jobs. Failure is observable but
  // does not hard-crash when the consumer is up (periodic scan retries).
  let recoveryOk = false;
  try {
    const scan = await recoveryService.scanAndRequeue({
      limit: Number(env.AGENT_RECOVERY_SCAN_LIMIT) || 100,
    });
    recoveryOk = true;
    console.log(
      `[agent-worker] recovery scan complete actions=${scan.actions.length}`,
    );
  } catch (err) {
    console.error(
      '[agent-worker] initial recovery scan failed (will retry periodically):',
      err instanceof Error ? err.message : 'error',
    );
  }

  const recoveryIntervalMs =
    Number(env.AGENT_RECOVERY_INTERVAL_MS) || 60_000;
  const recoveryTimer = setInterval(() => {
    void recoveryService
      .scanAndRequeue({
        limit: Number(env.AGENT_RECOVERY_SCAN_LIMIT) || 100,
      })
      .catch((err) => {
        console.error(
          '[agent-worker] periodic recovery failed:',
          err instanceof Error ? err.message : 'error',
        );
      });
  }, recoveryIntervalMs);
  if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();

  let publisher;
  try {
    publisher = await container.createOutboxPublisher();
  } catch (err) {
    clearInterval(recoveryTimer);
    await cronScheduler?.shutdown().catch(() => {});
    await workerRuntime.shutdown().catch(() => {});
    await container.shutdown().catch(() => {});
    throw err;
  }

  const outboxAbort = new AbortController();
  const outboxLoop = (async () => {
    while (!outboxAbort.signal.aborted) {
      try {
        await publisher.publishOnce();
      } catch (err) {
        if (outboxAbort.signal.aborted) break;
        console.error(
          '[agent-worker] outbox tick failed:',
          err instanceof Error ? err.message : 'error',
        );
      }
      await new Promise((r) =>
        setTimeout(r, Number(env.AGENT_OUTBOX_IDLE_MS) || 1000),
      );
    }
  })();

  // BullMQ consumers are required — failure is fatal (no zombie recovery-only process).
  // 分层之后是**每个深度一个消费者**（ADR 0012）：任何一层起不来都算致命，
  // 否则「深度 1 没人消费」会被当成正常启动，而子任务永远排队。
  let workerHandle = null;
  let workerHandles: any[] = [];
  try {
    const createRunWorker =
      hooks.createRunWorker ||
      (await import('../infrastructure/redis/run-queue.js')).createRunWorker;
    const redisUrl = env.AGENT_REDIS_URL || env.REDIS_URL || '';
    // 消费侧才做槽位分配：`AGENT_WORKER_CONCURRENCY` 是总预算，按每层保留
    // 一个槽切分；预算不够给每层留槽时抛错，Worker 拒绝启动（ADR 0012）。
    const { allocateReservedSlots } = await import(
      '../infrastructure/redis/run-queue-topology.js'
    );
    const { resolveWorkerConcurrency } = await import('./container-run-queue.js');
    const topology = allocateReservedSlots(
      container.runQueueTopology,
      resolveWorkerConcurrency(env),
    );
    // 回滚/缩容的安全闸门：本配置不服务的层里还有存量作业就拒绝启动，
    // 并点名队列与条数——不让作业静默躺在没人消费的队列里。
    await assertNoStrandedRunQueues(container, topology);
    const commonOptions = {
      // 必须与 HTTP 进程的 Queue 同一 prefix，否则投递与消费落在两个 key 空间。
      prefix: env.AGENT_RUN_QUEUE_PREFIX || undefined,
      // 容器启动时已向 DBPM 取到；消费者连接不从 URL 读口令。
      ...(container.credentials?.redis !== undefined
        ? { password: container.credentials.redis }
        : {}),
      deferDelayMs: dependencyCheckIntervalMs,
      // Keep BullMQ defaults in production. These bounded knobs are useful
      // for isolated restart gates and controlled staging drills without
      // changing the normal lock/stall contract.
      lockDuration: optionalSafeInteger(env.AGENT_BULLMQ_LOCK_DURATION_MS, 1),
      stalledInterval: optionalSafeInteger(env.AGENT_BULLMQ_STALLED_INTERVAL_MS, 1),
      maxStalledCount: optionalSafeInteger(env.AGENT_BULLMQ_MAX_STALLED_COUNT, 0),
    };
    for (const layer of topology.layers) {
      const index = workerHandles.length;
      const handle = createRunWorker(
        redisUrl,
        async (ref) => workerRuntime.processJob(ref),
        {
          ...commonOptions,
          queueName: layer.queueName,
          concurrency: layer.concurrency,
          // 依赖守卫暂停后，在途的阻塞取任务仍可能拿到作业：执行前再看一次，
          // 暂停中放回 delayed。按层各看各的暂停标志。
          shouldDefer: () => workerHandles[index]?.worker?.isPaused?.() === true,
        },
      );
      workerHandles.push(handle);
    }
    workerHandle = workerHandles[0] ?? null;
    probe.workerHandle = workerHandle;
    probe.workerHandles = workerHandles;
    probe.started = true;
    const plan = topology.layers
      .map((l: any) => `d${l.depth}:${l.queueName}x${l.concurrency}`)
      .join(' ');
    console.log(
      `[agent-worker] BullMQ consumers started budget=${topology.totalConcurrency} ${plan} recovery=${recoveryOk ? 'ok' : 'degraded'}`,
    );
  } catch (err) {
    console.error(
      '[agent-worker] BullMQ consumer failed to start — shutting down:',
      err instanceof Error ? err.message : 'error',
    );
    clearInterval(recoveryTimer);
    await cronScheduler?.shutdown().catch(() => {});
    outboxAbort.abort();
    try {
      await outboxLoop;
    } catch {
      /* ignore */
    }
    await workerRuntime.shutdown().catch(() => {});
    await container.shutdown().catch(() => {});
    throw err;
  }

  // 依赖不可用时暂停取新任务（design §9.2）。与 /ready 共用同一套 ping。
  const dependencyGuard = (hooks.startDependencyGuard || startWorkerDependencyGuard)({
    intervalMs: dependencyCheckIntervalMs,
    check: () =>
      pingDependencies({
        pingMysql: () => container.knex.raw('select 1'),
        pingRedis: () => container.redis.ping(),
      }),
    // 守卫对**全部层**生效：只暂停根队列等于让深层继续从不可用的依赖上取任务。
    pause: async () => {
      await Promise.all(workerHandles.map((h) => h.worker.pause(true)));
    },
    resume: () => {
      for (const h of workerHandles) h.worker.resume();
    },
    log: (level, message) =>
      (level === 'warn' ? console.warn : console.log)(`[agent-worker] ${message}`),
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // 先摘除就绪，再停守卫、调度与消费；探针 listener 最后关，关停期间 liveness 仍可答。
    probe.shuttingDown = true;
    await dependencyGuard.stop().catch(() => {});
    console.log(`[agent-worker] ${signal} — shutting down`);
    clearInterval(recoveryTimer);
    await cronScheduler?.shutdown().catch(() => {});
    outboxAbort.abort();
    try {
      await outboxLoop;
    } catch {
      /* ignore */
    }
    if (workerHandles.length > 0) {
      try {
        const { destroyRunWorker } = await import(
          '../infrastructure/redis/run-queue.js'
        );
        // 逐层关停，一个失败不阻断其余。
        await Promise.all(
          workerHandles.map((h) => destroyRunWorker(h).catch(() => undefined)),
        );
      } catch {
        /* ignore */
      }
    }
    try {
      await workerRuntime.shutdown();
    } catch {
      /* ignore */
    }
    try {
      await container.shutdown();
    } catch {
      /* ignore */
    }
    try {
      await telemetry.shutdown();
    } catch {
      /* ignore */
    }
    await closeWorkerProbeServer(probeServer).catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return {
    container,
    workerRuntime,
    recoveryService,
    cronScheduler,
    workerHandle,
    workerHandles,
    probeServer,
    dependencyGuard,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  startWorkerMain().catch((err) => {
    console.error(
      '[agent-worker] fatal:',
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
