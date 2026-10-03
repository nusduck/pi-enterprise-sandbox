/** Durable owner-scoped approval decision and resume coordination. */

import { ExternalIdentityResolver, type ExternalAuth } from './parent/external-identity-resolver.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from './errors.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { assertUlid, isUlid } from '../domain/shared/ulid.js';
import { RUN_STATUS } from '../domain/run/index.js';
import {
  APPROVAL_STATUS,
  isTerminalApprovalStatus,
} from '../domain/tool/approval-status.js';
import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import {
  ConflictError,
  NotFoundError,
} from '../infrastructure/mysql/errors.js';
import { appendEventInTxn } from './run-event-append.js';
import type { TransactionManager } from '../infrastructure/mysql/transaction-manager.js';
import type { createRepositoryBundle } from '../bootstrap/container-env.js';
import type { RunQueueAdapter } from '../bootstrap/container-run-queue.js';

type Repos = ReturnType<typeof createRepositoryBundle>;
interface DecisionInput { approvalId?: unknown; runId?: unknown; run_id?: unknown; approval_id?: unknown; decision?: unknown; reason?: unknown; auth?: ExternalAuth; }

const DECISIONS = Object.freeze({
  approve: APPROVAL_STATUS.APPROVED,
  reject: APPROVAL_STATUS.REJECTED,
});

function normalizeDecision(value) {
  const decision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!Object.hasOwn(DECISIONS, decision)) {
    throw new ValidationError("decision must be 'approve' or 'reject'");
  }
  return decision;
}

function normalizeReason(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError('reason must be a string');
  }
  const reason = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!reason) return null;
  if (reason.length > 2_000) {
    throw new ValidationError('reason exceeds max length 2000');
  }
  return reason;
}

function assertOptionalUlid(value, field) {
  if (value == null || value === '') return null;
  if (!isUlid(value)) throw new ValidationError(`${field} must be a ULID`);
  return assertUlid(value, field);
}

function publicApprovalStatus(status) {
  return String(status || '').toLowerCase();
}

export class ApprovalDecisionService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  tx: TransactionManager;
  createRepositories: typeof createRepositoryBundle;
  runQueue: RunQueueAdapter;
  generateId: () => string;
  now: () => Date;

  /** @param {{ transactionManager: TransactionManager, createRepositories: typeof createRepositoryBundle, runQueue: RunQueueAdapter, generateId: () => string, now?: () => Date, }} deps */
  constructor(deps: { transactionManager: TransactionManager, createRepositories: typeof createRepositoryBundle, runQueue: RunQueueAdapter, generateId: () => string, now?: () => Date, }) {
    if (!deps?.transactionManager?.run) {
      throw new Error('ApprovalDecisionService requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('ApprovalDecisionService requires createRepositories');
    }
    if (typeof deps.runQueue?.enqueue !== 'function') {
      throw new Error('ApprovalDecisionService requires runQueue.enqueue');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('ApprovalDecisionService requires generateId');
    }
    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.runQueue = deps.runQueue;
    this.generateId = deps.generateId;
    this.now = deps.now ?? (() => new Date());
  }

  async #resolveOwner(auth: ExternalAuth, repos: Repos) {
    return new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    }).resolveOwner(auth);
  }

  async #getApproval(repos: Repos, approvalId: string, owner: { orgId: string, userId: string }, opts: { forUpdate?: boolean } = {}) {
    try {
      return await repos.approvals.getById(approvalId, owner, opts);
    } catch (err) {
      if (err instanceof NotFoundError) {
        throw new OwnerScopedNotFoundError('Approval not found', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      throw err;
    }
  }

  async #enqueue(run: { runId: string, orgId: string, traceId: string }, approvalId: string) {
    try {
      await this.runQueue.enqueue(
        {
          runId: run.runId,
          orgId: run.orgId,
          traceId: run.traceId,
        },
        {
          jobId: `${run.runId}-approval-${approvalId}`,
          attempts: 8,
          backoff: { type: 'exponential', delay: 250 },
        },
      );
      return {
        queued: true,
        resumePending: false,
        resumeError: null,
      };
    } catch (err) {
      return {
        queued: false,
        resumePending: true,
        resumeError:
          sanitizeStatusReason(err) || 'Run resume enqueue failed',
      };
    }
  }

  /** Resolve a PENDING approval exactly once, then best-effort enqueue its Run. */
  async resolve(input: DecisionInput) {
    const approvalId = assertOptionalUlid(input?.approvalId, 'approvalId');
    if (!approvalId) throw new ValidationError('approvalId is required');
    const runIdHint = assertOptionalUlid(
      input?.runId ?? input?.run_id,
      'runId',
    );
    const decision = normalizeDecision(input?.decision);
    const reason = normalizeReason(input?.reason);
    const toStatus = DECISIONS[decision];

    const resolved = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(input?.auth, repos);
      // Resolve the parent id first, then lock parent -> approval -> tool in the
      // same order as requestApproval to avoid an approval/run deadlock.
      const observed = await this.#getApproval(repos, approvalId, owner);
      if (runIdHint && observed.runId !== runIdHint) {
        throw new ConflictError('approval does not belong to the supplied Run', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      const run = await repos.runs.getById(observed.runId, owner, {
        forUpdate: true,
      });
      if (!run) {
        throw new OwnerScopedNotFoundError('Approval not found', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      const approval = await this.#getApproval(
        repos,
        approvalId,
        owner,
        { forUpdate: true },
      );
      if (approval.runId !== observed.runId) {
        throw new ConflictError('approval parent changed while resolving', {
          resource: 'approvals',
          id: approvalId,
        });
      }
      const toolExecution = await repos.toolExecutions.getById(
        approval.toolExecutionId,
        owner,
        { forUpdate: true },
      );
      if (
        toolExecution.runId !== run.runId ||
        approval.runId !== run.runId
      ) {
        throw new ConflictError('approval parent binding is inconsistent', {
          resource: 'approvals',
          id: approvalId,
        });
      }

      if (approval.status === APPROVAL_STATUS.PENDING) {
        if (run.status !== RUN_STATUS.WAITING_APPROVAL) {
          throw new ConflictError(
            `pending approval requires Run WAITING_APPROVAL, was ${run.status}`,
            { resource: 'runs', id: run.runId },
          );
        }
        if (toolExecution.status !== TOOL_EXECUTION_STATUS.WAITING_APPROVAL) {
          throw new ConflictError(
            `pending approval requires ToolExecution WAITING_APPROVAL, was ${toolExecution.status}`,
            { resource: 'tool_executions', id: toolExecution.toolExecutionId },
          );
        }
      }

      const decided = await repos.approvals.decideIf({
        approvalId,
        orgId: owner.orgId,
        userId: owner.userId,
        fromStatus: APPROVAL_STATUS.PENDING,
        toStatus,
        decisionBy: owner.userId,
        decisionReason: reason,
      });

      if (decided.changed) {
        await appendEventInTxn({
          repos,
          run,
          eventType: 'approval.resolved',
          data: {
            approvalId,
            toolExecutionId: toolExecution.toolExecutionId,
            toolCallId: toolExecution.toolCallId,
            toolName: toolExecution.toolName,
            decision,
            status: toStatus,
            reason,
            decisionBy: owner.userId,
          },
          generateId: this.generateId,
          now: this.now,
        });

        // A rejection has no external side effect to replay, so terminalize the
        // parked tool in the same decision transaction. Approved tools remain
        // WAITING_APPROVAL until the worker claims the exact call for replay.
        if (toStatus === APPROVAL_STATUS.REJECTED) {
          await repos.toolExecutions.transitionStatus({
            toolExecutionId: toolExecution.toolExecutionId,
            orgId: owner.orgId,
            userId: owner.userId,
            fromStatus: TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
            toStatus: TOOL_EXECUTION_STATUS.FAILED,
            resultJson: { approvalId, decision, reason },
            errorCode: 'APPROVAL_REJECTED',
            setCompletedAt: true,
          });
          await appendEventInTxn({
            repos,
            run,
            eventType: 'tool.execution.failed',
            data: {
              approvalId,
              approvalRejected: true,
              toolExecutionId: toolExecution.toolExecutionId,
              toolCallId: toolExecution.toolCallId,
              toolName: toolExecution.toolName,
              isError: true,
              errorCode: 'APPROVAL_REJECTED',
            },
            generateId: this.generateId,
            now: this.now,
          });
        }
      }

      return {
        approval: decided.approval,
        changed: decided.changed,
        run,
      };
    });

    const wake =
      resolved.run.status === RUN_STATUS.WAITING_APPROVAL
        ? await this.#enqueue(
            resolved.run,
            resolved.approval.approvalId,
          )
        : { queued: false, resumePending: false, resumeError: null };
    return {
      ok: true,
      id: resolved.approval.approvalId,
      approval_id: resolved.approval.approvalId,
      run_id: resolved.approval.runId,
      tool_execution_id: resolved.approval.toolExecutionId,
      status: publicApprovalStatus(resolved.approval.status),
      decision,
      changed: resolved.changed,
      queued: wake.queued,
      resumePending: wake.resumePending,
      resume_pending: wake.resumePending,
      resumeError: wake.resumeError,
      resume_error: wake.resumeError,
    };
  }

  /** Retry waking a resolved approval Run without changing MySQL decision facts. */
  async resume(input: DecisionInput) {
    const runId = assertOptionalUlid(input?.runId, 'runId');
    if (!runId) throw new ValidationError('runId is required');
    const approvalId = assertOptionalUlid(
      input?.approvalId ?? input?.approval_id,
      'approvalId',
    );

    const target = await this.tx.run(async (trx) => {
      const repos = this.createRepositories(trx);
      const owner = await this.#resolveOwner(input?.auth, repos);
      const run = await repos.runs.getById(runId, owner, { forUpdate: true });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }
      if (run.status !== RUN_STATUS.WAITING_APPROVAL) {
        throw new ConflictError(
          `Run is ${run.status}, expected WAITING_APPROVAL`,
          { resource: 'runs', id: runId },
        );
      }

      const approvals = await repos.approvals.listByRunId(runId, owner, {
        forUpdate: true,
      });
      const selected = approvalId
        ? approvals.find((approval) => approval.approvalId === approvalId)
        : [...approvals].reverse().find((approval) =>
            isTerminalApprovalStatus(approval.status),
          );
      if (!selected) {
        if (approvalId) {
          throw new OwnerScopedNotFoundError('Approval not found', {
            resource: 'approvals',
            id: approvalId,
          });
        }
        throw new ConflictError('Run has no resolved approval to resume', {
          resource: 'runs',
          id: runId,
        });
      }
      if (!isTerminalApprovalStatus(selected.status)) {
        throw new ConflictError('Approval is still pending', {
          resource: 'approvals',
          id: selected.approvalId,
        });
      }
      if (approvals.some((approval) => approval.status === APPROVAL_STATUS.PENDING)) {
        throw new ConflictError('Run still has a pending approval', {
          resource: 'runs',
          id: runId,
        });
      }
      const toolExecution = await repos.toolExecutions.getById(
        selected.toolExecutionId,
        owner,
        { forUpdate: true },
      );
      const resumable =
        (selected.status === APPROVAL_STATUS.APPROVED &&
          toolExecution.status === TOOL_EXECUTION_STATUS.WAITING_APPROVAL) ||
        (selected.status === APPROVAL_STATUS.REJECTED &&
          toolExecution.status === TOOL_EXECUTION_STATUS.FAILED);
      if (!resumable) {
        throw new ConflictError(
          `approval/tool state is not resumable (${selected.status}/${toolExecution.status})`,
          { resource: 'approvals', id: selected.approvalId },
        );
      }
      return { run, approval: selected };
    });

    const wake = await this.#enqueue(
      target.run,
      target.approval.approvalId,
    );
    return {
      ok: !wake.resumePending,
      run_id: target.run.runId,
      approval_id: target.approval.approvalId,
      status: 'waiting_approval',
      queued: wake.queued,
      resumePending: wake.resumePending,
      resume_pending: wake.resumePending,
      resumeError: wake.resumeError,
      resume_error: wake.resumeError,
    };
  }
}
