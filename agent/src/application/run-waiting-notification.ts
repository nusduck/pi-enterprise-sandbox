/**
 * Run 停到 WAITING_APPROVAL / WAITING_INPUT 时的通知 outbox 写入
 *（design `notification-scenarios.md` §3.2）。
 *
 * 从 `FencedToolGovernanceRecorder` 拆出：那个文件行数钉在 1557（`tests/`
 * 的行数棘轮），展开写会超预算，所以这里只留一个小函数，recorder 里各加一行
 * 调用。发不发、发给谁由分发器的 `runWaiting` 处理器按账本决定；这里只记
 * 「这个 Run 在等什么」。
 *
 * payload 纪律（`outbox-status.ts`）：**不得含 `runId` / `run_id` 键**，run id
 * 在 `aggregate_id`，否则会被 RunEventStream publisher 抢走。
 */

import {
  AGGREGATE_TYPE_RUN_NOTIFICATION,
  EVENT_TYPE_RUN_WAITING_NOTIFICATION,
} from '../infrastructure/outbox/outbox-status.js';
import { assertUlid } from '../domain/shared/ulid.js';

export type RunWaitKind = 'approval' | 'input';

/**
 * 与 Run 停住同事务写一行 `run_notification`。**在调用方已开的事务里执行**，
 * `repos` 就是调用方手里的那一份（`repos.outbox.insert` 同事务）。
 */
export async function enqueueRunWaitingNotificationInTxn(input: {
  repos: { outbox: import('../infrastructure/outbox/outbox-repository.js').OutboxRepository };
  runId: string;
  scope: { orgId: string; userId: string };
  status: 'WAITING_APPROVAL' | 'WAITING_INPUT';
  waitKind: RunWaitKind;
  /** 审批 id 或提问 interaction id：分发器按它去重（同一次停住只发一封）。 */
  waitId: string;
  generateId: () => string;
}): Promise<void> {
  const { repos, runId, scope, status, waitKind, waitId, generateId } = input;
  await repos.outbox.insert({
    outboxId: assertUlid(generateId(), 'notificationOutboxId'),
    aggregateType: AGGREGATE_TYPE_RUN_NOTIFICATION,
    aggregateId: runId,
    eventType: EVENT_TYPE_RUN_WAITING_NOTIFICATION,
    payloadJson: {
      status,
      orgId: scope.orgId,
      userId: scope.userId,
      waitKind,
      waitId,
    },
  });
}
