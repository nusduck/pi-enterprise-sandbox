/**
 * Worker 依赖守卫（design §9.2）：依赖不可用时暂停从 BullMQ 取新任务，恢复后继续。
 *
 * readiness=false 只会让编排摘流量，BullMQ 消费者照样在取任务——Worker 没有入口流量可摘。
 * 这里定期探测 MySQL / Redis（与 `/ready` 同一套 ping 与超时）：
 *
 * - 连续 `FAILURES_BEFORE_PAUSE` 次失败 → `worker.pause(true)`：不再取新任务，**不等待**
 *   也不打断在跑的任务（在跑的 Run 由既有 lease / fence 兜底）。BullMQ 的 pause 只改本地
 *   标志，不依赖 Redis 可达。
 * - 暂停后连续 `SUCCESSES_BEFORE_RESUME` 次成功 → `worker.resume()`。只恢复**本守卫**造成的暂停。
 *
 * 连续阈值用来吸收单次抖动，不是重试：一次失败不暂停，一次成功不恢复。探测串行执行，
 * 上一次没结束不会叠加下一次。暂停调用失败时保持未暂停状态，下一轮重试。
 */

export const DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS = 5000;
export const FAILURES_BEFORE_PAUSE = 2;
export const SUCCESSES_BEFORE_RESUME = 2;

/** 解析探测间隔。空值取默认；非法值拒绝启动。 */
export function resolveDependencyCheckInterval(value: unknown): number {
  if (value == null || String(value).trim() === '') return DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS;
  const raw = String(value).trim();
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 500 || parsed > 600_000) {
    throw new Error('AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS must be an integer between 500 and 600000');
  }
  return parsed;
}

export interface DependencyStatus {
  readonly mysql: boolean;
  readonly redis: boolean;
}

export interface DependencyGuardDeps {
  readonly intervalMs: number;
  readonly check: () => Promise<DependencyStatus>;
  readonly pause: () => Promise<void>;
  readonly resume: () => void;
  readonly log?: (level: 'warn' | 'info', message: string) => void;
}

export interface DependencyGuard {
  /** 当前是否处于本守卫造成的暂停。 */
  readonly pausedByGuard: () => boolean;
  /** 立即执行一次探测（测试与诊断用）；与定时探测串行。 */
  readonly checkNow: () => Promise<void>;
  /** 停止定时探测并等待在途探测结束；不会恢复消费者。 */
  readonly stop: () => Promise<void>;
}

function describeDown(status: DependencyStatus): string {
  const down = [];
  if (!status.mysql) down.push('mysql');
  if (!status.redis) down.push('redis');
  return down.join(', ');
}

export function startWorkerDependencyGuard(deps: DependencyGuardDeps): DependencyGuard {
  const log = deps.log ?? (() => {});
  let failures = 0;
  let successes = 0;
  let paused = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<void> = Promise.resolve();

  const evaluate = async (): Promise<void> => {
    let status: DependencyStatus;
    try {
      status = await deps.check();
    } catch {
      status = { mysql: false, redis: false };
    }
    if (stopped) return;

    if (status.mysql && status.redis) {
      failures = 0;
      successes += 1;
      if (paused && successes >= SUCCESSES_BEFORE_RESUME) {
        deps.resume();
        paused = false;
        log('info', 'dependencies recovered; resumed BullMQ consumer');
      }
      return;
    }

    successes = 0;
    failures += 1;
    if (!paused && failures >= FAILURES_BEFORE_PAUSE) {
      try {
        await deps.pause();
        paused = true;
        log('warn', `dependencies unavailable (${describeDown(status)}); paused BullMQ consumer`);
      } catch {
        log('warn', 'pausing BullMQ consumer failed; will retry on the next check');
      }
    }
  };

  // 所有探测挂在同一条链上，定时与手动触发都不会并发。
  const run = (): Promise<void> => {
    chain = chain.then(evaluate, evaluate);
    return chain;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void run().finally(schedule);
    }, deps.intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    pausedByGuard: () => paused,
    checkNow: () => run(),
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain.catch(() => {});
    },
  };
}
