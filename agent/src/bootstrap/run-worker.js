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

/**
 * Non-terminal needsReconciliation must not complete BullMQ jobs
 * (deterministic jobId=runId would then block re-enqueue forever).
 */
export class NeedsReconciliationError extends Error {
  /**
   * @param {string} runId
   * @param {string} [status]
   * @param {string} [detail]
   */
  constructor(runId, status = 'UNKNOWN', detail = '') {
    super(
      `Run ${runId} needs reconciliation (status=${status})${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'NeedsReconciliationError';
    this.code = 'NEEDS_RECONCILIATION';
    this.runId = runId;
    this.status = status;
    this.delayMs = 5_000;
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
 * Build a worker runtime from already-constructed infrastructure deps.
 * No I/O on construction.
 *
 * @param {{
 *   transactionManager: { run: Function },
 *   createRepositories: Function,
 *   leaseManager: object,
 *   runQueue: { enqueue: Function },
 *   cancelSignal?: object | null,
 *   runExecutor?: object,
 *   runExecutorFactory?: Function,
 *   allowStubExecutor?: boolean,
 *   generateId: () => string,
 *   workerId?: string,
 *   now?: () => Date,
 *   cancelPollIntervalMs?: number,
 *   leaseRenewIntervalMs?: number,
 *   onStart?: (runtime: object) => Promise<void> | void,
 *   onShutdown?: (runtime: object) => Promise<void> | void,
 * }} deps
 * @returns {RunWorkerRuntime}
 */
export function createRunWorkerRuntime(deps) {
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
  let runExecutorFactory = deps.runExecutorFactory;
  if (!runExecutorFactory && deps.runExecutor) {
    runExecutorFactory = undefined; // use shared instance
  }
  if (!runExecutorFactory && !deps.runExecutor) {
    if (deps.allowStubExecutor === true) {
      runExecutorFactory = () => createStubRunExecutor();
    } else {
      const err = new Error(
        'createRunWorkerRuntime requires runExecutor or runExecutorFactory; set allowStubExecutor=true only in explicit test/dev wiring',
      );
      err.code = 'RUN_EXECUTOR_NOT_CONFIGURED';
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
      return result;
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
export async function startRunWorkerRuntime(runtime) {
  if (!runtime || typeof runtime.start !== 'function') {
    throw new Error('startRunWorkerRuntime requires a runtime from createRunWorkerRuntime');
  }
  await runtime.start();
  return runtime;
}
