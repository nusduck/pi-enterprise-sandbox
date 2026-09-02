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
import { recordLedger, type LedgerEntry } from './post-execute.js';
import type { PolicyDecision } from './decision.js';
import { RunPark, RUN_PARKED_REASON_CODE } from './park.js';
import { approvalIdOf } from './approval-id.js';
import { runWithToolExecutionContext } from '../providers/tool-execution-context.js';
import {
  isDurableInteractionPendingError,
  isDurableInteractionPendingResult,
} from '../providers/user-questions.js';

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
  /**
   * 工具执行的 durable 记录（ADR 0009 D11 / 计划 H9.6）。
   *
   * 与 `ledger` 的区别：`ledger` 是**事后**的一条脱敏摘要；这两个回调对应
   * `tool_executions` 表的两端，`tool.execution.started` / `.succeeded|failed`
   * 事件也从这里出。
   *
   * 2026-08-31 之前它只经 `extensionBundleFactory` 到达运行时——与审批、
   * 子 Agent、风险表同一族的断链。症状是 compose 里 Run 跑成功、文件真的落盘，
   * 而 `tool_executions` 一行都没有。
   */
  readonly toolLedger?: {
    started(input: { toolCallId: string; toolName: string; args?: unknown }): Promise<unknown>;
    ended(input: {
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result?: unknown;
      args?: unknown;
    }): Promise<unknown>;
  };
  /** 结果脱敏要抹掉的物理根。 */
  readonly physicalRoots?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /**
   * 运维可配的工具风险覆盖（`TOOL_RISK_POLICY_JSON` / `TOOL_RISK_POLICY_PATH`
   * 经 `agent/config.js` 的 `resolveToolRiskPolicy` 解析）。
   * **不传等于把这个配置面静默丢掉**——它以前就是这么丢的：解析出来喂给了一个
   * 返回 [] 的 extension bundle。
   */
  /**
   * 本 Run 允许模型**看见**的工具（ADR 0009 D9 §4 / 计划 H7.7）。
   *
   * 省略 = 不收窄。给了就调 `ctx.tools.restrict({ allow })`，把 scope 继承来的
   * 工具面过滤成这一份。
   *
   * **可见性不是权威层**：真正拒绝仍由 `pre-execute` 与 `guard()` 承担
   * （它们是单调 fail-closed 的）。收窄只是省上下文、少诱发必然被拒的调用。
   * 两层都要在——只做可见性等于把闸门交给模型的自觉。
   */
  readonly visibleTools?: readonly string[];
  readonly riskOverrides?:
    | Readonly<Record<string, 'low' | 'medium' | 'high' | 'critical'>>
    | ((toolName: string) => 'low' | 'medium' | 'high' | 'critical' | undefined);
}

/** 装配结果，供组合断言与主动卸载使用。 */
export interface InstalledPolicy {
  readonly budget: RunBudget;
  /**
   * 本 Run 的停泊闸门（ADR 0009 D5 / 计划 H4）。executor 在 turn 结束后读
   * `park.pending`：非 null 就把 Run 投影成 WAITING_APPROVAL 并释放 Worker。
   */
  readonly park: RunPark;
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

/** 出厂 `dsh-user-approval` 的结果词表。 */
type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

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
  // **每 Run 一个**。装在根 ctx 上会让一个 Run 的停泊把所有 Run 一起锁死。
  const park = new RunPark();
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
        undefined,
        options.riskOverrides ?? {},
      );
      // allow 时把决定权交回瀑布——我们只加约束，不抢走别人的拒绝权。
      if (!outcome.blocked) return await next();
      // 铸出 PENDING 的同一刻停泊本 Run（ADR 0009 D5 的实测修正形状，见 park.ts）：
      // 光靠「这次调用被拒」停不下 turn——实测模型会拿着错误结果继续走一步。
      if (outcome.approval !== null) {
        park.arm({
          callId: callIdOf(exec),
          toolName: toolNameOf(exec),
          approvalId: outcome.approval.id,
        });
      }
      return toPreDecision(outcome.decision);
    }) as never),
  );

  // 2) ctx.tools.guard() —— 单调兜底。DSH 保证 guard 没有 allow 结果，
  //    所以这里返回字符串就是最终拒绝，后续监听器翻不了案。
  const guards = options.guards ?? [];
  disposers.push(
    anyCtx.inject(['tools'], (scoped) => {
      scoped.tools.guard((exec) => {
        const e = exec as ToolExecutionLike;
        // 停泊闸门排在最前：Run 一旦在等审批，本轮**任何**工具都不许再跑。
        // guard 是单调的（"no guard can force-allow a call another guard denied"），
        // 所以这里返回理由就是终局，后面的监听器翻不了案。
        const parked = park.denyReason(callIdOf(e));
        if (parked !== undefined) return parked;
        if (guards.length === 0) return undefined;
        const hit = runGuards(guards, toolNameOf(e), argsOf(e));
        if (hit === null || hit.decision === 'allow') return undefined;
        return hit.reason;
      });
    }),
  );

  // 3) tools/execute（环绕）—— 每 Run 工具数 / 轮次 / deadline + durable 账本两端。
  //    `wrapExecute` 在调用工具体**之前**计数并判定，超预算直接 reject；
  //    放在之后就只是事后统计，拦不住第 201 次调用。
  disposers.push(
    anyCtx.on('tools/execute', (async (
      exec: ToolExecutionLike,
      next: () => Promise<unknown>,
    ): Promise<unknown> => {
      const toolCallId = callIdOf(exec);
      const toolName = toolNameOf(exec);
      const args = argsOf(exec);
      return runWithToolExecutionContext(
        { callId: toolCallId, toolName, args },
        async () => {
          const ledger = options.toolLedger;
          if (ledger === undefined) return await wrapExecute(budget, next);

          // 记账失败**不得**打死一次合法的工具调用：账本是外部副作用。
          // 但**必须留下痕迹**——静默吞掉的后果是 `tool_executions` 里留下永远
          // RUNNING 的行，而没有任何人知道为什么（2026-08-31 compose 端到端撞到过）。
          const note = (phase: string, err: unknown): void => {
            console.error(
              `[tool-ledger] ${phase} failed for ${toolName} (${toolCallId}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          };
          await ledger.started({ toolCallId, toolName, args }).catch((e) => note('started', e));
          try {
            const result = await wrapExecute(budget, next);
            if (!isDurableInteractionPendingResult(result)) {
              const isError = (result as { isError?: boolean } | null)?.isError === true;
              await ledger
                .ended({ toolCallId, toolName, isError, result, args })
                .catch((e) => note('ended', e));
            }
            return result;
          } catch (err) {
            // Parking ask_user_question throws after the WAITING_INPUT row is
            // committed so DSH cannot fabricate an answer. Recording that throw
            // as FAILED leaves the tool un-respondable (CAS: have FAILED,
            // expected RUNNING) — compose 2026-09-02, 409 CONFLICT.
            if (!isDurableInteractionPendingError(err)) {
              await ledger
                .ended({ toolCallId, toolName, isError: true, result: { error: String(err) }, args })
                .catch((e) => note('ended(after throw)', e));
            }
            throw err;
          }
        },
      );
    }) as never),
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

  // 4.5) ctx.tools.restrict() —— 按 Run 收窄**可见**工具面（ADR 0009 D9 §4）。
  //
  //     2026-08-31 起栈实测确认这个机制存在（H0.4）：`restrict` 过滤的是
  //     scope **继承来的**那一层，不过滤 scope 自己注册的工具。我们走的正是
  //     host 组合（工具在 global layer），所以它对我们有效——官方 preset 把工具
  //     搬到 agent plane 之后反而失效过（出厂 d.ts 里记着这个坑）。
  //
  //     **不引入 preset**：预设表是 process-level、无租户维度的（ADR 0009 D3）。
  const visible = options.visibleTools;
  if (visible !== undefined && visible.length > 0) {
    disposers.push(
      anyCtx.inject(['tools'], (scoped) => {
        const tools = scoped.tools as unknown as {
          restrict?: (filter: { allow?: readonly string[] }) => () => void;
        };
        // 出厂没有这个方法时静默跳过：可见性是优化，权威层在 guard 上。
        // 但**必须**是静默跳过而不是抛——否则一次上游版本变动会让所有 Run 起不来。
        tools.restrict?.({ allow: [...visible] });
      }),
    );
  }

  // 5) approval/request —— 企业 answerer（ADR 0009 D5）。
  //
  //    **装在每 Run 的 agent scope 上，不是进程级插件**：审批 store 是按 Run 的，
  //    而 seam 的 waterfall 支持 agent-scoped 监听器（出厂文档原话：
  //    "Agent-scoped listeners receive only that agent's requests"）。
  //    做成 overlay 里的进程级插件反而要再造一条「怎么把本 Run 的 store 递进去」
  //    的通路。计划 H4 原写「插一个 enterprise-approval-answerer 插件」，
  //    实现时改到这里，理由如上。
  //
  //    **绝不挂 promise 等人**：上游明写 "a durable out-of-turn approval workflow
  //    is deferred"，请求必须处在一个 open turn 内。挂着等 = 堵住 Worker。
  //    没有决定就立刻返回 rejected，停泊靠 park guard（见 park.ts）。
  disposers.push(
    anyCtx.on('approval/request', (async (
      req: { toolName?: string; callId?: string; agent?: unknown },
      next: () => Promise<ApprovalOutcome>,
    ): Promise<ApprovalOutcome> => {
      const callId = String(req?.callId ?? '');
      if (callId === '') {
        // 没有 callId 就没法把决定绑到具体那次调用上。fail-closed：
        // 与其猜，不如拒——出厂默认也是 fail closed。
        return 'rejected';
      }
      const record = await options.approvalStore.get(approvalIdOf(callId));
      if (record === null) return next() as Promise<ApprovalOutcome>;
      if (record.status === 'APPROVED') return 'allowed-once';

      // PENDING（第一次问，人还没看）与 DENIED 都是「这次不许跑」。
      // 二者的区别在 Run 状态：PENDING → 停泊 → WAITING_APPROVAL；
      // DENIED → 不停泊，模型收到拒绝理由继续干别的。
      if (record.status === 'PENDING' && park.pending?.callId === callId) {
        // **主动中止本轮**。实测（scripts/probe-approval-park.ts）：
        //   场景 A 只返回 rejected → turn 不结束，模型多走一步（2 次循环请求）；
        //   场景 D 同步 cancel     → turn 立刻结束（1 次，稳定复现 3/3）。
        // 所以 cancel 省掉那次无谓的模型往返。`keepInbox` 保住排队中的用户消息
        // ——续跑要用它们，cancel 的默认语义会清掉。
        //
        // park guard **仍然留着**，两者叠加不是重复：cancel 中止的是「活动中的
        // turn」，若循环已经把下一次请求发出去，guard 仍能保证那一步里模型
        // 碰不到任何工具。少了任何一个，都有一条路径能让模型在等审批时继续动手。
        const agent = (req as { agent?: { cancel?: (cause: unknown, opts?: unknown) => void } }).agent;
        try {
          agent?.cancel?.({ kind: 'hook', reason: RUN_PARKED_REASON_CODE }, { keepInbox: true });
        } catch {
          // 中止失败不改变判定：这次调用照样不许落地，park guard 兜住其余。
        }
      }
      return 'rejected';
    }) as never),
  );

  return {
    budget,
    park,
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
