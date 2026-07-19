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

function optionalSafeInteger(value, minimum) {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum
    ? parsed
    : undefined;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{
 *   createContainer?: typeof createServiceContainer,
 *   createRunWorker?: Function,
 * }} [hooks] — DI seams for tests
 */
export async function startWorkerMain(env = process.env, hooks = {}) {
  const telemetry = await startTelemetry(env, {
    serviceName: 'pi-enterprise-agent-worker',
  });
  const createContainer = hooks.createContainer || createServiceContainer;
  const container = createContainer(env);
  await container.start({
    connectMysql: true,
    connectRedis: true,
    migrate: env.AGENT_MIGRATE_ON_START === 'true',
  });

  let workerRuntime;
  let recoveryService;
  try {
    ({ workerRuntime, recoveryService } = await container.createWorkerServices());
  } catch (err) {
    await container.shutdown().catch(() => {});
    throw err;
  }

  await startRunWorkerRuntime(workerRuntime);

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

  // BullMQ consumer is required — failure is fatal (no zombie recovery-only process).
  let workerHandle = null;
  try {
    const createRunWorker =
      hooks.createRunWorker ||
      (await import('../infrastructure/redis/run-queue.js')).createRunWorker;
    const redisUrl = env.AGENT_REDIS_URL || env.REDIS_URL || '';
    workerHandle = createRunWorker(
      redisUrl,
      async (ref) => workerRuntime.processJob(ref),
      {
        queueName: env.AGENT_RUNS_QUEUE_NAME || undefined,
        concurrency: Number(env.AGENT_WORKER_CONCURRENCY) || 1,
        // Keep BullMQ defaults in production. These bounded knobs are useful
        // for isolated restart gates and controlled staging drills without
        // changing the normal lock/stall contract.
        lockDuration: optionalSafeInteger(
          env.AGENT_BULLMQ_LOCK_DURATION_MS,
          1,
        ),
        stalledInterval: optionalSafeInteger(
          env.AGENT_BULLMQ_STALLED_INTERVAL_MS,
          1,
        ),
        maxStalledCount: optionalSafeInteger(
          env.AGENT_BULLMQ_MAX_STALLED_COUNT,
          0,
        ),
      },
    );
    console.log(
      `[agent-worker] BullMQ consumer started queue=${workerHandle.queueName} recovery=${recoveryOk ? 'ok' : 'degraded'}`,
    );
  } catch (err) {
    console.error(
      '[agent-worker] BullMQ consumer failed to start — shutting down:',
      err instanceof Error ? err.message : 'error',
    );
    clearInterval(recoveryTimer);
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

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[agent-worker] ${signal} — shutting down`);
    clearInterval(recoveryTimer);
    outboxAbort.abort();
    try {
      await outboxLoop;
    } catch {
      /* ignore */
    }
    if (workerHandle) {
      try {
        const { destroyRunWorker } = await import(
          '../infrastructure/redis/run-queue.js'
        );
        await destroyRunWorker(workerHandle);
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
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return { container, workerRuntime, recoveryService, workerHandle };
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
