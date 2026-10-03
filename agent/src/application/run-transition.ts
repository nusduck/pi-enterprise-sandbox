/**
 * Shared durable Run transition helper (CAS + RunEvent + Outbox in one txn work fn).
 * Used by ExecuteRunService and recovery projection paths.
 */

import {
  AGGREGATE_TYPE_RUN,
  AGGREGATE_TYPE_RUN_NOTIFICATION,
  EVENT_TYPE_RUN_TERMINAL_NOTIFICATION,
} from '../infrastructure/outbox/outbox-status.js';
import { RUN_STATUS, isTerminalRunStatus } from '../domain/run/run-status.js';
import { ConflictError } from '../infrastructure/mysql/errors.js';
import { assertUlid } from '../domain/shared/ulid.js';
import { sanitizeStatusReason } from './sanitize-status-reason.js';
import { ensureReviewTaskForTerminalRun } from './review-task-create.js';
import { closeOpenToolExecutionsInTxn } from './run-open-tools-close.js';

/**
 * 一次 Run 状态迁移需要用到的仓储。**只列真正会被读写的三个**，不是整个
 * 仓储包——调用方（parked-*-cancel 等）传的是同一个 bundle，但契约应当说明
 * 这里实际依赖什么。
 */
export interface RunTransitionRepos {
  runs: any;
  runEvents: any;
  outbox: any;
  /**
   * 审核账本（design `agent-output-review.md` §5.2）。可选：只注入三件套的测试
   * 替身与历史调用路径不该因为「这一次没带审核仓储」就直接炸掉——没有它就跳过
   * 建任务（`ensureReviewTaskForTerminalRun` 自己会判空）。
   */
  reviews?: any;
  /** 工具账本。可选：取消时给仍未结束的工具行收尾（run-open-tools-close.ts）。 */
  toolExecutions?: any;
}

/**
 * Apply a state-machine-validated transition inside an open transaction.
 * 返回类型由实现推断：`{ ok: true, run, event }`、`{ ok: false, reason: 'conflict', current }`、
 * `{ ok: false, reason: 'not_found', current: null }`。
 */
export async function applyRunTransitionInTxn(args: { repos: RunTransitionRepos, runId: string, scope: { orgId: string, userId: string }, from: string, to: string, traceId: string, generateId: () => string, eventType?: string, statusReason?: string | null, attempt?: number, startedAt?: Date | string | null, completedAt?: Date | string | null, payloadExtra?: Record<string, unknown>, }) {
  const {
    repos,
    runId,
    scope,
    from,
    to,
    traceId,
    generateId,
    eventType = 'run.status.changed',
    statusReason,
    attempt,
    startedAt,
    completedAt,
    payloadExtra = {},
  } = args;

  const patch: Record<string, unknown> = {
    expectedStatus: from,
    status: to,
  };
  if (statusReason !== undefined) {
    patch.statusReason = sanitizeStatusReason(statusReason);
  }
  if (attempt !== undefined) patch.attempt = attempt;
  if (startedAt !== undefined) patch.startedAt = startedAt;
  if (completedAt !== undefined) patch.completedAt = completedAt;

  let run;
  try {
    run = await repos.runs.updateStatusIf(runId, scope, patch);
  } catch (err) {
    if (err instanceof ConflictError) {
      const current = await repos.runs.getById(runId, scope);
      return { ok: false, reason: 'conflict', current };
    }
    throw err;
  }

  if (!run) {
    return { ok: false, reason: 'not_found', current: null };
  }

  const eventId = assertUlid(generateId(), 'eventId');
  const outboxId = assertUlid(generateId(), 'outboxId');
  const event = await repos.runEvents.append({
    eventId,
    runId,
    orgId: scope.orgId,
    userId: scope.userId,
    eventType,
    eventVersion: 1,
    payloadJson: {
      from,
      to,
      status: to,
      ...payloadExtra,
    },
    traceId,
  });

  await repos.outbox.insert({
    outboxId,
    aggregateType: AGGREGATE_TYPE_RUN,
    aggregateId: runId,
    eventType,
    payloadJson: {
      eventId: event.eventId,
      runId,
      sequence: event.sequenceNo,
      type: eventType,
      status: to,
      orgId: scope.orgId,
      userId: scope.userId,
    },
  });

  // 终态只会经这里写入（CAS 保证一个 Run 只进一次终态），所以通知请求挂在这里、
  // 与状态同事务：失败、取消、恢复扫描收尾都覆盖到，不依赖模型还有没有下一轮。
  // 发不发、发给谁由消费者按账本决定；这里只记「这个 Run 结束了」。
  if (isTerminalRunStatus(to)) {
    // 取消可能发生在没有活执行器的时候（Worker 被杀、恢复扫描收尾），那时没人会再结清
    // 工具账本；在终态同一事务里收尾。有执行器时它已先结清，这里是空操作。
    if (to === RUN_STATUS.CANCELLED && typeof repos.toolExecutions?.listByRun === 'function') {
      await closeOpenToolExecutionsInTxn({ repos, run, scope, generateId, now: () => new Date() });
    }
    await repos.outbox.insert({
      outboxId: assertUlid(generateId(), 'notificationOutboxId'),
      aggregateType: AGGREGATE_TYPE_RUN_NOTIFICATION,
      aggregateId: runId,
      eventType: EVENT_TYPE_RUN_TERMINAL_NOTIFICATION,
      payloadJson: {
        status: to,
        orgId: scope.orgId,
        userId: scope.userId,
      },
    });

    // 交付物人工审核（design §5.2）：本轮有 `held` 产物就同事务建一条审核任务。
    // 放在这里而不是各入口分别写：终态只有这一条收口，九个入口（正常完成、失败、
    // 取消、恢复扫描、挂起取消……）自动全覆盖，包括「提交产物后被取消的 Run」。
    await ensureReviewTaskForTerminalRun({
      repos,
      run: {
        runId,
        orgId: scope.orgId,
        userId: scope.userId,
        conversationId: run.conversationId,
        agentSessionId: run.agentSessionId,
        agentVersionId: run.agentVersionId,
        triggeringMessageId: run.triggeringMessageId,
      },
      to,
      generateId,
    });
  }

  return { ok: true, run, event };
}
