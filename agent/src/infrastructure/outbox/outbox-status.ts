/**
 * Outbox status constants (plan §8.17 / PR-03 delivery).
 * Shared with the durable MySQL outbox schema.
 */

export const OUTBOX_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
});

/** outbox 行的状态取值。 */
export type OutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

/** Aggregate type that maps to run:stream:{runId}. */
export const AGGREGATE_TYPE_RUN = 'run';

/**
 * Run 进入终态时同事务多写的一行，只给通知消费者认领。payload **不带**
 * `runId` / `run_id` 键（run id 在 aggregate_id）：RunEventStream publisher 的
 * eligibility 会认领带这两个键的任何行，带上就会被它抢走。
 */
export const AGGREGATE_TYPE_RUN_NOTIFICATION = 'run_notification';
export const EVENT_TYPE_RUN_TERMINAL_NOTIFICATION = 'notification.run_terminal';
/**
 * 定时任务触发的 Run 停在 WAITING_APPROVAL / WAITING_INPUT 时的通知请求
 *（design `notification-scenarios.md` §3.2）。payload `{ status, orgId, userId,
 * waitKind: 'approval' | 'input', waitId }`——同样不带 `runId` / `run_id` 键，
 * run id 在 `aggregate_id`。
 */
export const EVENT_TYPE_RUN_WAITING_NOTIFICATION = 'run.waiting.notification';

/**
 * 审核流程的**工作队列**（design `agent-output-review.md` §5.3 / §6.2）。
 *
 * 放行/撤回、修订版导入工作区、材料快照都是**跨服务调用**（agent → exec 内部面），
 * 不能放进 agent 的数据库事务里。所以 agent 事务只写一行意图，由 agent-worker 的
 * 审核循环消费、重试，exec 侧幂等。
 *
 * 与 `run_notification` 同样的纪律：**payload 里不能出现 `runId` / `run_id` 键**，
 * 否则会被 RunEventStream publisher 的 eligibility 抢走（见本文件上一条注释）。
 * 任务 id 放 `aggregate_id`，run id 由消费者按任务行回查。
 */
export const AGGREGATE_TYPE_REVIEW = 'review';
/** 材料快照：把 review_materials 里的占位行补齐成 exec 里的不可变快照。 */
export const EVENT_TYPE_REVIEW_SNAPSHOT = 'review.snapshot';
/** 放行/驳回：一组产物状态变更，以及（有修订时的）导入工作区 `审核版/`。 */
export const EVENT_TYPE_REVIEW_DECIDED = 'review.decided';

/** 审核结果通知（复用投递账本，`kind` 取 `review_released` / `review_rejected`）。 */
export const AGGREGATE_TYPE_REVIEW_NOTIFICATION = 'review_notification';
export const EVENT_TYPE_REVIEW_DECIDED_NOTIFICATION = 'notification.review_decided';
/**
 * 待我审核：审核任务建立时的通知请求（design `notification-scenarios.md` §3.2）。
 * payload `{ reviewTaskId, orgId, requesterUserId }`——不带 run id 键，任务 id 在
 * `aggregate_id`，run id 由消费者按任务行回查。
 */
export const EVENT_TYPE_REVIEW_PENDING_NOTIFICATION = 'review.pending.notification';

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_STALE_CLAIM_MS = 60_000;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 300_000;
export const DEFAULT_CLAIM_BATCH_SIZE = 50;
export const LAST_ERROR_MAX_LEN = 512;
