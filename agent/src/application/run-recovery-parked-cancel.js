/**
 * Recovery for a parked Run whose cancel intent is already durable.
 *
 * A WAITING_INPUT / WAITING_APPROVAL Run has no live worker, so nothing
 * observes the cancel flag on its own. `CancelRunService` finishes the Run it
 * was called on inline; this is the path for a Run that got the intent some
 * other way — most importantly a sub-agent child reached by its parent's
 * cancel cascade, which writes intent for the whole subtree and relies on each
 * child terminalising itself.
 *
 * The two parked states differ only in which ledger has to be closed first
 * (`parked-interaction-cancel.js` vs `parked-approval-cancel.js`). Everything
 * around that — re-read under lock, tolerate a Run that already advanced, map
 * the outcome to a recovery action — is identical, and keeping one copy is
 * what stops the two from drifting apart the way they had.
 */

import { isTerminalRunStatus } from '../domain/run/index.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';

/**
 * @param {{
 *   tx: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
 *   createRepositories: (db: any) => any,
 *   run: object,
 *   base: object,
 *   parkedStatus: string,
 *   terminalize: (repos: object, current: object, scope: object) => Promise<{ status: string }>,
 * }} input
 * @returns {Promise<object>} recovery action
 */
export async function recoverParkedCancel(input) {
  const { tx, createRepositories, run, base, parkedStatus, terminalize } = input;
  const scope = { orgId: run.orgId, userId: run.userId };
  try {
    const result = await tx.run(async (trx) => {
      const repos = createRepositories(trx);
      const current = await repos.runs.getById(run.runId, scope, {
        forUpdate: true,
      });
      if (!current) return { ok: false, reason: 'missing' };
      // Another worker (or the API transaction) may have finished it first.
      if (isTerminalRunStatus(current.status)) {
        return { ok: true, status: current.status, already: true };
      }
      if (current.status !== parkedStatus) {
        return { ok: false, reason: `status advanced to ${current.status}` };
      }
      const parked = await terminalize(repos, current, scope);
      return { ok: true, status: parked.status };
    });

    if (result.ok) {
      return {
        ...base,
        status: result.status,
        action: 'terminalized',
        reason: result.already
          ? 'already terminal'
          : `${parkedStatus} parked cancel (cancel intent)`,
      };
    }
    return {
      ...base,
      action: 'error',
      reason: result.reason ?? 'parked cancel failed',
    };
  } catch (err) {
    return {
      ...base,
      action: 'error',
      reason: sanitizeStatusReason(err),
    };
  }
}
