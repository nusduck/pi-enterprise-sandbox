/**
 * 把企业策略真正装到 DSH 的四个既有挂载点上（ADR 0007 D4）。
 *
 * **这个文件为什么存在**：`policy/` 下的 `evaluatePreExecute` / `runGuards` /
 * `RunBudget` / `recordLedger` 从 Wave 5 起就写好并有单测，但**从未被装配**——
 * `runtime/src/index.ts` 导出它们，runtime 之外零引用。于是审批、租户 guard、
 * 每 Run 预算、脱敏与账本在运行时全都不生效，而 `policy.test.ts` 一直是绿的
 * （它测的是纯函数）。这与 Wave 3 的占位实现是同一个形状：代码在、装配不在。
 *
 * 所以本模块的验收**只能**是组合断言：boot 之后真的调用了这些监听器。
 * 断言"函数存在"没有意义。
 *
 * ## 四个挂载点各自承担什么（ADR 0007 D4 的表）
 *
 * | 挂载点 | 承载 |
 * |---|---|
 * | `tools/pre-execute` | 风险表、参数守卫、`source_digest`、持久 PENDING 审批 |
 * | `ctx.tools.guard()` | 租户与 fence 的单调兜底——拒绝后**后续监听器无法翻案** |
 * | `tools/execute`（环绕）| 每 Run 工具数、轮次、deadline |
 * | `tools/post-execute` | 脱敏、账本、上下文附加 |
 *
 * ## Model Experience
 * 模型看到的是：被拒的调用带稳定 reason（不是自由文本），需要审批的调用停在
 * `ask` 上等人处理，超预算的调用得到明确的"预算耗尽"而不是静默截断。
 * 结果里的物理路径一律经 `redactPostExecute` 脱敏——模型不该看到宿主路径。
 *
 * ## Known Limitations and Deferred Work
 * - `ask` 依赖宿主提供审批通道；DSH 文档写明"missing approval support turns
 *   `ask` into denial"。我们的持久 PENDING 落在 `ApprovalStore` 里，Run 侧据此
 *   转 `WAITING_APPROVAL`——这条链路的真实验证要跑带审批的 Run。
 */

import type { Context } from '@deepseek-ai/cordis';
import { evaluatePreExecute, type ApprovalStore } from './pre-execute.js';
import { runGuards, type GuardListener } from './guards.js';
import { RunBudget, resolveRunBudget, wrapExecute } from './run-budget.js';
import { recordLedger, redactPostExecute, type LedgerEntry } from './post-execute.js';
import type { PolicyDecision } from './decision.js';

/** 最小可用的工具执行形状——只取本模块用得到的字段，不复制 DSH 的完整类型。 */
interface ToolExecutionLike {
  readonly name?: string;
  readonly toolName?: string;
  readonly arguments?: Record<string, unknown>;
  readonly args?: Record<string, unknown>;
  readonly id?: string;
  readonly callId?: string;
}

type PreToolDecision = { kind: 'allow' } | { kind: 'deny'; reason: string } | { kind: 'ask'; reason?: string };
type PostToolDecision = { kind: 'accept'; content?: unknown[] } | { kind: 'block'; feedback: unknown[] };

export interface InstallPolicyOptions {
  readonly approvalStore: ApprovalStore;
  /** 租户/fence 兜底。返回非 null 即视为该次调用的判定。 */
  readonly guards?: readonly GuardListener[];
  /** 账本落库。不给则丢弃——账本是可选的**外部**副作用，不是策略本身。 */
  readonly ledger?: (entry: LedgerEntry) => void;
  /** 结果脱敏要抹掉的物理根。 */
  readonly physicalRoots?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

/** 装配结果，供组合断言与主动卸载使用。 */
export interface InstalledPolicy {
  readonly budget: RunBudget;
  /** 逐个卸载。顺序与注册相反。 */
  dispose(): void;
}

function toolNameOf(exec: ToolExecutionLike): string {
  return String(exec.name ?? exec.toolName ?? '');
}

function argsOf(exec: ToolExecutionLike): Record<string, unknown> {
  return (exec.arguments ?? exec.args ?? {}) as Record<string, unknown>;
}

function callIdOf(exec: ToolExecutionLike): string {
  return String(exec.id ?? exec.callId ?? '');
}

/** `PolicyDecision` → DSH 的 `PreToolDecision`。 */
function toPreDecision(decision: PolicyDecision): PreToolDecision {
  if (decision.decision === 'deny') return { kind: 'deny', reason: decision.reason };
  if (decision.decision === 'require_approval') return { kind: 'ask', reason: decision.reason };
  return { kind: 'allow' };
}

/**
 * 在给定 cordis 上下文上装配全部策略。
 *
 * 返回的 `dispose()` 用于按 Run 卸载——guard 与监听器都是有主的，不能靠 GC。
 */
export function installEnterprisePolicy(ctx: Context, options: InstallPolicyOptions): InstalledPolicy {
  // cordis 要求经 `inject` 才能取服务：直接 `ctx.tools` 会抛
  // "cannot get property \"tools\" without inject"，不是静默跳过。
  const anyCtx = ctx as unknown as {
    on(event: string, listener: (...args: never[]) => unknown): () => void;
    inject(
      names: readonly string[],
      apply: (scoped: { tools: { guard(g: (exec: unknown) => string | undefined): () => void } }) => void,
    ): () => void;
  };
  const budget = new RunBudget(resolveRunBudget(options.env ?? process.env, options.now?.() ?? Date.now()));
  const disposers: Array<() => void> = [];

  // 1) tools/pre-execute —— 风险表 + source_digest + 持久 PENDING 审批
  disposers.push(
    anyCtx.on('tools/pre-execute', (async (
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecision>,
    ): Promise<PreToolDecision> => {
      const outcome = await evaluatePreExecute(
        { toolName: toolNameOf(exec), args: argsOf(exec), callId: callIdOf(exec) },
        options.approvalStore,
      );
      // allow 时把决定权交回瀑布——我们只加约束，不抢走别人的拒绝权。
      if (!outcome.blocked) return await next();
      return toPreDecision(outcome.decision);
    }) as never),
  );

  // 2) ctx.tools.guard() —— 单调兜底。DSH 保证 guard 没有 allow 结果，
  //    所以这里返回字符串就是最终拒绝，后续监听器翻不了案。
  const guards = options.guards ?? [];
  if (guards.length > 0) {
    disposers.push(
      anyCtx.inject(['tools'], (scoped) => {
        scoped.tools.guard((exec) => {
          const e = exec as ToolExecutionLike;
          const hit = runGuards(guards, toolNameOf(e), argsOf(e));
          if (hit === null || hit.decision === 'allow') return undefined;
          return hit.reason;
        });
      }),
    );
  }

  // 3) tools/execute（环绕）—— 每 Run 工具数 / 轮次 / deadline。
  //    `wrapExecute` 在调用工具体**之前**计数并判定，超预算直接 reject；
  //    放在之后就只是事后统计，拦不住第 201 次调用。
  disposers.push(
    anyCtx.on('tools/execute', (async (
      _exec: ToolExecutionLike,
      next: () => Promise<unknown>,
    ): Promise<unknown> => await wrapExecute(budget, next)) as never),
  );

  // 4) tools/post-execute —— 脱敏 + 账本。
  //    注意 `redactPostExecute` 脱的是**错误**，不是整个结果：成功结果的内容
  //    由工具自己负责，这里只保证失败路径不把宿主路径漏给模型。
  disposers.push(
    anyCtx.on('tools/post-execute', (async (
      exec: ToolExecutionLike,
      result: unknown,
      next: () => Promise<PostToolDecision>,
    ): Promise<PostToolDecision> => {
      const decided = await next();
      const roots = options.physicalRoots ?? [];
      const failure = (result as { isError?: boolean; error?: unknown } | null) ?? null;
      const ok = failure?.isError !== true;
      const entry = recordLedger({
        callId: callIdOf(exec),
        toolName: toolNameOf(exec),
        ok,
        ...(ok ? {} : { error: failure?.error ?? new Error('tool failed') }),
        physicalRoots: roots,
      });
      options.ledger?.(entry);
      if (ok) return decided;
      // 失败：把脱敏后的错误作为反馈块回给模型，而不是原始文本。
      return { kind: 'block', feedback: [{ type: 'text', text: entry.error?.message ?? 'tool failed' }] };
    }) as never),
  );

  return {
    budget,
    dispose(): void {
      for (const off of disposers.reverse()) {
        try {
          off();
        } catch {
          // 卸载失败不应该盖过调用方正在处理的错误。
        }
      }
    },
  };
}
