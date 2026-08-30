/**
 * Run Worker bootstrap (PR-04 T3) — process separate from HTTP server.
 *
 * Does **not** start connections on import. Call {@link createRunWorkerRuntime}
 * then {@link startRunWorkerRuntime} explicitly. Shutdown is exactly-once.
 *
 * start() uses startPromise: concurrent callers share one attempt; failure
 * leaves started=false so a later start may retry. onStart runs before
 * started flips true.
 *
 * Does not depend on agent/server.js or process-local Run Maps.
 *
 * Live BullMQ/Redis/MySQL wiring of production URLs is deferred to PR-04 T4.
 */

import {
  ExecuteRunService,
  LeaseBusyError,
} from '../application/execute-run-service.js';
import { RunRecoveryService } from '../application/run-recovery-service.js';
import { createStubRunExecutor } from '../application/run-executor.js';
import { isTerminalRunStatus } from '../domain/run/run-status.js';
import { assertRunJobRef } from '../infrastructure/redis/run-queue.js';
import {
  SpanKind,
  startSpan,
  withActiveContext,
} from '../infrastructure/telemetry.js';

/**
 * Non-terminal needsReconciliation must not complete BullMQ jobs
 * (deterministic jobId=runId would then block re-enqueue forever).
 */
export class NeedsReconciliationError extends Error {
  /**
   * @param {string} runId
   * @param {string} [status]
   */
  // 这四个字段原本是构造器里动态赋的属性。转 TS 时声明出来——BullMQ 的重试
  // 逻辑靠 `code` 与 `delayMs` 决策，它们是这个错误的契约，不是附带信息。
  readonly code = 'NEEDS_RECONCILIATION';
  readonly runId: string;
  readonly status: string;
  readonly delayMs = 5_000;

  constructor(runId: string, status = 'UNKNOWN', detail = '') {
    super(
      `Run ${runId} needs reconciliation (status=${status})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'NeedsReconciliationError';
    this.runId = runId;
    this.status = status;
  }
}

/**
 * @typedef {{
 *   executeRunService: ExecuteRunService,
 *   recoveryService?: RunRecoveryService | null,
 *   workerId: string,
 *   processJob: (jobData: unknown) => Promise<object>,
 *   runRecoveryScan: (opts?: object) => Promise<object>,
 *   start: () => Promise<void>,
 *   shutdown: () => Promise<void>,
 *   isStarted: () => boolean,
 *   isShutdown: () => boolean,
 * }} RunWorkerRuntime
 */

/**
 * 过渡期宽松类型：`ExecuteRunService` / `RunRecoveryService` 仍是 JS，
 * 它们的 JSDoc 期待精确的函数签名，而这里的 deps 原本声明成裸 `Function`
 * ——那正是这个文件曾经六处 `@ts-expect-error` 的全部原因。用 `Loose` 把
 * "两边都还没有真类型"这件事说清楚，比逐个压制诚实。
 */
type Loose = any;

export interface RunWorkerDeps {
  readonly transactionManager: { run: Loose };
  readonly createRepositories: Loose;
  readonly leaseManager: Loose;
  readonly runQueue: { enqueue: Loose };
  readonly cancelSignal?: Loose;
  readonly runExecutor?: Loose;
  readonly runExecutorFactory?: Loose;
  readonly allowStubExecutor?: boolean;
  readonly generateId: () => string;
  readonly workerId?: string;
  readonly now?: () => Date;
  readonly cancelPollIntervalMs?: number;
  readonly leaseRenewIntervalMs?: number;
  readonly onStart?: (runtime: object) => Promise<void> | void;
  readonly onShutdown?: (runtime: object) => Promise<void> | void;
}

/**
 * Build a worker runtime from already-constructed infrastructure deps.
 * No I/O on construction.
 */
export function createRunWorkerRuntime(deps: RunWorkerDeps) {
  if (!deps?.transactionManager || typeof deps.createRepositories !== 'function') {
    throw new Error('createRunWorkerRuntime requires transactionManager + createRepositories');
  }
  if (!deps.leaseManager || !deps.runQueue) {
    throw new Error('createRunWorkerRuntime requires leaseManager + runQueue');
  }
  if (typeof deps.generateId !== 'function') {
    throw new Error('createRunWorkerRuntime requires generateId');
  }

  const workerId =
    (typeof deps.workerId === 'string' && deps.workerId.trim()) ||
    `worker-${deps.generateId()}`;

  // Prefer explicit factory. Shared runExecutor only for concurrency=1 tests.
  // Never silently invent a stub here for production paths.
  let runExecutorFactory: Loose = deps.runExecutorFactory;
  if (!runExecutorFactory && deps.runExecutor) {
    runExecutorFactory = undefined; // use shared instance
  }
  if (!runExecutorFactory && !deps.runExecutor) {
    if (deps.allowStubExecutor === true) {
      runExecutorFactory = () => createStubRunExecutor();
    } else {
      // 装配期缺执行器是部署错误，不是运行时状况：带上稳定的 code 让上层
      // 能区分"没配"与"跑挂了"。
      const err = Object.assign(
        new Error(
          'createRunWorkerRuntime requires runExecutor or runExecutorFactory; set allowStubExecutor=true only in explicit test/dev wiring',
        ),
        { code: 'RUN_EXECUTOR_NOT_CONFIGURED' },
      );
      throw err;
    }
  }

  const executeRunService = new ExecuteRunService({
    transactionManager: deps.transactionManager,
    createRepositories: deps.createRepositories,
    leaseManager: deps.leaseManager,
    cancelSignal: deps.cancelSignal ?? null,
    runExecutor: deps.runExecutor,
    runExecutorFactory,
    generateId: deps.generateId,
    now: deps.now,
    cancelPollIntervalMs: deps.cancelPollIntervalMs,
    leaseRenewIntervalMs: deps.leaseRenewIntervalMs,
  });

  const recoveryService = new RunRecoveryService({
    transactionManager: deps.transactionManager,
    createRepositories: deps.createRepositories,
    runQueue: deps.runQueue,
    generateId: deps.generateId,
    now: deps.now,
    leaseManager: deps.leaseManager,
  });

  let started = false;
  let shutdown = false;
  /** @type {Promise<void> | null} */
  let startPromise = null;
  /** @type {Promise<void> | null} */
  let shutdownPromise = null;

  const runtime = {
    executeRunService,
    recoveryService,
    workerId,

    /**
     * Process a single ref-only job (unit-testable without BullMQ).
     * lease_busy throws so BullMQ does **not** mark the job completed
     * (retry after delay); otherwise recovery cannot re-add jobId=runId.
     * @param {unknown} jobData
     */
    async processJob(jobData) {
      if (shutdown) {
        throw new Error('Run worker is shut down');
      }
      const ref = assertRunJobRef(jobData);
      const runSpan = startSpan('agent.run.execute', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'app.run_id': ref.runId,
          'app.org_id': ref.orgId,
          'app.worker_id': workerId,
        },
      });
      return withActiveContext(runSpan.activeContext, async () => {
        try {
          const result = await executeRunService.execute({
            runId: ref.runId,
            orgId: ref.orgId,
            traceId: ref.traceId,
            workerId,
          });
          if (result?.leaseBusy) {
            throw new LeaseBusyError(ref.runId, { delayMs: 5_000 });
          }
          // Lease-lost / re-entry refuse / unknown infrastructure: keep job active
          // so recovery can terminalize and a later attempt can observe terminal.
          if (
            result?.needsReconciliation &&
            !isTerminalRunStatus(result.status)
          ) {
            throw new NeedsReconciliationError(
              ref.runId,
              String(result.status || 'UNKNOWN'),
              result.error ? String(result.error) : '',
            );
          }
          runSpan.end(null, 200);
          return result;
        } catch (error) {
          runSpan.end(error, 500);
          throw error;
        }
      });
    },

    /**
     * @param {object} [opts]
     */
    async runRecoveryScan(opts = {}) {
      if (shutdown) {
        throw new Error('Run worker is shut down');
      }
      return recoveryService.scanAndRequeue(opts);
    },

    async start() {
      if (shutdown) throw new Error('Run worker already shut down');
      if (started) return;
      if (startPromise) return startPromise;

      startPromise = (async () => {
        try {
          if (typeof deps.onStart === 'function') {
            await deps.onStart(runtime);
          }
          started = true;
        } catch (err) {
          // Allow retry: clear startPromise so a later start() can re-attempt.
          startPromise = null;
          throw err;
        }
      })();

      return startPromise;
    },

    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async () => {
        shutdown = true;
        // Wait for in-flight start if any
        if (startPromise) {
          try {
            await startPromise;
          } catch {
            /* ignore failed start during shutdown */
          }
        }
        if (typeof deps.onShutdown === 'function') {
          await deps.onShutdown(runtime);
        }
      })();
      return shutdownPromise;
    },

    isStarted: () => started,
    isShutdown: () => shutdown,
  };

  return runtime;
}

/**
 * Explicit start helper (not invoked on import).
 * @param {RunWorkerRuntime} runtime
 */
export async function startRunWorkerRuntime(runtime: Loose) {
  if (!runtime || typeof runtime.start !== 'function') {
    throw new Error('startRunWorkerRuntime requires a runtime from createRunWorkerRuntime');
  }
  await runtime.start();
  return runtime;
}
