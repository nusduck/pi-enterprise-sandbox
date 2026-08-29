/**
 * 作业（长进程）登记的共享词汇表。
 *
 * 这是什么：`MySqlJobRegistry`（见 `job-registry.ts`）以及它拆分出的同目录
 * 文件共用的类型定义——记录形状、持久化接口 `JobStore`、生产者要实现的
 * `JobProcessHandle`。本文件不含任何逻辑，只有类型和纯常量。
 *
 * 为什么不直接 `import` `@deepseek-ai/dsh-jobs` 的 `JobRegistry`：
 * 那个契约的 `owner` 是活的 cordis `Agent` 对象，`start()` 的准入、完成通知、
 * teardown 全部挂在 Agent 的 scope 生命周期上（见其 README："The contract is
 * in-process — JobStart.run() passes callbacks and exact Agent objects; a
 * durable or cross-process backend must reshape identity, restart, ownership,
 * and observation semantics before it can implement this seam"）。`exec/` 是
 * 无状态的执行面，一次 HTTP 请求只有 `{orgId, userId, workspaceId}` 这样的
 * 平面租户身份，没有 Agent。所以这里**保留 dsh-jobs 的词汇形状**（状态机、
 * 只读快照、增量读、owner 隔离、first-wins 结算）但把 `owner: Agent` 换成
 * `owner: JobOwner`，把 cordis scope 换成显式的 `recoverOrphans()` 生命周期
 * 钩子——这正是 ADR 0008 D7 说的"实现 dsh-jobs 的登记契约，但记录落 MySQL"。
 *
 * `JobStore` 是持久化的窄接口（W3-D 会接手，见任务交付说明）：本文件之外只有
 * `job-store-memory.ts`（测试用）与 `job-store-mysql.ts`（生产用）两个实现，
 * `job-registry.ts` 只认这个接口，不知道底下是内存表还是 MySQL。
 */

// ── 状态机 ──────────────────────────────────────────────────────────────

/**
 * 作业生命周期状态。故意直接采用 `@deepseek-ai/dsh-jobs` 的 `JobStatus`
 * 五态词汇（`running` / `stopping` / `completed` / `killed` / `failed`），
 * 不照抄 Python 版 `ProcessStatus` 的十态机——那十态里 `created` /
 * `waiting_input` 是内部实现细节（分别对应"已登记未 spawn""stdin 提示"），
 * 折进 `running` 就够用；`cancel_requested` 就是 `stopping`；
 * `cancelled` / `timeout` / `orphaned` / `lost` 这四个终态在 Python 里各自
 * 触发不同的信号升级路径，但对外呈现的都是"被杀掉"，统一成 `killed`，
 * 用 {@link JobRecord.detail} 里的一句话区分具体原因（`"timeout"` /
 * `"orphaned: worker restarted"` / `"killed: SIGTERM"` 等）。
 *
 * 这样 `job-registry.ts` 的公开快照形状和上游 `JobSnapshot.status` 逐字段
 * 对应，将来要接一个真正的 `ctx.jobs` 适配层（如果 D7 的决定将来被推翻）
 * 不需要重新设计状态机。
 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed';

/** 终态集合——移植自 Python 版 `PROCESS_TERMINAL_STATUSES`（去掉细分）。 */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'completed',
  'killed',
  'failed',
]);

export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

// ── 归属 ────────────────────────────────────────────────────────────────

/**
 * 一次调用携带的租户身份，来自 `contract/` 的 `RpcEnvelope`
 * （`{requestId, workspaceId, orgId, userId, fenceToken}`）。
 *
 * 故意不含 `sandboxSessionId`——那是 Agent 侧（`runtime/`）的会话概念，
 * `exec/` 内部契约的信封只到 `workspaceId` 这一层（见
 * `contract/src/envelope.ts`）。`workspaceId` 与 Python 版的
 * `sandbox_session_id` 是同一层级的东西（`sandbox_sessions` 表上
 * `workspace_id` 是 1:1 唯一约束），归属校验用它完全等价。
 */
export interface JobOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  /** 可选：绑定的 Run，供批量撤销（"这次 Run 下所有作业"）使用。 */
  readonly runId?: string | undefined;
}

/**
 * 两个 owner 是否是同一租户/工作区——归属校验的唯一判据。
 * 故意不比较 `runId`：一次 Run 下可以起多个作业，`runId` 只用于批量筛选，
 * 不参与"这是不是你的作业"判断（对齐 Python 版 `get_owned` 只比较
 * org/user/session 三元组，不比较 run_id）。
 */
export function sameOwner(a: JobOwner, b: JobOwner): boolean {
  return a.orgId === b.orgId && a.userId === b.userId && a.workspaceId === b.workspaceId;
}

// ── 生产者接口：executor.ts 要实现的那一半 ─────────────────────────────

/** 一次进程结束时的终态结果，由生产者在 `done` 落定时给出。 */
export interface JobProcessOutcome {
  readonly status: 'completed' | 'killed' | 'failed';
  /** 退出码；被信号杀死或从未启动成功时为 null。 */
  readonly exitCode: number | null;
  /** 杀死进程的信号名，正常退出或非信号终止时为 null。 */
  readonly signal: NodeJS.Signals | null;
  /** 一行状态细节，进最终快照的 `detail`（"exit code: 3"、"max-tokens" 之类）。 */
  readonly detail?: string | undefined;
}

/**
 * 一次增量输出读取。形状逐字段对应上游 `ShellProcessRead`
 * （见 `@deepseek-ai/dsh-shell` 的 `types.ts`）——这是 ADR 0008 D7 明确点名
 * "运气好、别改坏"的那个模型。
 *
 * `stdoutSpillPath`/`stderrSpillPath` 在这里是**生产者内部字段**：
 * `JobProcessHandle.readOutput()` 允许把物理文件路径放在这里，但
 * `job-registry.ts` 的公开 API（{@link JobRead}）不会把物理路径原样透传
 * 出去——那会违反"错误/返回文本里物理根一律脱敏"这条硬约束（对齐
 * `WorkspaceFileSystem.resolve()` 把 `displayPath` 从物理路径换成逻辑路径
 * 的同一条纪律，见 `exec/src/fs/workspace-fs.ts`）。registry 把它换成一个
 * 不透明的 spill 引用字符串，真正的物理路径只能通过
 * `MySqlJobRegistry.resolveSpillPath()`（owner 校验过的内部方法）换回来，
 * 供内部下载端点使用。
 */
export interface JobProcessChunk {
  readonly delta: string;
  readonly lossy: boolean;
  readonly stdoutSpillPath?: string | undefined;
  readonly stderrSpillPath?: string | undefined;
}

/**
 * 一次已经在跑的进程句柄，由 `run()` 同步返回。这是本包与实际 spawn
 * 机制（bwrap / child_process，属于 W2-A 的 `executor.ts`）之间的适配边界：
 * `job-registry.ts` 只认这个接口，不知道进程是怎么起的。
 *
 * 形状比上游 `ShellProcess` 宽——上游明确"没有交互式输入的词汇"
 * （`stdin` 只能在 spawn 时写一次），但设计文档§5.5 要求的交付物包含
 * "stdin 写入"，所以这里加了 `writeStdin`，标成可选：不支持持续写入的
 * 生产者（比如未来接一个真正的 `ShellProcess` 适配层）可以不实现它，
 * `job-registry.ts` 遇到未实现时返回明确的"不可用"结果，不是抛异常。
 */
export interface JobProcessHandle {
  readonly pid: number;
  readonly pgid?: number | undefined;
  /**
   * 请求终止。必须同步、幂等；最终必须让 {@link done} 落定
   * （对齐上游 `JobHooks.cancel` 的约定）。
   */
  cancel(reason?: string): void;
  /** 进程释放资源后 resolve；不会 reject（生产者把异常吞成 failed）。 */
  readonly done: Promise<JobProcessOutcome>;
  /** 增量读取；省略等于"只有最终输出"的作业。 */
  readOutput?(): JobProcessChunk;
  /** 写入 stdin；不支持时抛错，`job-registry.ts` 会捕获并转成失败结果。 */
  writeStdin?(data: string, eof: boolean): void;
}

/** `MySqlJobRegistry.start()` 的入参。 */
export interface JobStartSpec {
  /** 生产者种类，也是 id 前缀，目前只有 `bash`（对齐 `JobKind`）。 */
  readonly kind: 'bash';
  /** 一行模型可见标签（通常就是命令本身）。 */
  readonly label: string;
  readonly owner: JobOwner;
  /** 完成通知/输出读取的可选字节上限，原样透传进快照。 */
  readonly outputLimitBytes?: number | undefined;
  /**
   * 本次调用实际会用到的物理根（工作区根、会话私有 temp 根等）。
   * **必填，不给默认值**——理由与 `contract/src/errors.ts` 的
   * `ToWireErrorOptions.physicalRoots` 完全一致：忘了传要在编译期报错，
   * 不能在运行时悄悄放行、什么都不脱敏。没有额外根就显式传 `[]`。
   */
  readonly physicalRoots: readonly string[];
  /** 启动并同步返回句柄；只调用一次，抛出时不留下任何登记记录。 */
  run(): JobProcessHandle;
}

// ── 只读快照 ────────────────────────────────────────────────────────────

/** 安全交给调用方的只读投影——每次调用现算，绝不是活的注册表状态。 */
export interface JobSnapshot {
  readonly id: string;
  readonly kind: 'bash';
  readonly label: string;
  readonly outputLimitBytes?: number | undefined;
  readonly ownerWorkspaceId: string;
  readonly status: JobStatus;
  readonly detail?: string | undefined;
  /** 登记时刻（epoch ms）。 */
  readonly startedAt: number;
  /** 结算时刻（epoch ms）；仍在跑时缺省。 */
  readonly finishedAt?: number | undefined;
  readonly exitCode: number | null;
  readonly pid: number | null;
  /** 终态是否已经被某次 kill/read/wait/orphan-recovery 报告过。 */
  readonly reported: boolean;
}

/** 一次 {@link MySqlJobRegistry.read} 的返回。 */
export interface JobRead {
  /** 自上次读取以来的增量文本（stderr 按上游约定标记在其中）。 */
  readonly text: string;
  /** 本次读取是否因为环形缓冲区回收而丢失了数据。 */
  readonly lossy: boolean;
  /** 不透明 spill 引用；真正路径经 `resolveSpillPath()` 换取。 */
  readonly stdoutSpillRef?: string | undefined;
  readonly stderrSpillRef?: string | undefined;
  readonly snapshot: JobSnapshot;
}

// ── 持久化：JobStore ─────────────────────────────────────────────────────

/**
 * 落 MySQL 的那一行的完整字段。命名对齐现有 `process_executions` 表
 * （见 `agent/src/infrastructure/mysql/migrations/20260718000001_core_platform_schema.js`），
 * 新增字段在各自注释里标出——这些是要请 W3-D 加列的部分。
 */
export interface JobRecord {
  readonly id: string;
  readonly kind: 'bash';
  readonly label: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly status: JobStatus;
  readonly detail: string | null;
  readonly outputLimitBytes: number | null;
  /** OS 进程号；登记但尚未 spawn 成功时为 null。 */
  readonly pid: number | null;
  /**
   * 进程组号（setsid 之后的组长 pid）。**新列**——现有表没有，
   * 只在 `command_json` 里以 JSON 塞过，孤儿回收要精确按组信号必须是
   * 一等列，不能每次都反序列化整个 JSON blob。
   */
  readonly pgid: number | null;
  /**
   * 可重新验证的进程启动身份（`linux-starttime:<jiffies>` /
   * `ps-v1:lstart=...|pgid=...|ppid=...`，见 `job-identity.ts`）。**新列**，
   * 同上，理由一样：孤儿回收路径每次重启都要读，不能反序列化 JSON。
   */
  readonly startIdentity: string | null;
  readonly exitCode: number | null;
  /** 终态是否已上报——首个结算写一次，之后的读/等待不再重复触发通知。 */
  readonly reported: boolean;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

/** 插入一行新记录的输入——`status` 固定从 `'running'` 起步。 */
export interface JobRecordInsert {
  readonly id: string;
  readonly kind: 'bash';
  readonly label: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly outputLimitBytes: number | null;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly startIdentity: string | null;
  readonly createdAt: Date;
}

/** `updateStatus` 的补丁——只写传入的字段，其余保持原值（对齐现有仓储的 `COALESCE` 语义）。 */
export interface JobRecordStatusPatch {
  readonly status: JobStatus;
  readonly detail?: string | null | undefined;
  readonly pid?: number | null | undefined;
  readonly pgid?: number | null | undefined;
  readonly startIdentity?: string | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly reported?: boolean | undefined;
  readonly startedAt?: Date | null | undefined;
  readonly finishedAt?: Date | null | undefined;
}

/** owner-scoped 查询用的三元组（信封身份，不含 runId）。 */
export interface JobOwnerScope {
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceId: string;
}

/**
 * 持久化的窄接口——ADR 0008 §5.5 / D7 要求"收在一个窄接口后面"，W3-D
 * 接手正式仓储层时只需要换 `job-store-mysql.ts` 的实现，不动
 * `job-registry.ts` 里的业务逻辑。
 *
 * 每个方法都是 owner-scoped（除了 `listActiveForRecovery`，那是启动期
 * 的系统级操作，等价于 Python 版 `list_active_for_recovery` 的"未挂路由
 * 前的信任操作"）。"不是你的"和"不存在"必须是同一个答案——
 * `getById` 返回 `null`，不区分这两种情况，调用方（`job-owner-access.ts`）
 * 不应该、也没有能力区分。
 */
export interface JobStore {
  insert(record: JobRecordInsert): Promise<void>;
  updateStatus(id: string, owner: JobOwnerScope, patch: JobRecordStatusPatch): Promise<void>;
  getById(id: string, owner: JobOwnerScope): Promise<JobRecord | null>;
  listByOwner(owner: JobOwnerScope, limit?: number): Promise<JobRecord[]>;
  listByRun(runId: string, owner: JobOwnerScope, limit?: number): Promise<JobRecord[]>;
  /**
   * 精确 owner 当前处于 `running`/`stopping` 的作业数——`start()` 的准入
   * 检查用（对齐 `dsh-jobs-local` 的 `maxConcurrentJobsPerOwner`：只数
   * `running` + `stopping`，终态不占名额）。独立于 `listByOwner` 是为了
   * 让 MySQL 实现走 `COUNT(*)`，不必把整页记录都拉回来数。
   */
  countActiveForOwner(owner: JobOwnerScope): Promise<number>;
  /**
   * 系统级、无租户过滤——只在服务启动、用户路由挂载之前调用
   * （对齐 Python 版注释："This is deliberately an unscoped system
   * operation. It is only called during Sandbox startup before user
   * routes are admitted."）。
   */
  listActiveForRecovery(limit?: number): Promise<JobRecord[]>;
}
