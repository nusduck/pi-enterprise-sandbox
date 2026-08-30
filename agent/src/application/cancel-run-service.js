/**
 * CancelRunService (PR-04 T2) — durable cancel intent + optional signal.
 *
 * Under one MySQL transaction:
 * 1. Resolve trusted external auth → owner.
 * 2. Load run owner-scoped.
 * 3. Terminal: idempotent return of existing intent; NO new intent write,
 *    NO Redis cancel signal.
 * 4. Non-terminal: persist cancel intent (first-writer wins). If sole
 *    RunStateMachine permits current → CANCELLING, CAS + durable status
 *    event + Outbox. A parked WAITING_INPUT / WAITING_APPROVAL Run has no
 *    Worker to finish the cancellation, so the same transaction first closes
 *    its interaction/approval/tool ledger and then commits
 *    CANCELLING→CANCELLED. Otherwise intent alone. Never invent edges.
 * 5. COMMIT, then set Redis CancelSignal (non-terminal only).
 *
 * Redis failure must not erase MySQL intent; response indicates signal pending.
 * Parked WAITING_INPUT / WAITING_APPROVAL Runs are terminalized by the API
 * transaction; active/queued Runs are still terminalized by the Worker.
 *
 * If that transaction loses a deadlock or lock wait against the Worker, the
 * rollback takes the intent with it. A second, minimal transaction then writes
 * the intent alone so a cancel is never silently dropped; the caller still
 * sees the dependency error. See #commitCancel.
 */

import { RUN_STATUS, runStateMachine } from '../domain/run/index.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { applyRunTransitionInTxn } from './run-transition.js';
import { terminalizeParkedWaitingApprovalInTxn } from './parked-approval-cancel.js';
import { terminalizeParkedWaitingInputInTxn } from './parked-interaction-cancel.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';

/**
 * @typedef {{
 *   runId: string,
 *   status: string,
 *   cancelRequested: boolean,
 *   cancelRequestedAt: string | null,
 *   transitionedToCancelling: boolean,
 *   signalPending: boolean,
 *   terminal: boolean,
 *   cancelledDescendants: string[],
 * }} CancelRunResponse
 *
 * `cancelledDescendants` is the sub-agent subtree this cancel also stopped.
 * Each child additionally emits its own `run.status.changed` / `run.cancelled`
 * events; the list is what lets a caller correlate them without first digging
 * the child ids out of the parent's tool results.
 */

export class CancelRunService {
  /**
   * `createRepositories` 里的 interactions / toolExecutions 本服务不直接读：
   * 取消一个 parked WAITING_INPUT 时整个 bundle 会透传给
   * `terminalizeParkedWaitingInputInTxn`，收尾那两张表的是它。端口声明要写
   * 拿到的东西，不是自己用到的那部分。
   *
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => {
   *     organizations: any,
   *     externalRefs: any,
   *     runs: any,
   *     runEvents: any,
   *     outbox: any,
   *     interactions: any,
   *     toolExecutions: any,
   *   },
   *   cancelSignal: { request: (runId: string, meta?: { reason?: string, requestedBy?: string }) => Promise<void> },
   *   generateId: () => string,
   *   now?: () => Date,
   *   runStateMachine?: import('../domain/run/run-state-machine.js').RunStateMachine,
   *   defaultProvider?: string,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('CancelRunService requires transactionManager.run');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('CancelRunService requires createRepositories(db)');
    }
    if (!deps.cancelSignal || typeof deps.cancelSignal.request !== 'function') {
      throw new Error('CancelRunService requires cancelSignal.request()');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('CancelRunService requires generateId()');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.cancelSignal = deps.cancelSignal;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
    this.stateMachine = deps.runStateMachine ?? runStateMachine;
    this.defaultProvider = deps.defaultProvider;
  }

  /**
   * Commit the cancel decision, and never lose the user's intent to a
   * transient MySQL failure.
   *
   * The full transaction touches the Run row, its event ledger and the Outbox
   * while the Worker is writing to the same rows, so it can lose a deadlock or
   * a lock wait. That rolls everything back — including the durable intent the
   * Worker reads to stop the Run — leaving a user who pressed Cancel with an
   * error and a Run that keeps burning provider budget. So on a dependency
   * failure, write the intent alone (one short UPDATE, first-writer-wins) and
   * still surface the error: the caller learns the cancel did not complete,
   * while the Run is already condemned.
   *
   * @param {string} runId
   * @param {{ auth: object, reason?: string | null }} input
   */
  async #commitCancel(runId, input) {
    try {
      return await this.#cancelInTxn(runId, input);
    } catch (err) {
      if (err?.code !== 'MYSQL_DEPENDENCY_ERROR') throw err;
      try {
        await this.#recordIntentOnly(runId, input);
      } catch {
        // Best effort. The original dependency error is the one to report.
      }
      throw err;
    }
  }

  /**
   * Durable cancel intent with no status transition, in its own short
   * transaction. Idempotent by construction (first-writer-wins).
   *
   * @param {string} runId
   * @param {{ auth: object, reason?: string | null }} input
   */
  async #recordIntentOnly(runId, input) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const resolver = new ExternalIdentityResolver(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        },
        { defaultProvider: this.defaultProvider },
      );
      const owner = await resolver.resolveOwner(input.auth);
      const scope = { orgId: owner.orgId, userId: owner.userId };
      const run = await repos.runs.getById(runId, scope);
      if (!run || this.stateMachine.isTerminal(run.status)) return null;
      return repos.runs.setCancelIntent(runId, scope, {
        reason: input.reason ?? null,
        requestedBy: owner.userId,
        requestedAt: this.now(),
      });
    });
  }

  /**
   * @param {string} runId
   * @param {{ auth: object, reason?: string | null }} input
   */
  async #cancelInTxn(runId, input) {
    return this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const resolver = new ExternalIdentityResolver(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        },
        { defaultProvider: this.defaultProvider },
      );

      let owner;
      try {
        owner = await resolver.resolveOwner(input.auth);
      } catch (err) {
        if (err instanceof OwnerScopedNotFoundError) {
          throw new OwnerScopedNotFoundError('Run not found', {
            resource: 'runs',
            id: runId,
          });
        }
        throw err;
      }

      const scope = { orgId: owner.orgId, userId: owner.userId };
      const run = await repos.runs.getById(runId, scope, { forUpdate: true });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }

      // Terminal parent: idempotent for the parent itself — no new intent, no
      // signal. Its children are NOT skipped: a parent that already failed or
      // was cancelled can still have live children burning sandbox and
      // provider budget, and this call is the user asking for them to stop.
      if (this.stateMachine.isTerminal(run.status)) {
        const orphans = await repos.runs.listDescendants(runId, scope, {
          onlyNonTerminal: true,
        });
        /** @type {string[]} */
        const cancelledOrphans = [];
        for (const child of orphans) {
          await repos.runs.setCancelIntent(child.runId, scope, {
            reason: input.reason ?? `parent run ${runId} is ${run.status}`,
            requestedBy: owner.userId,
            requestedAt: this.now(),
          });
          cancelledOrphans.push(child.runId);
        }
        return {
          runId,
          status: run.status,
          cancelRequested: run.cancelRequestedAt != null,
          cancelRequestedAt: run.cancelRequestedAt,
          transitionedToCancelling: false,
          terminal: true,
          skipSignal: true,
          requestedBy: run.cancelRequestedBy,
          reason: run.cancelReason,
          cancelledDescendants: cancelledOrphans,
        };
      }

      // Non-terminal: durable MySQL cancel intent (first-writer wins).
      const withIntent = await repos.runs.setCancelIntent(runId, scope, {
        reason: input.reason ?? null,
        requestedBy: owner.userId,
        requestedAt: this.now(),
      });

      let transitionedToCancelling = false;
      let status = withIntent.status;

      if (withIntent.status === RUN_STATUS.WAITING_INPUT) {
        const parked = await terminalizeParkedWaitingInputInTxn({
          repos,
          run: withIntent,
          scope,
          cancelledBy: owner.userId,
          generateId: this.generateId,
          now: this.now,
          stateMachine: this.stateMachine,
        });
        status = parked.status;
        transitionedToCancelling = true;
      }

      if (withIntent.status === RUN_STATUS.WAITING_APPROVAL) {
        const parked = await terminalizeParkedWaitingApprovalInTxn({
          repos,
          run: withIntent,
          scope,
          decidedBy: owner.userId,
          generateId: this.generateId,
          now: this.now,
          stateMachine: this.stateMachine,
        });
        status = parked.status;
        transitionedToCancelling = true;
      }

      if (
        withIntent.status !== RUN_STATUS.WAITING_INPUT &&
        withIntent.status !== RUN_STATUS.WAITING_APPROVAL &&
        this.stateMachine.canTransition(withIntent.status, RUN_STATUS.CANCELLING)
      ) {
        this.stateMachine.assertTransition(
          withIntent.status,
          RUN_STATUS.CANCELLING,
        );
        const toCancelling = await applyRunTransitionInTxn({
          repos,
          runId,
          scope,
          from: withIntent.status,
          to: RUN_STATUS.CANCELLING,
          traceId: withIntent.traceId,
          generateId: this.generateId,
          eventType: 'run.status.changed',
          statusReason: withIntent.cancelReason,
          payloadExtra: { cancelRequested: true },
        });
        if (toCancelling.ok) {
          status = toCancelling.run.status;
          transitionedToCancelling = true;

        } else {
          const reloaded = toCancelling.current ??
            (await repos.runs.requireById(runId, scope));
          status = reloaded.status;
          transitionedToCancelling = [
            RUN_STATUS.CANCELLING,
            RUN_STATUS.CANCELLED,
          ].includes(status);
        }
      }

      // Cascade to sub-agent children (PR #16 lineage). Only the durable
      // intent is written here: a child stops itself through the ordinary
      // path — execute-run-service checks cancel intent before entering the
      // runtime and again around each step, reading MySQL first and Redis as
      // acceleration. Re-implementing the parked WAITING_INPUT/APPROVAL
      // terminalisation per child would duplicate the riskiest code in this
      // file for no behavioural gain.
      const descendants = await repos.runs.listDescendants(runId, scope, {
        onlyNonTerminal: true,
      });
      /** @type {string[]} */
      const cancelledDescendants = [];
      for (const child of descendants) {
        // First-writer-wins and idempotent: a child the user already cancelled
        // keeps its original reason and requester.
        await repos.runs.setCancelIntent(child.runId, scope, {
          reason: input.reason ?? `parent run ${runId} cancelled`,
          requestedBy: owner.userId,
          requestedAt: this.now(),
        });
        cancelledDescendants.push(child.runId);
      }

      return {
        runId,
        status,
        cancelRequested: true,
        cancelRequestedAt: withIntent.cancelRequestedAt,
        transitionedToCancelling,
        terminal: status === RUN_STATUS.CANCELLED,
        skipSignal: status === RUN_STATUS.CANCELLED,
        requestedBy: owner.userId,
        reason: withIntent.cancelReason,
        cancelledDescendants,
      };    });
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: {
   *     provider?: string,
   *     externalOrgId: string,
   *     externalUserId: string,
   *   },
   *   reason?: string | null,
   * }} input
   * @returns {Promise<CancelRunResponse>}
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('CancelRun input is required');
    }
    if (typeof input.runId !== 'string' || !input.runId.trim()) {
      throw new ValidationError('runId is required');
    }
    if (isLegacyOrUuidIdentity(input.runId)) {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    let runId;
    try {
      runId = assertUlid(input.runId, 'runId');
    } catch {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }

    const committed = await this.#commitCancel(runId, input);

    let signalPending = false;
    if (!committed.skipSignal) {
      try {
        await this.cancelSignal.request(runId, {
          reason: committed.reason ?? undefined,
          requestedBy: committed.requestedBy ?? undefined,
        });
      } catch {
        signalPending = true;
      }
    }

    // Redis is acceleration for children exactly as it is for the parent: the
    // intent is already committed, so a failed signal only means a running
    // child notices at its next MySQL check instead of immediately.
    const cancelledDescendants = committed.cancelledDescendants ?? [];
    for (const childRunId of cancelledDescendants) {
      try {
        await this.cancelSignal.request(childRunId, {
          reason: committed.reason ?? undefined,
          requestedBy: committed.requestedBy ?? undefined,
        });
      } catch {
        signalPending = true;
      }
    }

    return {
      runId: committed.runId,
      status: committed.status,
      cancelRequested: committed.cancelRequested,
      cancelRequestedAt: committed.cancelRequestedAt,
      transitionedToCancelling: committed.transitionedToCancelling,
      signalPending,
      terminal: committed.terminal,
      cancelledDescendants,
    };
  }
}
