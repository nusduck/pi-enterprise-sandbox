/**
 * Worker 的有界关停（K8s 部署评审 K4，2026-09-19）。
 *
 * BullMQ `worker.close()` 默认等在途作业**全部**结束，没有上限；一个 Run 可以包含多次
 * 工具（默认单次 120s）与模型调用，远超编排给的终止宽限。
 *
 * ## 时间预算从收到信号起算
 *
 * 第一版只给 `worker.close()` 计时，而它前面还串着「停依赖守卫 → 停 cron → 等 outbox
 * 循环退出」。outbox 的 `publishOnce()` 在 MySQL 挂起时没有上限，于是期限根本轮不到，
 * 消费者也一直没有关——仍在取新任务。现在：
 *
 * 1. 收到信号立即置未就绪，并**同时**开始两件事：关消费者（`close()` 立即停止取新作业，
 *    再等在途作业）与停后台循环（守卫、cron、恢复定时器、outbox）；
 * 2. 两者合起来受 `AGENT_WORKER_DRAIN_TIMEOUT_MS` 约束，**从收到信号起算**；
 *    - 期限内都结束 → 进入清理；
 *    - 期限到 → **不做任何清理，直接退出（码 1）**。这与进程被 SIGKILL 等价，走既有的
 *      崩溃恢复路径（`run-recovery-service`）：租约过期后恢复扫描接手；工具账本全是终态
 *      的 Run 重放，仍有 RUNNING / 未决工具的 Run 不自动重放，保持非终态等人工核对或
 *      取消。此时**不能**关连接池或 runtime——那会让仍在执行的 Run 撞上连接关闭，把本该
 *      由恢复扫描判定的状态提前写坏；
 * 3. 清理（runtime / 容器 / 遥测）另有 `WORKER_TEARDOWN_TIMEOUT_MS` 上限，到期同样
 *    直接退出（码 1）。在途作业此时已结束，不再有被写坏的状态。
 *
 * 编排侧终止宽限（K8s `terminationGracePeriodSeconds` / Compose `stop_grace_period`）
 * 必须大于两者之和，否则还没轮到这里的判定就被 SIGKILL。
 */

export const DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS = 150_000;
/** 排空结束后的清理上限。 */
export const WORKER_TEARDOWN_TIMEOUT_MS = 15_000;
/** 退出前关探针 listener 的上限。 */
const PROBE_CLOSE_TIMEOUT_MS = 2_000;

/** 解析排空期限。空值取默认；非法值拒绝启动。 */
export function resolveDrainTimeout(value: unknown): number {
  if (value == null || String(value).trim() === '') return DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 3_600_000) {
    throw new Error('AGENT_WORKER_DRAIN_TIMEOUT_MS must be an integer between 1000 and 3600000');
  }
  return parsed;
}

/** 在期限内等待；返回 `done` 或 `deadline`。步骤自身失败按已结束处理（各步骤自己留痕）。 */
export async function withinDeadline(
  work: () => Promise<unknown>,
  timeoutMs: number,
): Promise<'done' | 'deadline'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(work)
        .then(
          () => 'done' as const,
          () => 'done' as const,
        ),
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface WorkerShutdownSteps {
  /** 置未就绪（同步）。 */
  readonly markNotReady: () => void;
  /** 关全部消费者：立即停止取新作业，再等在途作业。 */
  readonly stopIntake: () => Promise<unknown>;
  /** 停依赖守卫、cron、恢复定时器与 outbox 循环。 */
  readonly stopBackground: () => Promise<unknown>;
  /** 排空后清理 runtime / 容器 / 遥测。 */
  readonly teardown: () => Promise<unknown>;
  readonly closeProbe: () => Promise<unknown>;
  readonly exit: (code: number) => void;
  readonly log: (level: 'info' | 'error', message: string) => void;
  readonly now?: () => number;
}

export interface WorkerShutdownBudget {
  readonly drainTimeoutMs: number;
  readonly teardownTimeoutMs?: number;
}

export type WorkerShutdownOutcome = 'clean' | 'drain_deadline' | 'teardown_deadline';

export async function runWorkerShutdown(
  signal: string,
  steps: WorkerShutdownSteps,
  budget: WorkerShutdownBudget,
): Promise<WorkerShutdownOutcome> {
  const now = steps.now ?? Date.now;
  const startedAt = now();
  steps.markNotReady();
  steps.log('info', `${signal} — shutting down (drain budget ${budget.drainTimeoutMs}ms from signal)`);

  // 关消费者先发起：close() 同步置位后就不再取新作业，不等任何前置步骤。
  const intake = Promise.resolve().then(steps.stopIntake).catch(() => undefined);
  const background = Promise.resolve().then(steps.stopBackground).catch(() => undefined);
  const drained = await withinDeadline(
    () => Promise.all([intake, background]),
    budget.drainTimeoutMs - (now() - startedAt),
  );

  if (drained === 'deadline') {
    steps.log(
      'error',
      `drain deadline ${budget.drainTimeoutMs}ms reached with runs or background loops still active — exiting without teardown; leases expire and recovery takes over`,
    );
    await withinDeadline(steps.closeProbe, PROBE_CLOSE_TIMEOUT_MS);
    steps.exit(1);
    return 'drain_deadline';
  }

  const teardownTimeoutMs = budget.teardownTimeoutMs ?? WORKER_TEARDOWN_TIMEOUT_MS;
  const tornDown = await withinDeadline(steps.teardown, teardownTimeoutMs);
  if (tornDown === 'deadline') {
    steps.log('error', `teardown exceeded ${teardownTimeoutMs}ms — exiting`);
    await withinDeadline(steps.closeProbe, PROBE_CLOSE_TIMEOUT_MS);
    steps.exit(1);
    return 'teardown_deadline';
  }
  await withinDeadline(steps.closeProbe, PROBE_CLOSE_TIMEOUT_MS);
  steps.exit(0);
  return 'clean';
}
