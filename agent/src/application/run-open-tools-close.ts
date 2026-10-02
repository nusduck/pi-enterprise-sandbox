/**
 * 没有活 Worker 的 Run 被取消时，给仍未结束的工具账本行收尾。
 *
 * 恢复扫描遇到 RUNNING 的工具行会转人工（副作用未知，不重放）；之后用户取消，Run 由恢复扫描
 * 推到 CANCELLED，没有执行器再回来结清这些行。这里在同一事务里关掉它们：
 *
 * - RUNNING → UNKNOWN：工具可能已经执行了一部分，结果不明（领域里专为这种情况保留的终态）；
 * - PROPOSED / WAITING_APPROVAL → CANCELLED：还没开始执行。
 *
 * 每关一行追加一条 `tool.execution.failed` 事件，与 parked-approval-cancel 的形状一致。
 */

import { TOOL_EXECUTION_STATUS } from '../domain/tool/tool-execution-status.js';
import { appendEventInTxn } from './run-event-append.js';

type Loose = any;

const CLOSE_TO: Readonly<Record<string, { status: string; errorCode: string }>> = Object.freeze({
  [TOOL_EXECUTION_STATUS.RUNNING]: {
    status: TOOL_EXECUTION_STATUS.UNKNOWN,
    errorCode: 'RUN_CANCELLED_OUTCOME_UNKNOWN',
  },
  [TOOL_EXECUTION_STATUS.PROPOSED]: {
    status: TOOL_EXECUTION_STATUS.CANCELLED,
    errorCode: 'RUN_CANCELLED',
  },
  [TOOL_EXECUTION_STATUS.WAITING_APPROVAL]: {
    status: TOOL_EXECUTION_STATUS.CANCELLED,
    errorCode: 'RUN_CANCELLED',
  },
});

export async function closeOpenToolExecutionsInTxn(args: {
  repos: Loose;
  run: Loose;
  scope: { orgId: string; userId: string };
  generateId: () => string;
  now: () => Date;
}) {
  const { repos, run, scope, generateId, now } = args;
  const tools = await repos.toolExecutions.listByRun(run.runId, scope);
  for (const tool of tools) {
    const target = CLOSE_TO[tool.status];
    if (!target) continue;
    const closed = await repos.toolExecutions.transitionStatus({
      toolExecutionId: tool.toolExecutionId,
      orgId: scope.orgId,
      userId: scope.userId,
      fromStatus: tool.status,
      toStatus: target.status,
      resultJson: { cancelled: true, reason: run.cancelReason ?? null, recoveredWithoutWorker: true },
      errorCode: target.errorCode,
      setCompletedAt: true,
    });
    await appendEventInTxn({
      repos,
      run,
      eventType: 'tool.execution.failed',
      data: {
        toolExecutionId: closed.toolExecution.toolExecutionId,
        toolCallId: closed.toolExecution.toolCallId,
        toolName: closed.toolExecution.toolName,
        status: target.status,
        cancelled: true,
        isError: true,
        errorCode: target.errorCode,
      },
      generateId,
      now,
    });
  }
}
