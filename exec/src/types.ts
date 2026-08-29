/**
 * 执行面的共享基础类型。
 *
 * 这个文件由主控维护，W1-B（fs）与 W1-C（isolation）都依赖它。
 * 两侧都不要修改它的签名——需要改先提出来。
 */

/** 一次执行请求绑定的租户与工作区身份。物理路径只存在于这一层，绝不外泄。 */
export interface WorkspaceContext {
  readonly orgId: string;
  readonly userId: string;
  /** 对外唯一暴露的不透明标识；同时是多实例路由的预留键（ADR 0008 D5）。 */
  readonly workspaceId: string;
  /** 物理工作区根。绝不进入 API、SSE、模型上下文或错误文本。 */
  readonly workspaceRoot: string;
  /** 会话私有、跨 Run 持久的 temp 根（ADR 0004）。 */
  readonly tempRoot: string;
  /** 只读的系统 Skill 根。 */
  readonly systemSkillRoot: string;
  /** 该用户已启用的 Skill 包，逐包绑定（ADR 0008 D4）。 */
  readonly enabledSkillPackages: readonly EnabledSkillPackage[];
}

export interface EnabledSkillPackage {
  readonly name: string;
  /** 物理源目录。 */
  readonly sourcePath: string;
}

/**
 * 沙箱模式词汇，采用 DSH 的命名（ADR 0008 D3）。文件效果，不含网络。
 *
 * **故意不含 DSH 的 `danger-full-access`。** 那个模式在 DSH 里成立，因为它是
 * 单用户本机场景；我们是多租户，"完全放开"本来就不该存在。留一个语义未定的
 * 模式，早晚有人以为它能用——决策所有者 2026-08-29 拍板删除。
 *
 * 真正的安全边界是 Bubblewrap（ADR 0007 D11），不是这层围栏。
 */
export type SandboxMode = 'read-only' | 'workspace-write';
