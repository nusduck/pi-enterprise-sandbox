/**
 * RunRecoveryService / requeue (PR-04 T3 + severe recovery follow-up).
 *
 * Scans MySQL non-terminal runs (system-worker API — not owner API) and
 * re-enqueues ref-only jobs. Does **not** treat Redis as fact source.
 *
 * Coverage:
 *  - ACCEPTED: enqueue failed or replay never recovered → enqueue + project QUEUED
 *  - QUEUED: job may be lost → re-enqueue (deterministic jobId=runId)
 *  - RETRYING: SM edge RETRYING→QUEUED then enqueue
 *  - CANCELLING: no live lease → durable CANCELLING→CANCELLED (no re-exec)
 *  - STARTING / RUNNING: if lease free → fail-closed FAILED (no blind re-prompt);
 *    if lease held → skip (worker still owns the run)
 *
 * Duplicate enqueue is safe via BullMQ jobId = runId.
 */

import {
  isTerminalRunStatus,
  RUN_STATUS,
  runStateMachine,
} from '../domain/run/index.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { applyRunTransitionInTxn } from './run-transition.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';

/** Statuses that recovery will re-enqueue. */
export const RECOVERY_ENQUEUE_STATUSES = Object.freeze([
  RUN_STATUS.ACCEPTED,
  RUN_STATUS.QUEUED,
  RUN_STATUS.RETRYING,
]);

/** Statuses that fail-close when lease is free (no blind re-exec). */
export const RECOVERY_RECONCILE_STATUSES = Object.freeze([
  RUN_STATUS.STARTING,
  RUN_STATUS.RUNNING,
]);

/**
 * @typedef {{
 *   runId: string,
 *   orgId: string,
 *   traceId: string,
 *   status: string,
 *   action:
 *     | 'enqueued'
 *     | 'projected_and_enqueued'
 *     | 'needsReconciliation'
 *     | 'terminalized'
 *     | 'skipped'
 *     | 'error',
 *   reason?: string | null,
 * }} RecoveryAction
 */

export class RunRecoveryService {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => { runs: any, runEvents: any, outbox: any },
   *   runQueue: { enqueue: (ref: { runId: string, orgId: string, traceId: string }) => Promise<unknown> },
   *   generateId: () => string,
   *   runStateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
   *   now?: () => Date,
   *   leaseManager?: { getOwner: (runId: string) => Promise<string | null> } | null,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('RunRecoveryService requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('RunRecoveryService requires createRepositories');
    }
    if (!deps.runQueue?.enqueue) {
      throw new Error('RunRecoveryService requires runQueue.enqueue');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('RunRecoveryService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.runQueue = deps.runQueue;
    this.generateId = deps.generateId;
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.now = deps.now ?? (() => new Date());
    this.leaseManager = deps.leaseManager ?? null;
  }

  /**
   * Bounded system scan + requeue. Optional orgId for tenant-narrow recovery.
   *
   * @param {{
   *   limit?: number,
   *   afterRunId?: string | null,
   *   orgId?: string | null,
   *   statuses?: string[],
   * }} [opts]
   * @returns {Promise<{ actions: RecoveryAction[], nextAfterRunId: string | null }>}
   */
  async scanAndRequeue(opts = {}) {
    const runs = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.runs.listNonTerminalForSystemWorker({
        limit: opts.limit,
        afterRunId: opts.afterRunId,
        orgId: opts.orgId,
        statuses: opts.statuses,
      });
    });

    /** @type {RecoveryAction[]} */
    const actions = [];
    for (const run of runs) {
      actions.push(await this.#recoverOne(run));
    }

    const nextAfterRunId =
      runs.length > 0 ? String(runs[runs.length - 1].runId) : null;

    return { actions, nextAfterRunId };
  }

  /**
   * Recover a single known run by org-scoped load (worker path).
   * @param {{ runId: string, orgId: string }} ref
   */
  async recoverOneRef(ref) {
    const runId = assertUlid(ref.runId, 'runId');
    const orgId = assertUlid(ref.orgId, 'orgId');
    const run = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      return repos.runs.getByIdForOrg(runId, orgId);
    });
    if (!run) {
      return {
        runId,
        orgId,
        traceId: '',
        status: 'MISSING',
        action: /** @type {const} */ ('skipped'),
        reason: 'run not found for org',
      };
    }
    return this.#recoverOne(run);
  }

  /**
   * @param {object} run
   * @returns {Promise<RecoveryAction>}
   */
  async #recoverOne(run) {
    const runId = String(run.runId);
    const orgId = String(run.orgId);
    const traceId = String(run.traceId || '');
    const status = String(run.status);

    const base = { runId, orgId, traceId, status };

    if (isTerminalRunStatus(status)) {
      return { ...base, action: 'skipped', reason: 'terminal' };
    }

    if (status === RUN_STATUS.CANCELLING) {
      return this.#terminalizeCancelling(run, base);
    }

    if (RECOVERY_RECONCILE_STATUSES.includes(status)) {
      return this.#failClosedOrphanRuntime(run, base);
    }

    if (
      status === RUN_STATUS.WAITING_APPROVAL ||
      status === RUN_STATUS.WAITING_INPUT
    ) {
      return {
        ...base,
        action: 'skipped',
        reason: `status ${status} is not enqueue-recovered by T3`,
      };
    }

    if (!RECOVERY_ENQUEUE_STATUSES.includes(status)) {
      return {
        ...base,
        action: 'skipped',
        reason: `unsupported recovery status ${status}`,
      };
    }

    try {
      // RETRYING → QUEUED first (SM edge)
      if (status === RUN_STATUS.RETRYING) {
        const projected = await this.#projectRetryingToQueued(run);
        if (!projected.ok) {
          return {
            ...base,
            action: 'error',
            reason: projected.reason ?? 'RETRYING→QUEUED failed',
          };
        }
      }

      // ACCEPTED → project QUEUED after enqueue (same as create path)
      if (status === RUN_STATUS.ACCEPTED || status === RUN_STATUS.RETRYING) {
        await this.runQueue.enqueue({ runId, orgId, traceId });
        if (status === RUN_STATUS.ACCEPTED) {
          const proj = await this.#projectAcceptedToQueued(run);
          if (!proj.ok && !proj.alreadyAdvanced) {
            return {
              ...base,
              action: 'enqueued',
              reason: 'enqueued but QUEUED projection failed (recoverable)',
            };
          }
          return {
            ...base,
            status: RUN_STATUS.QUEUED,
            action: 'projected_and_enqueued',
          };
        }
        return {
          ...base,
          status: RUN_STATUS.QUEUED,
          action: 'projected_and_enqueued',
        };
      }

      // QUEUED: re-enqueue only
      await this.runQueue.enqueue({ runId, orgId, traceId });
      return { ...base, action: 'enqueued' };
    } catch (err) {
      return {
        ...base,
        action: 'error',
        reason: sanitizeStatusReason(err),
      };
    }
  }

  /**
   * CANCELLING with no live lease → durable CANCELLED (no runtime re-entry).
   * @param {object} run
   * @param {object} base
   * @returns {Promise<RecoveryAction>}
   */
  async #terminalizeCancelling(run, base) {
    const leaseHeld = await this.#isLeaseHeld(run.runId);
    if (leaseHeld === true) {
      return {
        ...base,
        action: 'skipped',
        reason: 'CANCELLING lease still held by a worker',
      };
    }
    // leaseHeld null (no probe) or false → safe to finish cancel (no re-exec).
    try {
      const scope = { orgId: run.orgId, userId: run.userId };
      const result = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const current = await repos.runs.getById(run.runId, scope, {
          forUpdate: true,
        });
        if (!current) return { ok: false, reason: 'missing' };
        if (current.status === RUN_STATUS.CANCELLED) {
          return { ok: true, already: true };
        }
        if (current.status !== RUN_STATUS.CANCELLING) {
          return {
            ok: false,
            reason: `status advanced to ${current.status}`,
          };
        }
        return applyRunTransitionInTxn({
          repos,
          runId: run.runId,
          scope,
          from: RUN_STATUS.CANCELLING,
          to: RUN_STATUS.CANCELLED,
          traceId: String(run.traceId || ''),
          generateId: this.generateId,
          eventType: 'run.cancelled',
          completedAt: this.now(),
          statusReason:
            current.cancelReason || 'recovered: CANCELLING with no live lease',
        });
      });
      if (result.ok) {
        return {
          ...base,
          status: RUN_STATUS.CANCELLED,
          action: 'terminalized',
          reason: result.already
            ? 'already CANCELLED'
            : 'CANCELLING→CANCELLED (no live lease)',
        };
      }
      return {
        ...base,
        action: 'error',
        reason: result.reason ?? 'CANCELLING terminalize failed',
      };
    } catch (err) {
      return {
        ...base,
        action: 'error',
        reason: sanitizeStatusReason(err),
      };
    }
  }

  /**
   * STARTING/RUNNING with no live lease → FAILED (fail-closed, no re-prompt).
   * @param {object} run
   * @param {object} base
   * @returns {Promise<RecoveryAction>}
   */
  async #failClosedOrphanRuntime(run, base) {
    const leaseHeld = await this.#isLeaseHeld(run.runId);
    if (leaseHeld === true) {
      return {
        ...base,
        action: 'skipped',
        reason: 'STARTING/RUNNING lease still held by a worker',
      };
    }
    if (leaseHeld === null) {
      // No lease probe available — refuse silent hang but do not invent FAILED.
      return {
        ...base,
        action: 'needsReconciliation',
        reason:
          'STARTING/RUNNING lease-loss recovery requires leaseManager to fail-close; no side-effect re-exec',
      };
    }
    // lease free → durable FAILED
    try {
      const scope = { orgId: run.orgId, userId: run.userId };
      const from = String(run.status);
      if (
        from !== RUN_STATUS.STARTING &&
        from !== RUN_STATUS.RUNNING
      ) {
        return {
          ...base,
          action: 'skipped',
          reason: `unexpected reconcile status ${from}`,
        };
      }
      const result = await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const current = await repos.runs.getById(run.runId, scope, {
          forUpdate: true,
        });
        if (!current) return { ok: false, reason: 'missing' };
        if (isTerminalRunStatus(current.status)) {
          return { ok: true, already: true, status: current.status };
        }
        if (
          current.status !== RUN_STATUS.STARTING &&
          current.status !== RUN_STATUS.RUNNING
        ) {
          return {
            ok: false,
            reason: `status advanced to ${current.status}`,
          };
        }
        // Cancel intent wins over FAILED when legal.
        if (current.cancelRequestedAt) {
          if (current.status === RUN_STATUS.STARTING) {
            const toRunning = await applyRunTransitionInTxn({
              repos,
              runId: run.runId,
              scope,
              from: RUN_STATUS.STARTING,
              to: RUN_STATUS.RUNNING,
              traceId: String(run.traceId || ''),
              generateId: this.generateId,
              eventType: 'run.status.changed',
            });
            if (!toRunning.ok) {
              return { ok: false, reason: 'STARTING→RUNNING for cancel failed' };
            }
          }
          const toCancelling = await applyRunTransitionInTxn({
            repos,
            runId: run.runId,
            scope,
            from: RUN_STATUS.RUNNING,
            to: RUN_STATUS.CANCELLING,
            traceId: String(run.traceId || ''),
            generateId: this.generateId,
            eventType: 'run.status.changed',
            statusReason: current.cancelReason,
          });
          if (!toCancelling.ok) {
            return { ok: false, reason: 'RUNNING→CANCELLING failed' };
          }
          const toCancelled = await applyRunTransitionInTxn({
            repos,
            runId: run.runId,
            scope,
            from: RUN_STATUS.CANCELLING,
            to: RUN_STATUS.CANCELLED,
            traceId: String(run.traceId || ''),
            generateId: this.generateId,
            eventType: 'run.cancelled',
            completedAt: this.now(),
            statusReason:
              current.cancelReason ||
              'recovered: cancel intent with no live lease',
          });
          return toCancelled.ok
            ? { ok: true, status: RUN_STATUS.CANCELLED }
            : { ok: false, reason: 'CANCELLING→CANCELLED failed' };
        }
        return applyRunTransitionInTxn({
          repos,
          runId: run.runId,
          scope,
          from: current.status,
          to: RUN_STATUS.FAILED,
          traceId: String(run.traceId || ''),
          generateId: this.generateId,
          eventType: 'run.failed',
          completedAt: this.now(),
          statusReason:
            'recovered: STARTING/RUNNING with no live lease (refused re-prompt)',
        });
      });
      if (result.ok) {
        return {
          ...base,
          status: result.status || RUN_STATUS.FAILED,
          action: 'terminalized',
          reason:
            result.already
              ? `already ${result.status}`
              : 'lease-free STARTING/RUNNING terminalized (no re-prompt)',
        };
      }
      return {
        ...base,
        action: 'error',
        reason: result.reason ?? 'orphan runtime terminalize failed',
      };
    } catch (err) {
      return {
        ...base,
        action: 'error',
        reason: sanitizeStatusReason(err),
      };
    }
  }

  /**
   * @param {string} runId
   * @returns {Promise<boolean | null>} true held, false free, null unknown
   */
  async #isLeaseHeld(runId) {
    if (!this.leaseManager || typeof this.leaseManager.getOwner !== 'function') {
      return null;
    }
    try {
      const owner = await this.leaseManager.getOwner(runId);
      return owner != null && String(owner).length > 0;
    } catch {
      // Fail closed: do not terminalize if lease probe errors.
      return true;
    }
  }

  /**
   * @param {object} run
   */
  async #projectAcceptedToQueued(run) {
    const scope = { orgId: run.orgId, userId: run.userId };
    try {
      this.stateMachine.assertTransition(
        RUN_STATUS.ACCEPTED,
        RUN_STATUS.QUEUED,
      );
      return await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const current = await repos.runs.getById(run.runId, scope, {
          forUpdate: true,
        });
        if (!current) return { ok: false, reason: 'missing' };
        if (current.status !== RUN_STATUS.ACCEPTED) {
          return { ok: true, alreadyAdvanced: true };
        }
        return applyRunTransitionInTxn({
          repos,
          runId: run.runId,
          scope,
          from: RUN_STATUS.ACCEPTED,
          to: RUN_STATUS.QUEUED,
          traceId: run.traceId,
          generateId: this.generateId,
          eventType: 'run.queued',
        });
      });
    } catch {
      return { ok: false };
    }
  }

  /**
   * @param {object} run
   */
  async #projectRetryingToQueued(run) {
    const scope = { orgId: run.orgId, userId: run.userId };
    try {
      this.stateMachine.assertTransition(
        RUN_STATUS.RETRYING,
        RUN_STATUS.QUEUED,
      );
      return await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        const current = await repos.runs.getById(run.runId, scope, {
          forUpdate: true,
        });
        if (!current) return { ok: false, reason: 'missing' };
        if (current.status === RUN_STATUS.QUEUED) {
          return { ok: true, alreadyAdvanced: true };
        }
        if (current.status !== RUN_STATUS.RETRYING) {
          return {
            ok: false,
            reason: `expected RETRYING, was ${current.status}`,
          };
        }
        return applyRunTransitionInTxn({
          repos,
          runId: run.runId,
          scope,
          from: RUN_STATUS.RETRYING,
          to: RUN_STATUS.QUEUED,
          traceId: run.traceId,
          generateId: this.generateId,
          eventType: 'run.queued',
        });
      });
    } catch (err) {
      return {
        ok: false,
        reason: sanitizeStatusReason(err),
      };
    }
  }
}

// Re-export name alias used in design language.
export { RunRecoveryService as RequeueService };
