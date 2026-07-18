/**
 * Agent Session repository (plan §8.8 + PR-05 fencing/CAS).
 *
 * Ownership-scoped. Status transitions validated through SessionStateMachine.
 * Redis lock absence is never interpreted here as a Session status.
 */

import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { mapAgentSession, toMysqlDateTime } from '../row-mappers.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { assertUlid } from '../../../domain/shared/ulid.js';
import {
  isSessionStatus,
  SESSION_STATUS,
} from '../../../domain/session/session-status.js';
import { InvalidSessionStatusError } from '../../../domain/session/errors.js';
import {
  isRecoveryReasonCode,
  RECOVERY_REASON_CODE,
} from '../../../domain/session/recovery-reason.js';
import {
  SessionFenceConflictError,
} from '../../../domain/session/errors.js';
import { sessionStateMachine } from '../../../domain/session/session-state-machine.js';
import { RUN_STATUS } from '../../../domain/run/run-status.js';

/**
 * @param {unknown} status
 * @param {string} [field]
 * @returns {string}
 */
export function assertSessionStatus(status, field = 'status') {
  if (!isSessionStatus(status)) {
    throw new InvalidSessionStatusError(
      status,
      `Invalid ${field}: expected plan §11 Session status`,
    );
  }
  return /** @type {string} */ (status);
}

/**
 * @param {string | string[]} expected
 * @returns {string[]}
 */
export function normalizeExpectedSessionStatuses(expected) {
  const list = Array.isArray(expected) ? expected : [expected];
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string' || !s.trim()) {
      throw new Error('expectedStatus(es) must be non-empty strings');
    }
    out.push(assertSessionStatus(s.trim(), 'expectedStatus'));
  }
  if (!out.length) {
    throw new Error('expectedStatus(es) must be non-empty strings');
  }
  return out;
}

/**
 * @param {{ orgId: string, userId: string }} scope
 */
function requireOwnerUlids(scope) {
  const s = requireOwnerScope(scope);
  return {
    orgId: assertUlid(s.orgId, 'orgId'),
    userId: assertUlid(s.userId, 'userId'),
  };
}

/**
 * @param {unknown} token
 * @param {string} [field]
 * @returns {number}
 */
export function assertFenceToken(token, field = 'executionFenceToken') {
  const n = Number(token);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return n;
}

export class AgentSessionRepository {
  /**
   * @param {import('knex').Knex | import('knex').Knex.Transaction} db
   * @param {{ now?: () => Date }} [opts]
   */
  constructor(db, opts = {}) {
    if (!db) throw new Error('AgentSessionRepository requires a knex executor');
    this.db = db;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * @param {{
   *   agentSessionId: string,
   *   orgId: string,
   *   userId: string,
   *   conversationId: string,
   *   agentVersionId: string,
   *   sandboxSessionId: string,
   *   workspaceId: string,
   *   status: string,
   *   piSessionVersion?: number,
   *   lastRunId?: string | null,
   *   executionFenceToken?: number,
   *   recoveryReasonCode?: string | null,
   *   createdAt?: Date | string,
   *   updatedAt?: Date | string,
   *   closedAt?: Date | string | null,
   * }} input
   */
  async create(input) {
    const scope = requireOwnerUlids(input);
    const agentSessionId = assertUlid(input.agentSessionId, 'agentSessionId');
    const status = assertSessionStatus(input.status);
    const now = toMysqlDateTime(input.createdAt || this.now());
    const fence = assertFenceToken(input.executionFenceToken ?? 0);
    let recovery = null;
    if (input.recoveryReasonCode != null && input.recoveryReasonCode !== '') {
      if (!isRecoveryReasonCode(input.recoveryReasonCode)) {
        throw new Error(
          `Invalid recoveryReasonCode: ${String(input.recoveryReasonCode)}`,
        );
      }
      recovery = String(input.recoveryReasonCode);
    }

    await this.db('agent_sessions').insert({
      agent_session_id: agentSessionId,
      org_id: scope.orgId,
      user_id: scope.userId,
      conversation_id: assertUlid(input.conversationId, 'conversationId'),
      agent_version_id: assertUlid(input.agentVersionId, 'agentVersionId'),
      sandbox_session_id: assertUlid(input.sandboxSessionId, 'sandboxSessionId'),
      workspace_id: assertUlid(input.workspaceId, 'workspaceId'),
      status,
      pi_session_version: input.piSessionVersion ?? 0,
      last_run_id: input.lastRunId
        ? assertUlid(input.lastRunId, 'lastRunId')
        : null,
      execution_fence_token: fence,
      recovery_reason_code: recovery,
      created_at: now,
      updated_at: toMysqlDateTime(input.updatedAt || input.createdAt || this.now()),
      closed_at: input.closedAt ? toMysqlDateTime(input.closedAt) : null,
    });
    return this.getById(agentSessionId, scope);
  }

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async getById(agentSessionId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    let q = applyOwnerScope(
      this.db('agent_sessions').where({ agent_session_id: id }),
      s,
    );
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapAgentSession(row) : null;
  }

  /**
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async requireById(agentSessionId, scope, opts = {}) {
    const row = await this.getById(agentSessionId, scope, opts);
    if (!row) {
      throw new NotFoundError('Agent session not found', {
        resource: 'agent_sessions',
        id: agentSessionId,
      });
    }
    return row;
  }

  /**
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ status?: string }} [opts]
   */
  async listByConversation(conversationId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const cid = assertUlid(conversationId, 'conversationId');
    let q = applyOwnerScope(
      this.db('agent_sessions').where({ conversation_id: cid }),
      s,
    ).orderBy('created_at', 'desc');
    if (opts.status) q = q.andWhere({ status: assertSessionStatus(opts.status) });
    const rows = await q;
    return rows.map(mapAgentSession);
  }

  /**
   * @param {string} conversationId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ forUpdate?: boolean }} [opts]
   */
  async findActiveForConversation(conversationId, scope, opts = {}) {
    const s = requireOwnerUlids(scope);
    const cid = assertUlid(conversationId, 'conversationId');
    let q = applyOwnerScope(
      this.db('agent_sessions').where({ conversation_id: cid }),
      s,
    )
      .whereIn('status', [SESSION_STATUS.CREATING, SESSION_STATUS.ACTIVE])
      .orderBy('created_at', 'desc');
    if (opts.forUpdate) q = q.forUpdate();
    const row = await q.first();
    return row ? mapAgentSession(row) : null;
  }

  /**
   * @deprecated Unsafe general update removed (PR-05 security).
   * Use {@link transitionIf}, {@link markRecoveryRequiredIfFence},
   * {@link updateLastRunIdIfFence}, or snapshot {@link AgentSessionSnapshotRepository.appendAndAdvance}.
   */
  async update() {
    throw new Error(
      'AgentSessionRepository.update is disabled: cannot arbitrarily write status/pi_session_version/recovery. Use transitionIf, markRecoveryRequiredIfFence, updateLastRunIdIfFence, or appendAndAdvance',
    );
  }

  /**
   * Set last_run_id under ACTIVE + expected fence (checkpoint companion write).
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   expectedFenceToken: number,
   *   lastRunId: string,
   * }} opts
   */
  async updateLastRunIdIfFence(agentSessionId, scope, opts) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    const expected = assertFenceToken(
      opts.expectedFenceToken,
      'expectedFenceToken',
    );
    const lastRunId = assertUlid(opts.lastRunId, 'lastRunId');

    const n = await applyOwnerScope(
      this.db('agent_sessions').where({
        agent_session_id: id,
        status: SESSION_STATUS.ACTIVE,
        execution_fence_token: expected,
      }),
      s,
    ).update({
      last_run_id: lastRunId,
      updated_at: toMysqlDateTime(this.now()),
    });

    if (!n) {
      const current = await this.getById(id, s);
      if (!current) {
        throw new NotFoundError('Agent session not found', {
          resource: 'agent_sessions',
          id: agentSessionId,
        });
      }
      throw new SessionFenceConflictError(
        `updateLastRunIdIfFence CAS failed for session ${id}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: current.executionFenceToken,
        },
      );
    }
    return this.requireById(id, s);
  }

  /**
   * Compare-and-set status transition under owner scope.
   * Every expected→target edge is validated via SessionStateMachine
   * (same-status SUSPENDED re-reason is the only non-transition edge).
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   expectedStatus?: string,
   *   expectedStatuses?: string[],
   *   status: string,
   *   recoveryReasonCode?: string | null,
   *   lastRunId?: string | null,
   *   closedAt?: Date | string | null,
   * }} patch
   */
  async transitionIf(agentSessionId, scope, patch) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    if (typeof patch.status !== 'string' || !patch.status.trim()) {
      throw new Error('transitionIf requires a non-empty target status');
    }
    const target = assertSessionStatus(patch.status);
    const expected = normalizeExpectedSessionStatuses(
      patch.expectedStatuses ?? patch.expectedStatus ?? [],
    );

    // Validate every expected → target edge through the sole state machine.
    for (const from of expected) {
      sessionStateMachine.assertLegalEdge(from, target);
    }

    /** @type {Record<string, unknown>} */
    const update = {
      status: target,
      updated_at: toMysqlDateTime(this.now()),
    };
    if (patch.recoveryReasonCode !== undefined) {
      if (patch.recoveryReasonCode == null || patch.recoveryReasonCode === '') {
        update.recovery_reason_code = null;
      } else {
        if (!isRecoveryReasonCode(patch.recoveryReasonCode)) {
          throw new Error(
            `Invalid recoveryReasonCode: ${String(patch.recoveryReasonCode)}`,
          );
        }
        update.recovery_reason_code = String(patch.recoveryReasonCode);
      }
    } else if (target === SESSION_STATUS.ACTIVE) {
      update.recovery_reason_code = null;
    }
    if (patch.lastRunId !== undefined) {
      update.last_run_id = patch.lastRunId
        ? assertUlid(patch.lastRunId, 'lastRunId')
        : null;
    }
    if (patch.closedAt !== undefined) {
      update.closed_at = patch.closedAt ? toMysqlDateTime(patch.closedAt) : null;
    } else if (target === SESSION_STATUS.CLOSED) {
      update.closed_at = toMysqlDateTime(this.now());
    }

    const n = await applyOwnerScope(
      this.db('agent_sessions').where({ agent_session_id: id }).whereIn('status', expected),
      s,
    ).update(update);

    if (n) {
      return this.requireById(id, s);
    }

    const current = await this.getById(id, s);
    if (!current) {
      throw new NotFoundError('Agent session not found', {
        resource: 'agent_sessions',
        id: agentSessionId,
      });
    }
    throw new ConflictError(
      `Agent session status CAS failed: expected one of [${expected.join(',')}], got ${current.status}`,
      { resource: 'agent_sessions', id: agentSessionId },
    );
  }

  /**
   * Mark SUSPENDED with recovery_reason_code under fence CAS.
   * Requires expectedExecutionFenceToken (no unfenced recovery mark).
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   expectedExecutionFenceToken?: number,
   *   expectedFenceToken?: number,
   *   recoveryReasonCode?: string,
   * }} opts
   */
  async markRecoveryRequired(agentSessionId, scope, opts = {}) {
    const fence =
      opts.expectedExecutionFenceToken ?? opts.expectedFenceToken;
    if (fence == null) {
      throw new Error(
        'markRecoveryRequired requires expectedExecutionFenceToken (fence CAS only)',
      );
    }
    return this.markRecoveryRequiredIfFence(agentSessionId, scope, {
      expectedFenceToken: fence,
      recoveryReasonCode: opts.recoveryReasonCode,
    });
  }

  /**
   * Monotonic fence acquire: CAS current token → current+1 under owner scope.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{ expectedToken: number, requireActive?: boolean }} opts
   * @returns {Promise<{ session: object, fenceToken: number }>}
   */
  async advanceExecutionFence(agentSessionId, scope, opts) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    const expected = assertFenceToken(opts.expectedToken, 'expectedToken');
    const next = expected + 1;

    /** @type {Record<string, unknown>} */
    const where = {
      agent_session_id: id,
      execution_fence_token: expected,
    };
    if (opts.requireActive) {
      where.status = SESSION_STATUS.ACTIVE;
    }

    const n = await applyOwnerScope(
      this.db('agent_sessions').where(where),
      s,
    ).update({
      execution_fence_token: next,
      updated_at: toMysqlDateTime(this.now()),
    });

    if (!n) {
      const current = await this.getById(id, s);
      if (!current) {
        throw new NotFoundError('Agent session not found', {
          resource: 'agent_sessions',
          id: agentSessionId,
        });
      }
      if (opts.requireActive && current.status !== SESSION_STATUS.ACTIVE) {
        throw new SessionFenceConflictError(
          `Execution fence acquire requires ACTIVE session, got ${current.status}`,
          {
            agentSessionId: id,
            expectedToken: expected,
            actualToken: current.executionFenceToken,
          },
        );
      }
      throw new SessionFenceConflictError(
        `Execution fence CAS failed for session ${id}: expected ${expected}, got ${current.executionFenceToken}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: current.executionFenceToken,
        },
      );
    }

    const session = await this.requireById(id, s);
    return { session, fenceToken: next };
  }

  /**
   * Acquire next fence only for an owner-scoped ACTIVE session.
   * Prefer {@link acquireExecutionFenceForRun} when Run binding must be verified.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @returns {Promise<{ session: object, fenceToken: number }>}
   */
  async acquireNextExecutionFence(agentSessionId, scope) {
    const current = await this.requireById(agentSessionId, scope, {
      forUpdate: true,
    });
    if (current.status !== SESSION_STATUS.ACTIVE) {
      throw new SessionFenceConflictError(
        `Execution fence acquire requires ACTIVE session, got ${current.status}`,
        {
          agentSessionId: current.agentSessionId,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    return this.advanceExecutionFence(agentSessionId, scope, {
      expectedToken: current.executionFenceToken,
      requireActive: true,
    });
  }

  /**
   * Acquire next fence for an ACTIVE session and verify owned Run binding.
   * Redis lock is coordination; this MySQL fence is the stale-writer gate.
   *
   * Lock order (caller trx): Session FOR UPDATE → Run FOR UPDATE → advance fence.
   * Missing / cross-owner / binding / non-RUNNING Run must not advance the fence.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   conversationId: string,
   *   agentVersionId: string,
   *   runId: string,
   * }} binding
   * @returns {Promise<{ session: object, fenceToken: number }>}
   */
  async acquireExecutionFenceForRun(agentSessionId, scope, binding) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    const conversationId = assertUlid(binding.conversationId, 'conversationId');
    const agentVersionId = assertUlid(binding.agentVersionId, 'agentVersionId');
    if (binding == null || binding.runId == null || binding.runId === '') {
      throw new Error('runId is required for acquireExecutionFenceForRun');
    }
    const runId = assertUlid(binding.runId, 'runId');

    // 1) Session row FOR UPDATE (owner-scoped).
    const current = await this.requireById(id, s, { forUpdate: true });
    if (current.status !== SESSION_STATUS.ACTIVE) {
      throw new SessionFenceConflictError(
        `Execution fence acquire requires ACTIVE session, got ${current.status}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    if (current.conversationId !== conversationId) {
      throw new SessionFenceConflictError(
        `Session/Run conversation binding mismatch for session ${id}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    if (current.agentVersionId !== agentVersionId) {
      throw new SessionFenceConflictError(
        `Session/Run agentVersion binding mismatch for session ${id}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }

    // 2) Owned Run row FOR UPDATE — validate before advancing fence.
    let runQ = applyOwnerScope(
      this.db('runs').where({ run_id: runId }),
      s,
    ).forUpdate();
    const runRow = await runQ.first();
    if (!runRow) {
      throw new NotFoundError('Run not found for execution fence acquire', {
        resource: 'runs',
        id: runId,
      });
    }
    if (String(runRow.agent_session_id) !== id) {
      throw new SessionFenceConflictError(
        `Run/Session agent_session_id binding mismatch for run ${runId}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    if (String(runRow.conversation_id) !== conversationId) {
      throw new SessionFenceConflictError(
        `Run conversation binding mismatch for run ${runId}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    if (String(runRow.agent_version_id) !== agentVersionId) {
      throw new SessionFenceConflictError(
        `Run agentVersion binding mismatch for run ${runId}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }
    if (String(runRow.status) !== RUN_STATUS.RUNNING) {
      throw new SessionFenceConflictError(
        `Execution fence acquire requires RUNNING run, got ${runRow.status}`,
        {
          agentSessionId: id,
          expectedToken: current.executionFenceToken,
          actualToken: current.executionFenceToken,
        },
      );
    }

    // 3) Advance fence only after Session + Run validation.
    return this.advanceExecutionFence(id, s, {
      expectedToken: current.executionFenceToken,
      requireActive: true,
    });
  }

  /**
   * Assert the current fence still equals expectedToken (stale-writer gate).
   * Usable inside every journal / event / checkpoint transaction.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {number} expectedToken
   * @param {{ forUpdate?: boolean, requireActive?: boolean }} [opts]
   * @returns {Promise<object>} session row
   */
  async assertExecutionFence(agentSessionId, scope, expectedToken, opts = {}) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    const expected = assertFenceToken(expectedToken, 'expectedToken');
    const session = await this.requireById(id, s, {
      forUpdate: opts.forUpdate === true,
    });
    if (opts.requireActive !== false && session.status !== SESSION_STATUS.ACTIVE) {
      throw new SessionFenceConflictError(
        `Execution fence assert requires ACTIVE session, got ${session.status}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: session.executionFenceToken,
        },
      );
    }
    if (session.executionFenceToken !== expected) {
      throw new SessionFenceConflictError(
        `Stale execution fence for session ${id}: expected ${expected}, got ${session.executionFenceToken}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: session.executionFenceToken,
        },
      );
    }
    return session;
  }

  /**
   * Mark SUSPENDED + recovery reason only when the caller still holds the fence.
   * Used when lock/fence is lost or recovery sources disagree — never via stale writer.
   *
   * @param {string} agentSessionId
   * @param {{ orgId: string, userId: string }} scope
   * @param {{
   *   expectedFenceToken: number,
   *   recoveryReasonCode?: string,
   * }} opts
   */
  async markRecoveryRequiredIfFence(agentSessionId, scope, opts) {
    const s = requireOwnerUlids(scope);
    const id = assertUlid(agentSessionId, 'agentSessionId');
    const expected = assertFenceToken(
      opts.expectedFenceToken,
      'expectedFenceToken',
    );
    const reason =
      opts.recoveryReasonCode ?? RECOVERY_REASON_CODE.RECOVERY_REQUIRED;
    if (!isRecoveryReasonCode(reason)) {
      throw new Error(`Invalid recoveryReasonCode: ${String(reason)}`);
    }

    const current = await this.requireById(id, s, { forUpdate: true });
    if (current.executionFenceToken !== expected) {
      throw new SessionFenceConflictError(
        `markRecoveryRequiredIfFence fence mismatch for session ${id}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: current.executionFenceToken,
        },
      );
    }
    sessionStateMachine.assertSuspendForRecovery(current.status, reason);

    // CAS status + fence together so a concurrent fence advance loses the write.
    /** @type {Record<string, unknown>} */
    const update = {
      status: SESSION_STATUS.SUSPENDED,
      recovery_reason_code: reason,
      updated_at: toMysqlDateTime(this.now()),
    };

    const n = await applyOwnerScope(
      this.db('agent_sessions').where({
        agent_session_id: id,
        execution_fence_token: expected,
      }),
      s,
    )
      .whereIn('status', [SESSION_STATUS.ACTIVE, SESSION_STATUS.SUSPENDED])
      .update(update);

    if (!n) {
      const again = await this.getById(id, s);
      throw new SessionFenceConflictError(
        `markRecoveryRequiredIfFence CAS failed for session ${id}`,
        {
          agentSessionId: id,
          expectedToken: expected,
          actualToken: again?.executionFenceToken ?? null,
        },
      );
    }
    return this.requireById(id, s);
  }

  /**
   * Removed public path (PR-05): pi_session_version advances only via
   * AgentSessionSnapshotRepository.appendAndAdvance (atomic insert+CAS).
   * Calling this throws to prevent bypass.
   */
  async advancePiSessionVersionIf() {
    throw new Error(
      'advancePiSessionVersionIf is disabled: use AgentSessionSnapshotRepository.appendAndAdvance only',
    );
  }
}
