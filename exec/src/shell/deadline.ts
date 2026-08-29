/**
 * 超时 / 取消信号融合——`run()` 的 `timedOut`/`aborted` 互斥分类需要的
 * 最小工具（dsh-shell README："one fused deadline drives both the timeout
 * and the caller's cancellation... reports the single first-abort cause"）。
 *
 * 为什么不直接用生态里现成的 `@deepseek-ai/dsh-timeout`：它的 `Deadline`
 * 接口用 `[Symbol.dispose]` 表达"清理定时器"，这需要 TS 的
 * `esnext.disposable` lib（`Symbol.dispose` 的类型声明）。仓库共享的
 * `tsconfig.base.json`（`contract/`/`runtime/`/`exec/` 三个包共用）目前
 * `lib` 只到 `ES2023`，不含这个——本次改动范围严格限定在
 * `exec/src/shell/` 与它的测试，不该为了用一个小工具去动一个三个包共用的
 * 顶层 tsconfig。所以这里自己写一个不依赖 `Symbol.dispose` 的等价实现，
 * 语义对齐（先到者赢，互斥），体量也小（不到 40 行）。
 */

/** 融合出的信号，加一个"是不是这次超时导致的中止"的判定。 */
export interface FusedDeadline {
  readonly signal: AbortSignal;
  /** 在 `signal` 触发之后调用才有意义：是不是这次融合自己的定时器抢先中止的。 */
  timedOut(): boolean;
  /** 清理定时器 / 监听器。必须在使用完毕后调用一次，防止定时器延长进程寿命。 */
  clear(): void;
}

/**
 * 融合 `upstream`（调用方的取消信号，可选）与一个 `timeoutMs` 定时器：
 * 谁先触发，`signal` 就因谁而 abort，另一个来源即使之后也触发，也不会
 * 覆盖已经生效的 abort（`AbortController.abort()` 在已中止后是 no-op）。
 *
 * `timeoutMs <= 0` 表示不设定时器（内部哨兵，与 `dsh-timeout` 一致）。
 */
export function fuseDeadline(upstream: AbortSignal | undefined, timeoutMs: number): FusedDeadline {
  const controller = new AbortController();
  let timedOutFlag = false;
  let timer: NodeJS.Timeout | undefined;

  const onUpstreamAbort = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(upstream?.reason);
  };

  if (upstream) {
    if (upstream.aborted) {
      controller.abort(upstream.reason);
    } else {
      upstream.addEventListener('abort', onUpstreamAbort, { once: true });
    }
  }

  if (timeoutMs > 0 && !controller.signal.aborted) {
    timer = setTimeout(() => {
      if (controller.signal.aborted) return; // upstream 已经先中止了，超时定时器只是慢了一步。
      timedOutFlag = true;
      controller.abort(new Error(`execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOutFlag,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      upstream?.removeEventListener('abort', onUpstreamAbort);
    },
  };
}
