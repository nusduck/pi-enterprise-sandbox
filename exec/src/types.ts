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
  /**
   * 用户侧 Skill 的**草稿根**（ADR 0009 D7）：每用户一个持久目录，可写。
   *
   * 模型用 `write` / `bash` 在这里造包——和它在 workspace 里干活是同一组工具、
   * 同一套围栏。**不进发现、不进 system prompt**：进了就等于没有闸门。
   *
   * 省略表示这个部署还没开草稿面；那时它既不可写也不挂载。
   */
  readonly draftSkillRoot?: string;
  /** 该用户已启用的 Skill 包，逐包绑定（ADR 0008 D4）。 */
  readonly enabledSkillPackages: readonly EnabledSkillPackage[];
  /**
   * 本 Run 选中的**系统层**包（ADR 0015 D4），逐包绑定。
   *
   * 三种取值语义不同，不能混用：
   * - 数组（含空数组）：内部面请求带了 `systemSkills` 名单——只挂、只放行名单里的包，
   *   系统根本身既不挂载也不可经 fs RPC 寻址；`[]` 即一个系统包都不带；
   * - 省略：请求没带名单。这是滚动升级兼容期的旧 Agent（design §8），也是公共面、
   *   MCP 窄桥与启动探针的形状——维持 ADR 0015 之前的整树只读挂载。
   *   收紧（design §8）之后内部面不再出现省略。
   */
  readonly systemSkillPackages?: readonly EnabledSkillPackage[];
  /**
   * 本 org 的 org 层包（ADR 0015 D5），逐包绑定到 `/home/sandbox/skill-org/<name>`。
   * 省略 = 这个 Run 没有 org 层。
   */
  readonly orgSkillPackages?: readonly EnabledSkillPackage[];
  /**
   * 本次执行打开的数据源（design `sandbox-data-sources.md`）。省略即没有：公共面与
   * MCP 窄桥从不携带。挂载与环境变量由隔离层统一注入，每条 spawn 路径都一样。
   */
  readonly dataSources?: readonly DataSourceMount[];
}

/** 一个数据源在一次执行里的挂载。`secret` 只用于输出脱敏，不进任何日志。 */
export interface DataSourceMount {
  readonly id: string;
  /** 物理 socket 目录，只读绑定到 `/run/dsh-db/<id>`。 */
  readonly hostDir: string;
  /** 注入子进程的 `DSH_DB_<ID>_*`。 */
  readonly env: Readonly<Record<string, string>>;
  readonly secret: string;
}

export interface EnabledSkillPackage {
  readonly name: string;
  /** 物理源目录。 */
  readonly sourcePath: string;
  /**
   * 这一包挂到哪个逻辑根（ADR 0015 D5）。缺省 `user`。
   *
   * 挂载目标与 fs 围栏的「逻辑路径 → 物理根」都必须按它选根：org 层挂到
   * `/home/sandbox/skill-org/<name>`，不能和用户层混在同一个前缀下——否则
   * 审计分不出来源，模型也会按错的路径去 `read` 资源文件。
   */
  readonly kind?: 'user' | 'org' | 'system';
}

/**
 * 按 owner 与请求携带的启用清单解析要挂载的包（design §3.3 S1）。
 * 清单缺省即空：公共面与 MCP 窄桥不带清单，因此不挂任何用户包。
 */
export type EnabledSkillPackagesResolver = (
  orgId: string,
  userId: string,
  manifest?: readonly { readonly name: string; readonly contentDigest: string }[],
) => readonly EnabledSkillPackage[];

/**
 * 按请求携带的 `systemSkills`（ADR 0015 D4）解析要逐包挂载的系统包。
 *
 * 系统包**没有摘要与侧车**：源是 release 目录里的 `<systemRoot>/<name>`，只按名
 * 核对。`names` 为空数组是合法输入——那时返回空数组，系统根一个包都不挂。
 * 「请求没带这个字段」由调用方处理（兼容期整树挂载），不会传到这里。
 */
export type SystemSkillPackagesResolver = (
  names: readonly string[],
) => readonly EnabledSkillPackage[];

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
