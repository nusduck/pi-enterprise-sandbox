/**
 * RunExecutor / RuntimeAdapter seam (PR-04 T3 → PR-05 Pi Factory).
 *
 * T3 defines the injectable interface and a no-op / stub executor only.
 * PR-05 slice B implements {@link import('./pi-run-executor.js').PiRunExecutor}
 * behind this contract (not production default — inject via factory).
 *
 * ## emit seam
 * `RunExecutorContext.emit` exists for optional observability hooks, but
 * {@link import('./execute-run-service.js').ExecuteRunService} does **not**
 * pass it. Durable Pi → RunEvent+Outbox projection is owned solely by
 * PiRunExecutor's internal fenced event recorder. PR-06 observability must
 * call into that recorder (or subscribe after projection) — never double-write
 * and never use a process-local Map as authority.
 *
 * Outcomes use plan §10 statuses (or legacy strings routed solely through
 * {@link mapLegacyRuntimeOutcome}).
 */

import { mapLegacyRuntimeOutcome } from '../domain/run/legacy-status.js';
import { RUN_STATUS } from '../domain/run/run-status.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';

/**
 * @typedef {'SUCCEEDED'|'FAILED'|'CANCELLED'|'WAITING_APPROVAL'|'WAITING_INPUT'|'RETRYING'} RunExecutorOutcomeStatus
 */

/**
 * @typedef {{
 *   outcome: RunExecutorOutcomeStatus,
 *   statusReason?: string | null,
 *   legacyOutcome?: string | null,
 * }} RunExecutorResult
 */

/**
 * @typedef {{
 *   run: object,
 *   scope: { orgId: string, userId: string },
 *   workerId: string,
 *   signal: AbortSignal,
 *   emit?: (event: { type: string, payload?: Record<string, unknown> }) => Promise<void>,
 * }} RunExecutorContext
 */

/**
 * @typedef {{
 *   execute: (ctx: RunExecutorContext) => Promise<RunExecutorResult>,
 *   dispose?: () => Promise<void> | void,
 * }} RunExecutor
 */

/**
 * Factory preferred by ExecuteRunService / worker for concurrency > 1.
 * Each job gets its own instance; dispose runs after that job only.
 *
 * @typedef {(job: { runId: string, orgId: string, workerId: string }) => RunExecutor | Promise<RunExecutor>} RunExecutorFactory
 *
 * Shared single `runExecutor` instance is only safe at concurrency=1 —
 * disposing it would break sibling jobs.
 */

/**
 * Normalize an executor result (legacy outcome → plan §10 via sole mapper).
 * @param {RunExecutorResult | { outcome?: unknown, legacyOutcome?: string, statusReason?: unknown }} result
 * @returns {RunExecutorResult}
 */
export function normalizeExecutorResult(result) {
  if (!result || typeof result !== 'object') {
    return { outcome: RUN_STATUS.FAILED, statusReason: 'empty executor result' };
  }

  let outcome;
  if (typeof result.legacyOutcome === 'string' && result.legacyOutcome) {
    outcome = mapLegacyRuntimeOutcome(result.legacyOutcome);
  } else if (typeof result.outcome === 'string') {
    // Accept plan §10 or legacy via mapper when needed.
    try {
      outcome = mapLegacyRuntimeOutcome(result.outcome);
    } catch {
      outcome = result.outcome;
    }
  } else {
    outcome = RUN_STATUS.FAILED;
  }

  const allowed = new Set([
    RUN_STATUS.SUCCEEDED,
    RUN_STATUS.FAILED,
    RUN_STATUS.CANCELLED,
    RUN_STATUS.WAITING_APPROVAL,
    RUN_STATUS.WAITING_INPUT,
    RUN_STATUS.RETRYING,
  ]);
  if (!allowed.has(outcome)) {
    return {
      outcome: RUN_STATUS.FAILED,
      statusReason: sanitizeStatusReason(
        `unsupported executor outcome: ${String(outcome)}`,
      ),
    };
  }

  return {
    outcome: /** @type {RunExecutorOutcomeStatus} */ (outcome),
    statusReason: sanitizeStatusReason(result.statusReason),
  };
}

/**
 * Stub executor for T3 tests / offline wiring.
 * Completes immediately with SUCCEEDED unless aborted (CANCELLED).
 *
 * @param {{ outcome?: RunExecutorOutcomeStatus, delayMs?: number, onExecute?: (ctx: RunExecutorContext) => Promise<RunExecutorResult> | RunExecutorResult }} [opts]
 * @returns {RunExecutor}
 */
export function createStubRunExecutor(opts = {}) {
  return {
    async execute(ctx) {
      if (typeof opts.onExecute === 'function') {
        return normalizeExecutorResult(await opts.onExecute(ctx));
      }
      if (ctx.signal?.aborted) {
        return { outcome: RUN_STATUS.CANCELLED, statusReason: 'aborted' };
      }
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          const onAbort = () => {
            clearTimeout(t);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          };
          if (ctx.signal) {
            if (ctx.signal.aborted) {
              onAbort();
              return;
            }
            ctx.signal.addEventListener('abort', onAbort, { once: true });
          }
        }).catch((err) => {
          if (err?.name === 'AbortError' || ctx.signal?.aborted) {
            return;
          }
          throw err;
        });
        if (ctx.signal?.aborted) {
          return { outcome: RUN_STATUS.CANCELLED, statusReason: 'aborted' };
        }
      }
      return {
        outcome: opts.outcome ?? RUN_STATUS.SUCCEEDED,
        statusReason: null,
      };
    },
    async dispose() {
      // no-op
    },
  };
}
