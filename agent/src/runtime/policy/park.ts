/**
 * Run 停泊状态（ADR 0009 D5，实测修正后的形状 —— 计划 H4）。
 *
 * ## 为什么需要它：D5 原来的停泊机制不成立
 *
 * D5 写的是「answerer 返回非 allow → 该次工具调用不落地 → **turn 正常结束** →
 * Run 转 WAITING_APPROVAL → 释放 Worker」。2026-08-31 起栈实测
 * （`agent/scripts/probe-approval-park.ts`，证据
 * `docs/evidence/2026-08-31-dsh-tool-registry.md`）：**前半对，后半错**。
 * 工具确实不落地，但 turn **不结束**——模型拿到一个错误型 tool result，
 * 循环把它喂回去，又发了一次请求。
 *
 * 类型层面也是关死的：出厂 `concludesTurn` **只存在于 `ToolExecutionSuccess`**，
 * `ToolExecutionFailure` 上是 `concludesTurn?: never`——**一个被拒的调用在类型上
 * 就不可能结束 turn**。唯一能停循环的原语是 `ToolRunContext.concludeTurn()`，
 * 而它只对我们自己写的工具体可用；`read` / `bash` 这些出厂工具的体不是我们的
 * （wrapper 自己写 `concludesTurn` 会被规范化掉，实测场景 B 已验）。
 *
 * ## 因此改成：接受「多走一步」，但把这一步锁死
 *
 * 铸出 PENDING 的同一刻 `arm()`。此后本 Run 内**任何**工具调用都被
 * `ctx.tools.guard()` 拒（单调 fail-closed，"no guard can force-allow a call
 * another guard denied"）。模型于是没有工具可用，只能输出一段文本，turn 结束。
 *
 * **代价写在明处**：每次停泊多一次模型往返。**换来的是**这一步里模型碰不到任何
 * 工具，不会趁机产生别的副作用——那正是不加 guard 时（实测场景 A）的风险。
 */

/** 停泊时对后续所有工具调用给出的稳定理由码。 */
export const RUN_PARKED_REASON_CODE = 'RUN_PARKED_AWAITING_APPROVAL';

export interface ParkRecord {
  /** 触发停泊的那次调用。续跑时按它重放。 */
  readonly callId: string;
  readonly toolName: string;
  /** 审批记录 id，供 executor 投影 Run 状态与审批中心查询。 */
  readonly approvalId: string;
}

/**
 * 一个 Run 的停泊闸门。**每 Run 一个实例**——装在根 ctx 上会让所有 Run 共用一个
 * 闸门，一个 Run 停泊会把别的 Run 也锁死。
 */
export class RunPark {
  private record: ParkRecord | null = null;

  /** 已经停泊了吗。 */
  get parked(): boolean {
    return this.record !== null;
  }

  /** 停泊详情；未停泊时为 null。executor 用它决定投影哪条 Run 状态。 */
  get pending(): ParkRecord | null {
    return this.record;
  }

  /**
   * 停泊本 Run。**幂等**：一个 turn 里可能有多个并发工具调用同时撞到审批，
   * 第一个赢，后面的都只是被 guard 拒掉，不覆盖 `record`——否则续跑时重放的
   * 就不是当初真正问人的那一次。
   */
  arm(record: ParkRecord): void {
    if (this.record === null) this.record = record;
  }

  /**
   * 给一次工具调用的判定：停泊后一律拒。
   *
   * **触发停泊的那次调用本身不在这里被拒**——它已经在 `tools/pre-execute` 里
   * 拿到了 `ask`，走的是审批 seam 那条路。这里挡的是它之后的每一次。
   */
  denyReason(callId: string): string | undefined {
    if (this.record === null) return undefined;
    if (this.record.callId === callId) return undefined;
    return (
      `${RUN_PARKED_REASON_CODE}: this run is parked awaiting human approval of ` +
      `${this.record.toolName} (approval ${this.record.approvalId}). ` +
      `No further tools can run in this turn; stop and summarize what you were doing.`
    );
  }

  /** 续跑时由 executor 清空——重建会话后是新的一轮。 */
  clear(): void {
    this.record = null;
  }
}
