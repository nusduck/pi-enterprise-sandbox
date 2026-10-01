/**
 * Run 启动前的沙箱会话确保。
 *
 * 从 `dsh-run-executor.ts` 拆出：那个文件在行数棘轮上有预算（AGENTS.md §4），
 * 而「组装 ensure 入参 → 把**绑定版本**的交付策略传下去 → 把失败收敛成一句可
 * 记录的 statusReason」本来就是一件事。
 *
 * 交付策略那一路见 design `agent-output-review.md` §3.1 / ADR 0016 D3：审核策略
 * 随 AgentVersion 固定，exec 侧是 `INSERT IGNORE`（只能设置、不能撤销），所以
 * 这一发必须带着绑定版本的模式，不能读「当前活跃版本」，也不能猜。
 */

export interface RunSandboxEnsureInput {
  /** 不配置时（单测/本地）整体跳过，与调用方原来的 `if (this.x)` 同义。 */
  readonly provisioner: { ensure: (input: Record<string, unknown>) => Promise<unknown> } | null | undefined;
  readonly scope: { readonly orgId: string; readonly userId: string };
  readonly conversationId: string;
  readonly agentSessionId: string;
  readonly sandboxSessionId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly fenceToken: number;
  readonly traceId: string;
  readonly traceState?: string | null | undefined;
  /** 绑定版本的交付模式（`direct` | `review`）。 */
  readonly deliveryMode: string;
  readonly sanitizeStatusReason: (error: unknown) => string | null;
}

/**
 * @returns `null` = 成功；字符串 = 失败原因（调用方把 Run 判成 FAILED）。
 */
export async function ensureRunSandboxSession(
  input: RunSandboxEnsureInput,
): Promise<string | null> {
  if (!input.provisioner) return null;
  try {
    await input.provisioner.ensure({
      orgId: input.scope.orgId,
      userId: input.scope.userId,
      conversationId: input.conversationId,
      agentSessionId: input.agentSessionId,
      sandboxSessionId: input.sandboxSessionId,
      runId: input.runId,
      workspaceId: input.workspaceId,
      executionFenceToken: input.fenceToken,
      traceId: input.traceId,
      ...(input.traceState ? { traceState: input.traceState } : {}),
      ...(input.deliveryMode === 'review' ? { delivery: 'review' } : {}),
    });
    return null;
  } catch (error) {
    return (
      input.sanitizeStatusReason(error) ?? 'sandbox session provisioning failed'
    );
  }
}
