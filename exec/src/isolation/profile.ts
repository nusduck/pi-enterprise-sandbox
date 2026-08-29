/**
 * 隔离层的数据模型（ADR 0008 D3）。
 *
 * 背景：今天 Python 版 `sandbox/isolation/bubblewrap.py` 的 `prepare()` 是一段
 * 130 行的线性 argv 拼接，把命名空间、挂载、环境变量、启动命令八件事揉在一起写。
 * 后果有两个：
 *
 * 1. 测试只能对最终 argv 做字符串匹配（"某个 flag 在不在数组里"），没法断言
 *    "可写挂载恰好是这些根、不多不少"这种结构性质。
 * 2. `preflight()` 手抄了 `prepare()` 的一个子集，两份列表会静默分叉——今天
 *    `preflight` 就已经漏了 `/run`、`/var`、`/etc`、`/app`、`/sbin` 等好几项
 *    （见 `exec/src/isolation/preflight.ts` 顶部注释里列出的具体差异）。
 *
 * 这个文件只定义**数据**：一次 Bubblewrap 启动需要哪些命名空间、挂载哪些路径、
 * 设置哪些环境变量、跑什么命令。它本身不产生任何 bwrap 参数——那是
 * `render.ts` 唯一的工作——也不做任何文件系统访问——那是 `bubblewrap.ts`
 * （runner）的工作。`IsolationProfile` 只是一份可以被完整序列化、完整比较、
 * 完整断言的计划书。
 */

/** Bubblewrap 要 unshare 的命名空间维度。今天 user/pid/ipc/uts 恒定存在，net 取决于网络模式。 */
export type Namespace = 'user' | 'pid' | 'ipc' | 'uts' | 'net';

/** 网络模式（与 `types.ts` 的 `SandboxMode` 是两个轴：那个只管文件效果，这个只管网络）。 */
export type NetworkMode = 'disabled' | 'allowlist' | 'unrestricted';

/**
 * 命名空间与进程身份计划。
 *
 * 对应今天 `prepare()` 里 `--unshare-*`、`--uid`/`--gid`、`--as-pid-1`、
 * `--die-with-parent`、`--new-session`、`--cap-drop ALL` 那一段。
 */
export interface NamespacePlan {
  /** 要 unshare 的命名空间集合。 */
  readonly namespaces: readonly Namespace[];
  readonly uid: number;
  readonly gid: number;
  /**
   * 命令是否作为新 PID 命名空间的 init（PID 1）。
   * 只有 Durable Process Handle 用 true——这样服务重启后杀掉 init，
   * 内核会连带清理这个私有 PID 命名空间里剩下的全部后代进程。
   */
  readonly asPid1: boolean;
  /**
   * 是否跟随发起方进程存活。普通工具调用为 true（请求取消后子进程不能变孤儿）；
   * Durable Process Handle 为 false（服务重启不能顺带杀死它）。
   */
  readonly dieWithParent: boolean;
  readonly newSession: boolean;
  /**
   * 今天只支持整体 drop 全部能力（`--cap-drop ALL`）。留字面量类型而不是
   * `string[]`，是为了不为一个还不存在的需求（细粒度 drop）预先做无意义的抽象。
   */
  readonly capDrop: 'ALL';
}

/** bwrap 挂载的种类，与 bwrap 的 flag 一一对应。 */
export type MountKind = 'ro_bind' | 'bind' | 'dir' | 'proc' | 'dev' | 'tmpfs';

interface MountCommon {
  readonly target: string;
  /**
   * 这条挂载的源/目标是否绑定某个具体会话（workspace 根、session 私有 temp、
   * 该会话下的 XDG home 子目录、某个用户已启用的 skill 包）。
   *
   * `preflight.ts` 用这个字段筛掉会话特定挂载——探针没有真实会话，这些挂载的
   * 源路径不存在是预期状态，不是故障，不该出现在"bwrap 本身还能不能跑"的检查里。
   */
  readonly sessionSpecific: boolean;
}

/**
 * 有源路径的挂载（ro_bind / bind）。
 *
 * `required` 的语义就是今天靠注释解释、极易错记的那条规则，现在进了类型：
 *
 * - `required: true`  → 源缺失（或任何 stat 失败）即整个启动失败，对应今天的
 *   `--ro-bind` / `--bind`。
 * - `required: false` → **只**宽恕 ENOENT，其它错误（最常见是 EACCES：目录存在
 *   但不可遍历）一样致命，对应今天的 `--ro-bind-try` / `--bind-try`。这条是
 *   `sandbox/isolation/bubblewrap.py:163-179` 里专门为用户 skill 目录写的一段
 *   探测逻辑想说清楚的事——bwrap 的 `-try` 变体只吃 ENOENT，一个"目录存在但读不了"
 *   的坏挂载如果原样传给 bwrap，会带着 bash、python、甚至 `pwd` 一起死。
 *   `exec/src/isolation/bubblewrap.ts` 的 `resolveEffectiveMounts()` 把这条
 *   规则从"仅用户 skill 目录"泛化成了"所有 required=false 的挂载"，见该文件注释。
 */
export interface BindMount extends MountCommon {
  readonly kind: 'ro_bind' | 'bind';
  readonly source: string;
  readonly required: boolean;
  /**
   * 仅对 `required: true` 的挂载有意义：源目录不存在时创建它，而不是失败。
   * 今天只有 XDG home 三个子目录用到这条（ADR 0004）——它们第一次使用时
   * 本来就不存在，`--bind` 需要一个真实存在的源，`--bind-try` 又会静默退回
   * 到每次都重建的空 tmpfs（那正是 ADR 0004 要修的问题），所以选择是"先建后绑"。
   */
  readonly ensureDir?: boolean;
}

/** 没有源路径的挂载：bwrap 在新命名空间内部直接创建，不存在"缺失"这回事。 */
export interface StructuralMount extends MountCommon {
  readonly kind: 'dir' | 'proc' | 'dev' | 'tmpfs';
}

export type Mount = BindMount | StructuralMount;

/** 有序挂载列表。顺序在语义上不敏感（bwrap 对这些 flag 的相对顺序没有要求），
 * 但保持"静态 → skill → 会话特定"的分组顺序方便阅读与断言。 */
export type MountPlan = readonly Mount[];

/** 环境变量计划：先 clearenv，再逐个 setenv。 */
export interface EnvPlan {
  readonly clearEnv: boolean;
  readonly vars: Readonly<Record<string, string>>;
}

/** 启动命令计划。 */
export interface LaunchPlan {
  /** 未净化的目标命令，例如 `["bash", "-c", "pwd"]`。 */
  readonly argv: readonly string[];
  /**
   * bwrap 内部的 `--chdir` 目标（沙箱视角的逻辑路径，例如
   * `/home/sandbox/workspace` 或 `/tmp/service`）。省略时不下发 `--chdir`
   * （今天的 `preflight()` 就是这样——它没有会话，没有合法的 cwd 可给）。
   */
  readonly cwd?: string;
  /**
   * >0 时，命令会被包进一层在命名空间**内部**执行的 bash 包装器，先
   * `ulimit -u` 收紧进程数上限再 exec 真正的命令。必须在命名空间内部做——
   * 在 bwrap 创建用户命名空间之前设置全局 RLIMIT_NPROC，计的是共享该 UID 的
   * 全部无关进程，可能直接让命名空间建不起来（这条是今天 Python 版模块顶部
   * 文档字符串专门强调的事）。
   */
  readonly maxProcessCount: number;
}

/** 一次 Bubblewrap 启动的完整计划。 */
export interface IsolationProfile {
  readonly namespace: NamespacePlan;
  readonly mounts: MountPlan;
  readonly env: EnvPlan;
  readonly launch: LaunchPlan;
}

/** Profile 数据本身不合法（例如非法环境变量名、cwd 越界）时抛出。
 * 对应今天 Python 版在 `prepare()` 里直接抛的 `ValueError`。 */
export class IsolationConfigError extends Error {
  override readonly name = 'IsolationConfigError';
}

// ── 沙箱内固定的逻辑路径常量 ─────────────────────────────────────────
// 与 `sandbox/paths.py` 的同名常量一一对应，是 Agent 提示词里 <location> 依赖
// 的稳定路径；改这些字符串等于改变模型看到的世界，不要顺手改。

export const AGENT_SKILL_PATH = '/home/sandbox/skill';
export const AGENT_USER_SKILL_PATH = '/home/sandbox/skill-user';
export const AGENT_WORKSPACE_PATH = '/home/sandbox/workspace';
export const AGENT_TEMP_PATH = '/tmp';
