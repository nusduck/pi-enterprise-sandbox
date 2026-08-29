/**
 * 单实例断言（ADR 0008 D5 第三条预留扩展点）。
 *
 * `dsh-fs-local` 按目标的互斥锁只在进程内有效；`WorkspaceQuotaLedger` 的
 * `WorkspaceLock` 默认实现（`InProcessWorkspaceLock`）同样只在单进程内串行
 * 有效。exec 服务的设计前提是**单进程** + `worker_threads`（不开多进程
 * HTTP worker），今天 Python 版有 `SANDBOX_UVICORN_WORKERS` 这个隐患——
 * 有人悄悄把它调大，锁语义在多 worker 之间不成立，会静默丢写。
 *
 * 这里提供的是断言本身；**调用它**是服务启动入口（`exec/src/main.ts`，
 * 不在本任务范围）的职责，这里不做 side effect（不读 `process.env` 之外
 * 的任何东西、不自己退出进程）——调用方决定断言失败后是 `process.exit`
 * 还是抛给上层框架处理。
 */

export class SingleInstanceViolationError extends Error {
  override readonly name = 'SingleInstanceViolationError';
}

export interface SingleInstanceConfig {
  /** 期望的并发实例数。默认来自 `EXEC_CONCURRENCY`，未设置时视为 1。 */
  readonly concurrency: number;
  /** 显式开关：只有这个为 `true`，`concurrency > 1` 才被允许。默认来自
   * `EXEC_ALLOW_MULTI_INSTANCE`，未设置时视为 `false`——即默认拒绝。 */
  readonly allowMultiInstance: boolean;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** 从环境变量组装 `SingleInstanceConfig`。与 `assertSingleInstance()` 分开
 * 导出是为了让调用方（main.ts）能在断言之前先拿到解析结果做日志，也让
 * 测试可以直接构造 `SingleInstanceConfig` 而不必摆弄 `process.env`。 */
export function readSingleInstanceConfig(env: NodeJS.ProcessEnv = process.env): SingleInstanceConfig {
  const rawConcurrency = env['EXEC_CONCURRENCY'];
  const concurrency = rawConcurrency === undefined || rawConcurrency === '' ? 1 : Number(rawConcurrency);
  const rawAllow = (env['EXEC_ALLOW_MULTI_INSTANCE'] ?? '').trim().toLowerCase();
  return {
    concurrency,
    allowMultiInstance: TRUTHY.has(rawAllow),
  };
}

/**
 * 断言当前部署是单实例，或者已经显式开了多实例开关。
 *
 * - `concurrency` 不是正整数 → 配置错误，直接拒绝（不管开关）。
 * - `concurrency === 1` → 总是通过。
 * - `concurrency > 1` 且 `allowMultiInstance` 为 `false` → 拒绝，这是
 *   ADR 0008 D5 要防的"悄悄加副本导致静默丢写"。
 * - `concurrency > 1` 且显式开了开关 → 通过（把决定权交给部署方，这里
 *   只负责"必须显式"这条纪律，不评判开了之后安全不安全——`WorkspaceLock`
 *   要换成跨实例实现是那之后的另一件事，见 `lock.ts`）。
 */
export function assertSingleInstance(config: SingleInstanceConfig): void {
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new SingleInstanceViolationError(
      `invalid EXEC_CONCURRENCY: expected a positive integer, got ${config.concurrency}`,
    );
  }
  if (config.concurrency > 1 && !config.allowMultiInstance) {
    throw new SingleInstanceViolationError(
      `refusing to start with EXEC_CONCURRENCY=${config.concurrency}: multi-instance deployment ` +
        'requires explicit EXEC_ALLOW_MULTI_INSTANCE=true (WorkspaceLock is in-process only by ' +
        'default; see exec/src/workspace/lock.ts)',
    );
  }
}
