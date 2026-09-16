/**
 * 受限执行的**共享编排**：限额 → 执行器、子进程配额准入与采样、取消信号融合。
 *
 * 为什么单独成文件（2026-09-16 修复后复核 F1）：R1/R2 的修复最初只写在
 * `http/internal-shell.ts` 里，MCP 窄桥 `http/internal-mcp.ts` 仍然 new 一个
 * 裸执行器——`maxProcessCount=0`、没有 rlimit、没有配额准入/采样、请求断开
 * 到不了执行面。外部 MCP 客户端恰好走这条路。两个入口各写一份编排，下一次
 * 加限额又会漏掉一个，所以把编排下沉到这里，两条路由都调它。
 *
 * 这里**不**做鉴权、不解析请求体：内部面的 HMAC/fence 与窄桥的 bearer 仍由各自
 * 路由负责，两者不可互相替代（AGENTS.md §1）。
 */

import type { ShellRunResult } from '@deepseek-ai/dsh-shell';
import { IsolatedShellExecutor } from './executor.js';
import { DEFAULT_SHELL_RESOURCE_LIMITS, type ShellResourceLimits } from './resource-limits.js';
import {
  ChildWorkspaceQuotaWatch,
  evaluateChildQuota,
  type ChildQuotaConfig,
  type ChildQuotaDecision,
} from '../workspace/child-quota.js';
import { InMemoryQuotaStore, type QuotaStore } from '../workspace/quota-store.js';
import type { WorkspaceContext } from '../types.js';

export interface GuardedExecutionDeps {
  readonly bwrapExecutable: string;
  /** 执行面限额。缺省即内置默认值——只适合单测，生产装配必须传。 */
  readonly resourceLimits?: ShellResourceLimits;
  /** 子进程磁盘配额监控配置。`enforcement: false` 或缺省时准入与采样都不做。 */
  readonly childQuota?: ChildQuotaConfig;
  /** 配额账本（读预留量）。不传则用进程内实现——只适合单测与本地开发。 */
  readonly quotaStore?: QuotaStore;
}

export function effectiveResourceLimits(deps: GuardedExecutionDeps): ShellResourceLimits {
  return deps.resourceLimits ?? DEFAULT_SHELL_RESOURCE_LIMITS;
}

/** 按限额建执行器：前台预算、输出上限、命名空间内部 rlimit 逐条落下。 */
export function makeLimitedExecutor(
  deps: GuardedExecutionDeps,
  ctx: WorkspaceContext,
  mode: 'read-only' | 'workspace-write',
): IsolatedShellExecutor {
  const limits = effectiveResourceLimits(deps);
  return new IsolatedShellExecutor({
    workspace: ctx,
    bwrapExecutable: deps.bwrapExecutable,
    mode,
    defaultTimeoutMs: limits.executionTimeoutMs,
    outputCapChars: limits.maxOutputChars,
    maxProcessCount: limits.maxProcessCount,
    rlimits: limits.rlimits,
  });
}

export interface QuotaGate {
  /** 准入判定。`allow: false` 时调用方必须**不** spawn。 */
  admit(): Promise<ChildQuotaDecision>;
  /** spawn 之后开始采样；返回一个必须在每条出口调用的停止函数（幂等）。 */
  watch(onViolation: (decision: ChildQuotaDecision) => void): () => Promise<void>;
}

export function quotaGateFor(deps: GuardedExecutionDeps, ctx: WorkspaceContext): QuotaGate {
  const config = deps.childQuota;
  if (config === undefined || !config.enforcement) {
    return {
      admit: async () => ({ allow: true, message: 'monitoring disabled' }),
      watch: () => async () => undefined,
    };
  }
  const quotaDeps = { quotaStore: deps.quotaStore ?? new InMemoryQuotaStore() };
  return {
    admit: () =>
      evaluateChildQuota(ctx.workspaceRoot, ctx.tempRoot, config, quotaDeps, {
        workspaceId: ctx.workspaceId,
      }),
    watch: (onViolation) => {
      const watch = new ChildWorkspaceQuotaWatch({
        workspacePath: ctx.workspaceRoot,
        tempPath: ctx.tempRoot,
        workspaceId: ctx.workspaceId,
        config,
        deps: quotaDeps,
        onViolation,
      });
      watch.start();
      // 幂等：每条出口（正常结束、取消、spawn 失败）都会调一次。
      let stopped: Promise<void> | undefined;
      return () => (stopped ??= watch.stop());
    },
  };
}

/** 前台执行的结局：要么真的跑了，要么被配额拒绝（准入或执行中超额）。 */
export type GuardedForegroundOutcome =
  | { readonly kind: 'ran'; readonly result: ShellRunResult }
  | { readonly kind: 'denied'; readonly message: string };

/**
 * 前台执行的编排：准入 → 采样 → 执行 → 每条出口停采样。
 *
 * 取消的来源融合成一个信号交给 `run`：客户端断开（`clientSignal`）与配额监控
 * 报警；执行器内部的超时定时器在 `runForeground` 里另行融合。准入不通过时
 * **不调用** `run`——fail-closed，把原因交回调用方如实告诉模型。
 */
export async function runGuardedForeground(input: {
  readonly gate: QuotaGate;
  readonly clientSignal?: AbortSignal | null | undefined;
  readonly run: (signal: AbortSignal) => Promise<ShellRunResult>;
}): Promise<GuardedForegroundOutcome> {
  const admission = await input.gate.admit();
  if (!admission.allow) return { kind: 'denied', message: admission.message };

  const controller = new AbortController();
  let quotaViolation: ChildQuotaDecision | undefined;
  const stopWatch = input.gate.watch((decision) => {
    quotaViolation = decision;
    controller.abort();
  });
  const clientSignal = input.clientSignal ?? undefined;
  const onClientAbort = (): void => controller.abort();
  if (clientSignal !== undefined) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  try {
    const result = await input.run(controller.signal);
    if (quotaViolation !== undefined) return { kind: 'denied', message: quotaViolation.message };
    return { kind: 'ran', result };
  } finally {
    clientSignal?.removeEventListener('abort', onClientAbort);
    await stopWatch();
  }
}
