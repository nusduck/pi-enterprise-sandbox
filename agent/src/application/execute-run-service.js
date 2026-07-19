/**
 * ExecuteRunService (PR-04 T3) — worker-side run execution core.
 *
 * Input: ref-only job { runId, orgId, traceId } + workerId.
 *
 * Lease renew and cancel watching use **serial timeout loops** (no overlapping
 * async IIFEs). Cancel during runtime: Redis signal (acceleration) + periodic
 * MySQL owner-scoped reload of durable intent → RUNNING→CANCELLING (sole SM) →
 * AbortSignal → wait executor settle → CANCELLING→CANCELLED.
 *
 * STARTING + cancel before runtime: sole SM path STARTING→RUNNING→CANCELLING
 * (never invent STARTING→CANCELLING).
 *
 * Outer infrastructure failures return current/UNKNOWN + needsReconciliation —
 * never claim durable FAILED unless a transaction actually wrote FAILED.
 *
 * RunExecutor lifecycle: prefer `runExecutorFactory(ctx)` per job (concurrency-
 * safe dispose). Single shared `runExecutor` is supported only for concurrency=1.
 */

import { LEASE_RENEW_INTERVAL_MS } from '../infrastructure/redis/constants.js';
import {
  isTerminalRunStatus,
  RUN_STATUS,
  runStateMachine,
} from '../domain/run/index.js';
import { assertUlid } from '../domain/shared/ulid.js';
import {
  createStubRunExecutor,
  normalizeExecutorResult,
} from './run-executor.js';
import { generateRunLeaseOwnerToken } from './pi-run-executor.js';
import { applyRunTransitionInTxn } from './run-transition.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { ValidationError } from './errors.js';
import { normalizeTraceId } from './create-run-service.js';
import {
  APPROVAL_STATUS,
  isTerminalApprovalStatus,
} from '../domain/tool/approval-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import {
  INTERACTION_STATUS,
  INTERACTION_RESUME_PHASE,
} from '../domain/interaction/interaction-status.js';

/** Default cancel poll interval while executor runs (injectable). */
export const DEFAULT_CANCEL_POLL_INTERVAL_MS = 100;

/**
 * @typedef {{
 *   status: string,
 *   runId: string,
 *   outcome?: string | null,
 *   leaseBusy?: boolean,
 *   cancelled?: boolean,
 *   needsReconciliation?: boolean,
 *   error?: string | null,
 *   cleanupError?: string | null,
 * }} ExecuteRunResult
 */

/**
 * Serial setTimeout loop: at most one async tick in flight; stop waits for it.
 * @param {{
 *   intervalMs: number,
 *   tick: () => Promise<void>,
 *   isStopped: () => boolean,
 * }} opts
 */
export function createSerialTimeoutLoop(opts) {
  const intervalMs = Math.max(1, Number(opts.intervalMs) || 1);
  let stopped = false;
  let timer = null;
  /** @type {Promise<void> | null} */
  let inFlight = null;

  const schedule = () => {
    if (stopped || opts.isStopped()) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped || opts.isStopped()) return;
      const tickPromise = (async () => {
        try {
          if (stopped || opts.isStopped()) return;
          await opts.tick();
        } finally {
          // only clear if we are still the current inFlight
        }
      })();
      inFlight = tickPromise.finally(() => {
        if (inFlight === tickPromise) inFlight = null;
        if (!stopped && !opts.isStopped()) schedule();
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  return {
    start() {
      if (stopped) return;
      schedule();
    },
    async stop() {
      stopped = true;
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* tick errors are owned by the tick body */
        }
      }
    },
  };
}

/**
 * Thrown / returned when another worker holds the run lease.
 * BullMQ processor must treat this as a **retryable failure** (never complete).
 */
export class LeaseBusyError extends Error {
  /**
   * @param {string} runId
   * @param {{ delayMs?: number }} [opts]
   */
  constructor(runId, opts = {}) {
    super(`Run lease busy for ${runId}; delayed retry`);
    this.name = 'LeaseBusyError';
    this.code = 'LEASE_BUSY';
    this.runId = runId;
    this.delayMs = opts.delayMs ?? 5_000;
  }
}

export class ExecuteRunService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => {
   *     runs: any,
   *     runEvents: any,
   *     outbox: any,
   *   },
   *   leaseManager: {
   *     acquire: (runId: string, ownerToken: string) => Promise<boolean>,
   *     renew: (runId: string, ownerToken: string) => Promise<boolean>,
   *     release: (runId: string, ownerToken: string) => Promise<boolean>,
   *     renewIntervalMs?: number,
   *   },
   *   cancelSignal?: { isRequested: (runId: string) => Promise<boolean> } | null,
   *   runExecutor?: import('./run-executor.js').RunExecutor,
   *   runExecutorFactory?: (job: { runId: string, orgId: string, workerId: string }) => import('./run-executor.js').RunExecutor | Promise<import('./run-executor.js').RunExecutor>,
   *   generateId: () => string,
   *   now?: () => Date,
   *   runStateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
   *   leaseRenewIntervalMs?: number,
   *   cancelPollIntervalMs?: number,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('ExecuteRunService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('ExecuteRunService requires createRepositories');
    }
    if (!deps.leaseManager?.acquire || !deps.leaseManager?.release) {
      throw new Error('ExecuteRunService requires leaseManager');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('ExecuteRunService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.leaseManager = deps.leaseManager;
    this.cancelSignal = deps.cancelSignal ?? null;
    /** @type {import('./run-executor.js').RunExecutor | null} */
    this.sharedExecutor = deps.runExecutor ?? null;
    this.runExecutorFactory = deps.runExecutorFactory ?? null;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.leaseRenewIntervalMs =
      deps.leaseRenewIntervalMs ??
      deps.leaseManager.renewIntervalMs ??
      LEASE_RENEW_INTERVAL_MS;
    this.cancelPollIntervalMs =
      deps.cancelPollIntervalMs ?? DEFAULT_CANCEL_POLL_INTERVAL_MS;
  }

  /**
   * Resolve per-job executor. Factory preferred for concurrency safety.
   * @param {{ runId: string, orgId: string, workerId: string }} job
   */
  async #resolveExecutor(job) {
    if (typeof this.runExecutorFactory === 'function') {
      return this.runExecutorFactory(job);
    }
    if (this.sharedExecutor) {
      // WARNING: shared instance is only safe at concurrency=1.
      // Concurrent jobs must not share a disposable runtime.
      return this.sharedExecutor;
    }
    return createStubRunExecutor();
  }

  /**
   * @param {{
   *   runId: string,
   *   orgId: string,
   *   traceId: string,
   *   workerId: string,
   * }} job
   * @returns {Promise<ExecuteRunResult>}
   */
  async execute(job) {
    if (!job || typeof job !== 'object') {
      throw new ValidationError('ExecuteRun job is required');
    }
    const runId = assertUlid(job.runId, 'runId');
    const orgId = assertUlid(job.orgId, 'orgId');
    const jobTraceId = normalizeTraceId(job.traceId);
    if (typeof job.workerId !== 'string' || !job.workerId.trim()) {
      throw new ValidationError('workerId is required');
    }
    const workerId = job.workerId.trim();
    // Unique acquisition token per execute attempt (workerId is metadata only).
    // Prevents a delayed release from an old attempt from dropping a newer lease
    // that happens to share the same worker identity.
    const leaseOwnerToken = generateRunLeaseOwnerToken(workerId);

    const acquired = await this.leaseManager.acquire(runId, leaseOwnerToken);
    if (!acquired) {
      return {
        status: 'lease_busy',
        runId,
        leaseBusy: true,
        outcome: null,
        error: null,
      };
    }

    const abortController = new AbortController();
    let leaseLost = false;
    let released = false;
    /** @type {unknown} */
    let releaseError = null;
    /** @type {import('./run-executor.js').RunExecutor | null} */
    let jobExecutor = null;
    const createdViaFactory = typeof this.runExecutorFactory === 'function';

    const requestAbort = () => {
      try {
        if (!abortController.signal.aborted) abortController.abort();
      } catch {
        /* ignore */
      }
    };

    const releaseOnce = async () => {
      if (released) {
        if (releaseError) throw releaseError;
        return;
      }
      released = true;
      try {
        await this.leaseManager.release(runId, leaseOwnerToken);
      } catch (err) {
        releaseError = err;
        throw err;
      }
    };

    const renewLoop = createSerialTimeoutLoop({
      intervalMs: this.leaseRenewIntervalMs,
      isStopped: () => leaseLost,
      tick: async () => {
        try {
          const ok = await this.leaseManager.renew(runId, leaseOwnerToken);
          if (!ok) {
            leaseLost = true;
            requestAbort();
          }
        } catch {
          leaseLost = true;
          requestAbort();
        }
      },
    });
    renewLoop.start();

    /** @type {ExecuteRunResult} */
    let result = {
      status: 'UNKNOWN',
      runId,
      outcome: null,
      needsReconciliation: true,
      error: null,
    };

    try {
      jobExecutor = await this.#resolveExecutor({ runId, orgId, workerId });
      result = await this.#runWithLease({
        runId,
        orgId,
        jobTraceId,
        workerId,
        signal: abortController.signal,
        isLeaseLost: () => leaseLost,
        requestAbort,
        executor: jobExecutor,
      });
    } catch (err) {
      // Infrastructure / unexpected — do NOT claim durable FAILED.
      result = {
        status: 'UNKNOWN',
        runId,
        outcome: null,
        needsReconciliation: true,
        error: sanitizeStatusReason(err),
      };
    } finally {
      await renewLoop.stop();

      /** @type {unknown[]} */
      const cleanupErrors = [];

      // Dispose only factory-created instances (never dispose shared concurrency=1
      // adapter mid-flight of another job — factory path is the safe default).
      if (createdViaFactory && jobExecutor && typeof jobExecutor.dispose === 'function') {
        try {
          await jobExecutor.dispose();
        } catch (err) {
          cleanupErrors.push(err);
        }
      } else if (
        !createdViaFactory &&
        jobExecutor &&
        jobExecutor === this.sharedExecutor &&
        typeof jobExecutor.dispose === 'function'
      ) {
        // Shared executor: do not dispose per job (would break concurrency).
        // dispose is owner-managed at worker shutdown.
      }

      try {
        await releaseOnce();
      } catch (err) {
        cleanupErrors.push(err);
      }

      if (cleanupErrors.length) {
        const cleanupMsg =
          cleanupErrors.length === 1
            ? sanitizeStatusReason(cleanupErrors[0])
            : sanitizeStatusReason(
                new AggregateError(cleanupErrors, 'execute cleanup failures'),
              );
        // Never rewrite a durable SUCCEEDED/terminal success to FAILED.
        if (
          result.status === RUN_STATUS.SUCCEEDED ||
          result.status === RUN_STATUS.CANCELLED ||
          result.status === RUN_STATUS.FAILED ||
          isTerminalRunStatus(result.status)
        ) {
          result = {
            ...result,
            cleanupError: cleanupMsg,
          };
        } else if (!result.error) {
          result = {
            ...result,
            cleanupError: cleanupMsg,
            error: cleanupMsg,
          };
        } else {
          result = {
            ...result,
            cleanupError: cleanupMsg,
            error: sanitizeStatusReason(
              `${result.error}; cleanup: ${cleanupMsg}`,
            ),
          };
        }
      }
    }

    return result;
  }

  /**
   * @param {{
   *   runId: string,
   *   orgId: string,
   *   jobTraceId: string,
   *   workerId: string,
   *   signal: AbortSignal,
   *   isLeaseLost: () => boolean,
   *   requestAbort: () => void,
   *   executor: import('./run-executor.js').RunExecutor,
   * }} ctx
   */
  async #runWithLease(ctx) {
    const {
      runId,
      orgId,
      workerId,
      signal,
      isLeaseLost,
      requestAbort,
      executor,
    } = ctx;

    let run = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.runs.requireByIdForOrg(runId, orgId, { forUpdate: true });
    });

    const scope = { orgId: run.orgId, userId: run.userId };
    const traceId =
      typeof run.traceId === 'string' && run.traceId
        ? run.traceId
        : ctx.jobTraceId;
    /** Status when this attempt acquired the lease (before any transitions). */
    const entryStatus = run.status;

    if (isTerminalRunStatus(run.status)) {
      return {
        status: run.status,
        runId,
        outcome: run.status,
        error: null,
      };
    }

    // --- Advance toward runnable, checking cancel before each step ---
    if (await this.#isCancelRequested(runId, run)) {
      return this.#cancelBeforeRuntime(run, scope, traceId);
    }

    if (run.status === RUN_STATUS.ACCEPTED) {
      const t = await this.#transition(runId, scope, traceId, {
        from: RUN_STATUS.ACCEPTED,
        to: RUN_STATUS.QUEUED,
        eventType: 'run.queued',
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
    }

    if (await this.#isCancelRequested(runId, run)) {
      return this.#cancelBeforeRuntime(run, scope, traceId);
    }

    if (run.status === RUN_STATUS.RETRYING) {
      const t = await this.#transition(runId, scope, traceId, {
        from: RUN_STATUS.RETRYING,
        to: RUN_STATUS.QUEUED,
        eventType: 'run.queued',
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
    }

    if (run.status === RUN_STATUS.QUEUED) {
      if (await this.#isCancelRequested(runId, run)) {
        return this.#cancelBeforeRuntime(run, scope, traceId);
      }
      const attempt = Number(run.attempt || 0) + 1;
      const t = await this.#transition(runId, scope, traceId, {
        from: RUN_STATUS.QUEUED,
        to: RUN_STATUS.STARTING,
        eventType: 'run.started',
        attempt,
        startedAt: this.now(),
        payloadExtra: { attempt },
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
      else {
        return {
          status: run.status,
          runId,
          outcome: null,
          needsReconciliation: true,
          error: 'STARTING transition conflict',
        };
      }
    }

    if (run.status === RUN_STATUS.CANCELLING) {
      return this.#finishCancelled(run, scope, traceId);
    }
    if (run.status === RUN_STATUS.WAITING_APPROVAL) {
      const resumed = await this.#resumeApprovalIfResolved(run, scope, traceId);
      if (!resumed.ok) {
        return {
          status: run.status,
          runId,
          outcome: resumed.pending ? run.status : null,
          needsReconciliation: !resumed.pending,
          error: resumed.pending ? null : resumed.reason,
        };
      }
      run = {
        ...resumed.run,
        // Ephemeral worker-to-executor context only; Redis jobs remain ref-only.
        approvalResume: resumed.approvalResume,
      };
    }
    if (run.status === RUN_STATUS.WAITING_INPUT) {
      const resumed = await this.#resumeInputIfResolved(run, scope, traceId);
      if (!resumed.ok) {
        return {
          status: run.status,
          runId,
          outcome: resumed.pending ? run.status : null,
          needsReconciliation: !resumed.pending,
          error: resumed.pending ? null : resumed.reason,
        };
      }
      run = {
        ...resumed.run,
        // Ephemeral continuation; BullMQ payload remains ref-only.
        interactionResume: resumed.interactionResume,
      };
    }

    if (entryStatus === RUN_STATUS.RUNNING) {
      const resumed = await this.#resumeClaimedInput(run, scope);
      if (resumed.applied) {
        return this.#finishRecoveredInput(run, scope, traceId, resumed.interactionId);
      }
      if (resumed.ok) {
        run = {
          ...run,
          interactionResume: resumed.interactionResume,
        };
      }
    }

    if (isLeaseLost() || signal.aborted) {
      return {
        status: run.status,
        runId,
        outcome: null,
        needsReconciliation: true,
        error: 'lease lost before runtime',
      };
    }

    // Re-entry after crash / stall while already STARTING or RUNNING:
    // refuse blind re-prompt (double side effects). Honor cancel only.
    // Recovery scan fail-closes lease-free STARTING/RUNNING → FAILED.
    if (
      entryStatus === RUN_STATUS.STARTING ||
      (entryStatus === RUN_STATUS.RUNNING && !run.interactionResume)
    ) {
      if (await this.#isCancelRequested(runId, run)) {
        return this.#cancelBeforeRuntime(run, scope, traceId);
      }
      if (run.status === RUN_STATUS.CANCELLING) {
        return this.#finishCancelled(run, scope, traceId);
      }
      return {
        status: run.status,
        runId,
        outcome: null,
        needsReconciliation: true,
        error:
          'refusing re-entry into STARTING/RUNNING without recovery fence (no re-prompt)',
      };
    }

    // STARTING + cancel: sole SM requires STARTING→RUNNING before CANCELLING.
    if (
      run.status === RUN_STATUS.STARTING &&
      (await this.#isCancelRequested(runId, run))
    ) {
      return this.#cancelBeforeRuntime(run, scope, traceId);
    }

    // STARTING → RUNNING (enter runtime) — only when we advanced into STARTING
    // on this attempt (entry was QUEUED/ACCEPTED/RETRYING).
    if (run.status === RUN_STATUS.STARTING) {
      const t = await this.#transition(runId, scope, traceId, {
        from: RUN_STATUS.STARTING,
        to: RUN_STATUS.RUNNING,
        eventType: 'run.status.changed',
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
    }

    if (await this.#isCancelRequested(runId, run)) {
      // Runtime not yet started — cancel without executor.
      return this.#cancelBeforeRuntime(run, scope, traceId);
    }

    if (run.status !== RUN_STATUS.RUNNING) {
      return {
        status: run.status,
        runId,
        outcome: null,
        needsReconciliation: true,
        error: sanitizeStatusReason(
          `unexpected status before runtime: ${run.status}`,
        ),
      };
    }

    // --- Runtime with cancel watcher ---
    return this.#executeWithCancelWatch({
      run,
      scope,
      traceId,
      workerId,
      signal,
      isLeaseLost,
      requestAbort,
      executor,
    });
  }

  /**
   * Run executor while a serial cancel watcher polls Redis + MySQL intent.
   * On cancel: CAS RUNNING→CANCELLING once, abort, await executor, then CANCELLED.
   *
   * @param {{
   *   run: object,
   *   scope: { orgId: string, userId: string },
   *   traceId: string,
   *   workerId: string,
   *   signal: AbortSignal,
   *   isLeaseLost: () => boolean,
   *   requestAbort: () => void,
   *   executor: import('./run-executor.js').RunExecutor,
   * }} args
   */
  async #executeWithCancelWatch(args) {
    const {
      scope,
      traceId,
      workerId,
      signal,
      isLeaseLost,
      requestAbort,
      executor,
    } = args;
    let run = args.run;
    const runId = run.runId;

    /** @type {{ handled: boolean, promise: Promise<void> | null }} */
    const cancelGate = { handled: false, promise: null };

    const onCancelDetected = async () => {
      if (cancelGate.handled) return cancelGate.promise;
      cancelGate.handled = true;
      cancelGate.promise = (async () => {
        // Sole SM: RUNNING → CANCELLING (idempotent if concurrent).
        run = await this.#reload(runId, scope);
        if (
          run.status === RUN_STATUS.RUNNING &&
          this.stateMachine.canTransition(RUN_STATUS.RUNNING, RUN_STATUS.CANCELLING)
        ) {
          const t = await this.#transition(runId, scope, traceId, {
            from: RUN_STATUS.RUNNING,
            to: RUN_STATUS.CANCELLING,
            eventType: 'run.status.changed',
            statusReason: run.cancelReason,
          });
          if (t.ok) run = t.run;
          else if (t.current) run = t.current;
        }
        requestAbort();
      })();
      return cancelGate.promise;
    };

    const cancelLoop = createSerialTimeoutLoop({
      intervalMs: this.cancelPollIntervalMs,
      isStopped: () => cancelGate.handled || isLeaseLost() || signal.aborted,
      tick: async () => {
        if (cancelGate.handled || isLeaseLost()) return;
        // Fresh MySQL durable intent (fact) + Redis signal (acceleration).
        run = await this.#reload(runId, scope);
        if (await this.#isCancelRequested(runId, run)) {
          await onCancelDetected();
        }
      },
    });
    cancelLoop.start();

    let execResult;
    try {
      execResult = normalizeExecutorResult(
        await executor.execute({
          run,
          scope,
          workerId,
          signal,
        }),
      );
    } catch (err) {
      await cancelLoop.stop();
      if (cancelGate.promise) await cancelGate.promise;
      if (isLeaseLost() || signal.aborted || cancelGate.handled) {
        run = await this.#reload(runId, scope);
        if (cancelGate.handled || run.status === RUN_STATUS.CANCELLING) {
          return this.#finishCancelled(run, scope, traceId);
        }
        return {
          status: run.status,
          runId,
          needsReconciliation: true,
          error: sanitizeStatusReason(err) ?? 'aborted during runtime',
        };
      }
      // Durable failure path: write FAILED
      execResult = {
        outcome: RUN_STATUS.FAILED,
        statusReason: sanitizeStatusReason(err),
      };
    } finally {
      await cancelLoop.stop();
      if (cancelGate.promise) await cancelGate.promise;
    }

    if (isLeaseLost()) {
      return {
        status: RUN_STATUS.RUNNING,
        runId,
        needsReconciliation: true,
        error: 'lease lost during runtime; no success write',
      };
    }

    run = await this.#reload(runId, scope);

    // Cancel path completed or requested after/during run.
    if (
      cancelGate.handled ||
      run.status === RUN_STATUS.CANCELLING ||
      (await this.#isCancelRequested(runId, run)) ||
      execResult.outcome === RUN_STATUS.CANCELLED ||
      signal.aborted
    ) {
      if (
        run.status !== RUN_STATUS.CANCELLING &&
        !isTerminalRunStatus(run.status)
      ) {
        await this.#transitionToCancelling(run, scope, traceId);
        run = await this.#reload(runId, scope);
      }
      return this.#finishCancelled(run, scope, traceId);
    }

    return this.#applyExecutorOutcome(run, scope, traceId, execResult);
  }

  /**
   * Cancel before executor starts. Legal SM path for STARTING:
   * STARTING → RUNNING → CANCELLING → CANCELLED.
   *
   * @param {object} run
   * @param {{ orgId: string, userId: string }} scope
   * @param {string} traceId
   */
  async #cancelBeforeRuntime(run, scope, traceId) {
    if (isTerminalRunStatus(run.status)) {
      return {
        status: run.status,
        runId: run.runId,
        outcome: run.status,
        cancelled: run.status === RUN_STATUS.CANCELLED,
        error: null,
      };
    }

    // ACCEPTED → QUEUED if needed
    if (run.status === RUN_STATUS.ACCEPTED) {
      const t = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.ACCEPTED,
        to: RUN_STATUS.QUEUED,
        eventType: 'run.queued',
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
    }

    // QUEUED → CANCELLING directly (legal)
    if (run.status === RUN_STATUS.QUEUED) {
      const t = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.QUEUED,
        to: RUN_STATUS.CANCELLING,
        eventType: 'run.status.changed',
        statusReason: run.cancelReason,
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
      return this.#finishCancelled(run, scope, traceId);
    }

    // STARTING → RUNNING → CANCELLING (no invent STARTING→CANCELLING)
    if (run.status === RUN_STATUS.STARTING) {
      const toRun = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.STARTING,
        to: RUN_STATUS.RUNNING,
        eventType: 'run.status.changed',
      });
      if (toRun.ok) run = toRun.run;
      else if (toRun.current) run = toRun.current;
    }

    if (run.status === RUN_STATUS.RUNNING) {
      const t = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.RUNNING,
        to: RUN_STATUS.CANCELLING,
        eventType: 'run.status.changed',
        statusReason: run.cancelReason,
      });
      if (t.ok) run = t.run;
      else if (t.current) run = t.current;
    }

    if (run.status === RUN_STATUS.CANCELLING) {
      return this.#finishCancelled(run, scope, traceId);
    }

    // Fallback: try general path
    const c = await this.#transitionToCancelling(run, scope, traceId);
    if (c.ok) run = c.run;
    else if (c.current) run = c.current;
    return this.#finishCancelled(run, scope, traceId);
  }

  /**
   * @param {string} runId
   * @param {object} run — may already include cancelRequestedAt from a fresh reload
   */
  async #isCancelRequested(runId, run) {
    if (run?.cancelRequestedAt) return true;
    if (!this.cancelSignal) return false;
    try {
      return await this.cancelSignal.isRequested(runId);
    } catch {
      // Redis is acceleration only — MySQL intent remains authoritative.
      return false;
    }
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   */
  async #reload(runId, scope) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.runs.requireById(runId, scope);
    });
  }

  /**
   * Claim a resolved approval pause for runtime re-entry. The Run stays parked
   * until a worker owns the lease; Redis failure therefore cannot create a
   * phantom RUNNING state.
   */
  async #resumeApprovalIfResolved(run, scope, traceId) {
    this.stateMachine.assertTransition(
      RUN_STATUS.WAITING_APPROVAL,
      RUN_STATUS.RUNNING,
    );
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const current = await repos.runs.getById(run.runId, scope, {
        forUpdate: true,
      });
      if (!current) {
        return { ok: false, pending: false, reason: 'Run not found' };
      }
      if (current.status === RUN_STATUS.RUNNING) {
        return {
          ok: false,
          pending: false,
          reason: 'approval resume was already claimed by another worker',
        };
      }
      if (current.status !== RUN_STATUS.WAITING_APPROVAL) {
        return {
          ok: false,
          pending: false,
          reason: `Run is ${current.status}, expected WAITING_APPROVAL`,
        };
      }
      const approvals = await repos.approvals.listByRunId(run.runId, scope, {
        forUpdate: true,
      });
      if (
        approvals.length === 0 ||
        approvals.some(
          (approval) => approval.status === APPROVAL_STATUS.PENDING,
        )
      ) {
        return { ok: false, pending: true, reason: null };
      }
      const approval = [...approvals]
        .reverse()
        .find((candidate) => isTerminalApprovalStatus(candidate.status));
      if (!approval) {
        return {
          ok: false,
          pending: false,
          reason: 'Run has no terminal approval',
        };
      }
      const toolExecution = await repos.toolExecutions.getById(
        approval.toolExecutionId,
        scope,
        { forUpdate: true },
      );
      const resumable =
        (approval.status === APPROVAL_STATUS.APPROVED &&
          toolExecution.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) ||
        (approval.status === APPROVAL_STATUS.REJECTED &&
          toolExecution.status === TOOL_EXECUTION_STATUS.FAILED);
      if (!resumable) {
        return {
          ok: false,
          pending: false,
          reason: sanitizeStatusReason(
            `approval/tool state is not resumable (${approval.status}/${toolExecution.status})`,
          ),
        };
      }

      const transitioned = await applyRunTransitionInTxn({
        repos,
        runId: run.runId,
        scope,
        from: RUN_STATUS.WAITING_APPROVAL,
        to: RUN_STATUS.RUNNING,
        traceId,
        generateId: this.generateId,
        eventType: 'run.status.changed',
        statusReason: null,
        payloadExtra: {
          approvalId: approval.approvalId,
          approvalStatus: approval.status,
          toolExecutionId: toolExecution.toolExecutionId,
        },
      });
      if (!transitioned.ok) {
        return {
          ok: false,
          pending: false,
          reason: 'approval resume transition conflict',
        };
      }
      return {
        ok: true,
        run: transitioned.run,
        approvalResume: {
          approvalId: approval.approvalId,
          status: approval.status,
          toolExecutionId: toolExecution.toolExecutionId,
          toolCallId: toolExecution.toolCallId,
          toolName: toolExecution.toolName,
          arguments: toolExecution.argumentsJson ?? {},
        },
      };
    });
  }

  /** Claim a resolved WAITING_INPUT interaction under the Run lease. */
  async #resumeInputIfResolved(run, scope, traceId) {
    this.stateMachine.assertTransition(
      RUN_STATUS.WAITING_INPUT,
      RUN_STATUS.RUNNING,
    );
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      if (!repos.interactions) {
        return {
          ok: false,
          pending: false,
          reason: 'interaction repository unavailable',
        };
      }
      const current = await repos.runs.getById(run.runId, scope, {
        forUpdate: true,
      });
      if (!current) return { ok: false, pending: false, reason: 'Run not found' };
      if (current.status !== RUN_STATUS.WAITING_INPUT) {
        return {
          ok: false,
          pending: false,
          reason: `Run is ${current.status}, expected WAITING_INPUT`,
        };
      }
      const interactions = await repos.interactions.listByRunId(
        run.runId,
        scope,
        { forUpdate: true },
      );
      if (
        interactions.length === 0 ||
        interactions.some((item) => item.status === INTERACTION_STATUS.PENDING)
      ) {
        return { ok: false, pending: true, reason: null };
      }
      const interaction = [...interactions]
        .reverse()
        .find((item) => item.status === INTERACTION_STATUS.RESOLVED);
      if (!interaction) {
        return {
          ok: false,
          pending: false,
          reason: 'Run has no resolved interaction',
        };
      }
      const toolExecution = await repos.toolExecutions.getById(
        interaction.toolExecutionId,
        scope,
        { forUpdate: true },
      );
      if (
        toolExecution.runId !== run.runId ||
        toolExecution.toolCallId !== interaction.toolCallId ||
        toolExecution.status !== TOOL_EXECUTION_STATUS.SUCCEEDED
      ) {
        return {
          ok: false,
          pending: false,
          reason: sanitizeStatusReason(
            `interaction/tool state is not resumable (${interaction.status}/${toolExecution.status})`,
          ),
        };
      }
      const claimed = await repos.interactions.claimResumeIfReady(
        interaction.interactionId,
        scope,
      );
      if (
        !claimed.changed &&
        claimed.interaction.resumePhase !== INTERACTION_RESUME_PHASE.CLAIMED
      ) {
        return {
          ok: false,
          pending: false,
          reason:
            `interaction resume phase is ${claimed.interaction.resumePhase}; ` +
            'expected READY',
        };
      }
      const transitioned = await applyRunTransitionInTxn({
        repos,
        runId: run.runId,
        scope,
        from: RUN_STATUS.WAITING_INPUT,
        to: RUN_STATUS.RUNNING,
        traceId,
        generateId: this.generateId,
        eventType: 'run.status.changed',
        statusReason: null,
        payloadExtra: {
          interactionId: interaction.interactionId,
          interactionStatus: interaction.status,
          resumePhase: INTERACTION_RESUME_PHASE.CLAIMED,
          toolExecutionId: toolExecution.toolExecutionId,
        },
      });
      if (!transitioned.ok) {
        return {
          ok: false,
          pending: false,
          reason: 'interaction resume transition conflict',
        };
      }
      return {
        ok: true,
        run: transitioned.run,
        interactionResume: {
          interactionId: interaction.interactionId,
          status: interaction.status,
          interactionType: interaction.interactionType,
          response: interaction.responseJson,
          responseHash: interaction.responseHash,
          resumePhase: INTERACTION_RESUME_PHASE.CLAIMED,
          toolExecutionId: toolExecution.toolExecutionId,
          toolCallId: toolExecution.toolCallId,
          toolName: toolExecution.toolName,
        },
      };
    });
  }

  /**
   * Crash recovery after the durable claim committed but before Pi checkpointed
   * the answered tool-result. The CLAIMED phase is the explicit replay fence;
   * ordinary RUNNING jobs still fail closed above.
   */
  async #resumeClaimedInput(run, scope) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      if (!repos.interactions) return { ok: false };
      const interactions = await repos.interactions.listByRunId(
        run.runId,
        scope,
        { forUpdate: true },
      );
      const interaction = [...interactions].reverse().find(
        (item) =>
          item.status === INTERACTION_STATUS.RESOLVED &&
          [
            INTERACTION_RESUME_PHASE.CLAIMED,
            INTERACTION_RESUME_PHASE.APPLIED,
          ].includes(item.resumePhase),
      );
      if (!interaction) return { ok: false };
      if (interaction.resumePhase === INTERACTION_RESUME_PHASE.APPLIED) {
        return {
          applied: true,
          interactionId: interaction.interactionId,
        };
      }
      if (interaction.resumePhase !== INTERACTION_RESUME_PHASE.CLAIMED) {
        return { ok: false };
      }
      const toolExecution = await repos.toolExecutions.getById(
        interaction.toolExecutionId,
        scope,
        { forUpdate: true },
      );
      if (
        toolExecution.runId !== run.runId ||
        toolExecution.agentSessionId !== run.agentSessionId ||
        toolExecution.toolCallId !== interaction.toolCallId ||
        toolExecution.status !== TOOL_EXECUTION_STATUS.SUCCEEDED
      ) {
        return { ok: false };
      }
      return {
        ok: true,
        interactionResume: {
          interactionId: interaction.interactionId,
          status: interaction.status,
          interactionType: interaction.interactionType,
          response: interaction.responseJson,
          responseHash: interaction.responseHash,
          resumePhase: interaction.resumePhase,
          toolExecutionId: toolExecution.toolExecutionId,
          toolCallId: toolExecution.toolCallId,
          toolName: toolExecution.toolName,
        },
      };
    });
  }

  async #finishRecoveredInput(run, scope, traceId, interactionId) {
    const transitioned = await this.#transition(run.runId, scope, traceId, {
      from: RUN_STATUS.RUNNING,
      to: RUN_STATUS.SUCCEEDED,
      eventType: 'run.completed',
      completedAt: this.now(),
      statusReason: null,
      payloadExtra: {
        recoveredInteractionId: interactionId,
        continuationCheckpointed: true,
      },
    });
    if (transitioned.ok) {
      return {
        status: RUN_STATUS.SUCCEEDED,
        runId: run.runId,
        outcome: RUN_STATUS.SUCCEEDED,
        error: null,
      };
    }
    return {
      status: transitioned.current?.status ?? run.status,
      runId: run.runId,
      outcome: null,
      needsReconciliation: true,
      error: 'recovered interaction terminal transition conflict',
    };
  }

  /**
   * @param {string} runId
   * @param {{ orgId: string, userId: string }} scope
   * @param {string} traceId
   * @param {object} opts
   */
  async #transition(runId, scope, traceId, opts) {
    this.stateMachine.assertTransition(opts.from, opts.to);
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return applyRunTransitionInTxn({
        repos,
        runId,
        scope,
        from: opts.from,
        to: opts.to,
        traceId,
        generateId: this.generateId,
        eventType: opts.eventType,
        statusReason: opts.statusReason,
        attempt: opts.attempt,
        startedAt: opts.startedAt,
        completedAt: opts.completedAt,
        payloadExtra: opts.payloadExtra,
      });
    });
  }

  /**
   * @param {object} run
   * @param {{ orgId: string, userId: string }} scope
   * @param {string} traceId
   */
  async #transitionToCancelling(run, scope, traceId) {
    if (run.status === RUN_STATUS.CANCELLING) return { ok: true, run };

    if (run.status === RUN_STATUS.ACCEPTED) {
      const q = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.ACCEPTED,
        to: RUN_STATUS.QUEUED,
        eventType: 'run.queued',
      });
      if (q.ok) run = q.run;
      else if (q.current) run = q.current;
    }

    if (run.status === RUN_STATUS.STARTING) {
      const r = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.STARTING,
        to: RUN_STATUS.RUNNING,
        eventType: 'run.status.changed',
      });
      if (r.ok) run = r.run;
      else if (r.current) run = r.current;
    }

    if (this.stateMachine.canTransition(run.status, RUN_STATUS.CANCELLING)) {
      return this.#transition(run.runId, scope, traceId, {
        from: run.status,
        to: RUN_STATUS.CANCELLING,
        eventType: 'run.status.changed',
        statusReason: run.cancelReason,
      });
    }
    return { ok: false, current: run };
  }

  /**
   * @param {object} run
   * @param {{ orgId: string, userId: string }} scope
   * @param {string} traceId
   */
  async #finishCancelled(run, scope, traceId) {
    if (run.status === RUN_STATUS.CANCELLED) {
      return {
        status: RUN_STATUS.CANCELLED,
        runId: run.runId,
        outcome: RUN_STATUS.CANCELLED,
        cancelled: true,
        error: null,
      };
    }
    if (run.status !== RUN_STATUS.CANCELLING) {
      return {
        status: run.status,
        runId: run.runId,
        outcome: null,
        cancelled: true,
        needsReconciliation: true,
        error: 'cancel intent recorded; awaiting legal CANCELLING edge',
      };
    }
    const t = await this.#transition(run.runId, scope, traceId, {
      from: RUN_STATUS.CANCELLING,
      to: RUN_STATUS.CANCELLED,
      eventType: 'run.cancelled',
      completedAt: this.now(),
      statusReason: run.cancelReason,
    });
    if (t.ok) {
      return {
        status: RUN_STATUS.CANCELLED,
        runId: run.runId,
        outcome: RUN_STATUS.CANCELLED,
        cancelled: true,
        error: null,
      };
    }
    const current = t.current;
    return {
      status: current?.status ?? run.status,
      runId: run.runId,
      outcome: current?.status ?? null,
      cancelled: true,
      needsReconciliation: true,
      error: 'CANCELLED transition conflict',
    };
  }

  /**
   * @param {object} run
   * @param {{ orgId: string, userId: string }} scope
   * @param {string} traceId
   * @param {import('./run-executor.js').RunExecutorResult} execResult
   */
  async #applyExecutorOutcome(run, scope, traceId, execResult) {
    const outcome = execResult.outcome;
    let currentFrom = run.status;

    if (isTerminalRunStatus(currentFrom)) {
      return {
        status: currentFrom,
        runId: run.runId,
        outcome: currentFrom,
        error: null,
      };
    }

    // requestApproval may already have atomically persisted the waiting state
    // before PiRunExecutor returns the same outcome.
    if (currentFrom === outcome) {
      return {
        status: currentFrom,
        runId: run.runId,
        outcome: currentFrom,
        error: null,
      };
    }

    if (currentFrom === RUN_STATUS.STARTING && outcome !== RUN_STATUS.FAILED) {
      const toRunning = await this.#transition(run.runId, scope, traceId, {
        from: RUN_STATUS.STARTING,
        to: RUN_STATUS.RUNNING,
        eventType: 'run.status.changed',
      });
      if (toRunning.ok) currentFrom = RUN_STATUS.RUNNING;
      else if (toRunning.current) currentFrom = toRunning.current.status;
    }

    let to = outcome;
    let eventType = 'run.status.changed';
    /** @type {Date | undefined} */
    let completedAt;
    if (
      outcome === RUN_STATUS.SUCCEEDED ||
      outcome === RUN_STATUS.FAILED ||
      outcome === RUN_STATUS.CANCELLED
    ) {
      completedAt = this.now();
      if (outcome === RUN_STATUS.SUCCEEDED) eventType = 'run.completed';
      if (outcome === RUN_STATUS.FAILED) eventType = 'run.failed';
      if (outcome === RUN_STATUS.CANCELLED) eventType = 'run.cancelled';
    }

    if (!this.stateMachine.canTransition(currentFrom, to)) {
      if (
        outcome === RUN_STATUS.FAILED &&
        this.stateMachine.canTransition(currentFrom, RUN_STATUS.FAILED)
      ) {
        to = RUN_STATUS.FAILED;
      } else if (
        outcome === RUN_STATUS.RETRYING &&
        this.stateMachine.canTransition(currentFrom, RUN_STATUS.RETRYING)
      ) {
        to = RUN_STATUS.RETRYING;
      } else {
        return {
          status: currentFrom,
          runId: run.runId,
          outcome: null,
          needsReconciliation: true,
          error: sanitizeStatusReason(
            `illegal transition ${currentFrom}→${to}`,
          ),
        };
      }
    }

    const t = await this.#transition(run.runId, scope, traceId, {
      from: currentFrom,
      to,
      eventType,
      statusReason: execResult.statusReason,
      completedAt,
    });

    if (t.ok) {
      return {
        status: t.run.status,
        runId: run.runId,
        outcome: t.run.status,
        error: null,
      };
    }
    return {
      status: t.current?.status ?? currentFrom,
      runId: run.runId,
      outcome: t.current?.status ?? null,
      needsReconciliation: true,
      error: 'outcome transition conflict',
    };
  }
}
