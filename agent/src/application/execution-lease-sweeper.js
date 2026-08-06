/**
 * Close out tool executions whose owning Sandbox replica died.
 *
 * A Sandbox replica that shuts down cleanly reconciles its own in-flight
 * claims. One that is SIGKILLed, OOM-killed, evicted, or loses its node does
 * not — and the `tool_executions` row stays RUNNING with nobody left who can
 * say what happened to it. Before sharding that was a rare single-node crash;
 * with N replicas it is an ordinary Tuesday.
 *
 * The lease makes the answer provable. Each claim records `owner_node_id` and
 * `lease_expires_at`; once the expiry passes with the row still RUNNING, the
 * owner is gone and the execution is closed as **UNKNOWN** — never FAILED.
 * That distinction is the whole point: we genuinely do not know whether the
 * command ran, and reporting a definite failure for something that may have
 * succeeded would be a lie the run then acts on.
 *
 * Safe to run on every worker replica: rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so concurrent sweepers divide the work instead of
 * duplicating or blocking on it.
 */

import {
  TOOL_EXECUTION_STATUS,
} from '../domain/tool/tool-execution-status.js';

/** Rows examined per pass. Bounded so one sweep cannot hold a long transaction. */
export const DEFAULT_SWEEP_BATCH_SIZE = 100;

/** Terminal error code recorded on reaped rows, for operators grepping later. */
export const LEASE_EXPIRED_ERROR_CODE = 'SANDBOX_OWNER_LEASE_EXPIRED';

function toMysqlDateTime(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * @param {object} deps
 * @param {import('knex').Knex} deps.db
 * @param {() => Date} [deps.now]
 * @param {number} [deps.batchSize]
 * @param {{ warn?: Function, info?: Function }} [deps.logger]
 */
export function createExecutionLeaseSweeper({
  db,
  now = () => new Date(),
  batchSize = DEFAULT_SWEEP_BATCH_SIZE,
  logger = console,
}) {
  if (!db) throw new Error('createExecutionLeaseSweeper requires a knex executor');

  /**
   * One pass. Returns the number of executions closed out.
   *
   * Never throws for ordinary database trouble: a sweeper that dies on a
   * transient error stops reaping altogether, which is worse than a pass that
   * accomplishes nothing and tries again next tick.
   */
  async function sweepOnce() {
    const cutoff = toMysqlDateTime(now());
    let reaped = 0;

    try {
      await db.transaction(async (trx) => {
        const expired = await trx('tool_executions')
          .where('status', TOOL_EXECUTION_STATUS.RUNNING)
          .whereNotNull('lease_expires_at')
          .where('lease_expires_at', '<', cutoff)
          .orderBy('lease_expires_at', 'asc')
          .limit(batchSize)
          .forUpdate()
          .skipLocked()
          .select('tool_execution_id', 'owner_node_id', 'run_id');

        if (expired.length === 0) return;

        for (const row of expired) {
          // Re-assert RUNNING in the WHERE clause. Between the select and this
          // update the real owner may have come back and finalised the row;
          // overwriting a genuine SUCCEEDED with UNKNOWN would be strictly
          // worse than leaving a stale row for one more tick.
          const changed = await trx('tool_executions')
            .where('tool_execution_id', row.tool_execution_id)
            .andWhere('status', TOOL_EXECUTION_STATUS.RUNNING)
            .update({
              status: TOOL_EXECUTION_STATUS.UNKNOWN,
              error_code: LEASE_EXPIRED_ERROR_CODE,
              completed_at: cutoff,
              owner_node_id: null,
              lease_expires_at: null,
            });
          if (changed === 1) reaped += 1;
        }

        logger.warn?.(
          `[lease-sweeper] closed ${reaped} execution(s) as UNKNOWN after their ` +
            `Sandbox replica stopped renewing (nodes: ${[
              ...new Set(expired.map((r) => r.owner_node_id).filter(Boolean)),
            ].join(', ') || 'unknown'})`,
        );
      });
    } catch (err) {
      logger.warn?.(
        `[lease-sweeper] sweep failed: ${err instanceof Error ? err.message : 'error'}`,
      );
      return 0;
    }

    return reaped;
  }

  return { sweepOnce };
}
