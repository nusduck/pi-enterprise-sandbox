/**
 * Preflight：渲染与 `prepare` **同一个** profile（ADR 0008 D2 / D3，验证要求 2）。
 *
 * 今天 Python 版 `preflight()`（`sandbox/isolation/bubblewrap.py:333-402`）是
 * 手抄的另一份 argv 拼接，跟 `prepare()` 各写各的。逐项核对下来，它已经悄悄
 * 漏了这些东西（不是猜测——是逐行比对两个函数数出来的）：
 *
 * - `--dir` 只有 `/home`、`/home/sandbox` 两条，`prepare()` 其实有七条
 *   （另外五条：`/run`、`/var`、`/var/tmp`、`/etc`、`/app`——ADR 0008 D2 点名的那句
 *   "今天 preflight 没有 /run、/var、/etc、/app" 说的就是这个）
 * - 静态只读 runtime 挂载只有 `/usr /bin /lib /lib64 /usr/local` 五条，缺了
 *   `/sbin`（`prepare()` 是六条）
 * - 完全没有 `--ro-bind-try /app/.venv`
 * - 完全没有 `/etc/passwd`、`/etc/group` 等九条 `/etc/*` 文件绑定
 *
 * 这些遗漏的共同后果是：preflight 通过，不代表 `prepare()` 实际要用的挂载
 * 都能成立——服务启动时"看起来健康"，第一次真正跑工具才发现某条挂载有问题。
 *
 * 这个文件不再手抄任何列表。它只做一件事：拿一个用 `build.ts` 构造出来的
 * **真实** `IsolationProfile`，做一次纯数据变换——
 *
 * 1. 丢弃 `sessionSpecific: true` 的挂载（workspace、session temp、XDG home、
 *    per-package skill——探针没有真实会话，这些源路径不存在是预期状态）
 * 2. 换成探针命令（`/usr/bin/true`），不设 `--chdir`（没有合法的会话内路径可给）
 * 3. 环境变量换成最小集合
 * 4. 强制 `--unshare-net`（fail-closed 探针，不跟随任何调用方的网络模式选择）
 *
 * 静态部分（命名空间策略、`/proc` `/dev`、七条 `--dir`、六条 runtime ro-bind、
 * `.venv`、九条 `/etc/*`、系统 skill 树）**逐字来自同一次 `buildIsolationProfile()`
 * 调用**——不是重新列一遍，分叉因此在构造层面就不可能发生。
 */
import type { SandboxMode, WorkspaceContext } from '../types.js';
import { buildIsolationProfile, type WritableRootsFn } from './build.js';
import type { IsolationProfile, Namespace } from './profile.js';

const PREFLIGHT_ARGV: readonly string[] = ['/usr/bin/true'];

/** 探针的环境变量：与今天 Python 版 `preflight()` 一致，只有 `PATH` 与 `HOME`——
 * 探针不代表任何会话，没有 XDG/PWD 这些依赖会话身份的值可给。 */
const PREFLIGHT_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/sandbox',
};

function withNetForced(namespaces: readonly Namespace[]): readonly Namespace[] {
  return namespaces.includes('net') ? namespaces : [...namespaces, 'net'];
}

/**
 * 纯变换：把一个已经构造好的 `IsolationProfile` 转成探针用的版本。
 *
 * 这是本文件的核心断言点——测试对着任意一个 `buildIsolationProfile()` 的
 * 产出调用这个函数，验证结果的静态挂载与命名空间策略跟原 profile **完全一致**，
 * 差异只在 `LaunchPlan`、`EnvPlan` 与 `sessionSpecific` 挂载的取舍上。
 */
export function toPreflightProfile(profile: IsolationProfile): IsolationProfile {
  return {
    namespace: {
      ...profile.namespace,
      namespaces: withNetForced(profile.namespace.namespaces),
      // 探针必须是自包含、无害、fail-safe 的：不跟随调用方对某次具体启动的
      // 选择（例如 Durable Process Handle 会把 dieWithParent 设成 false、
      // asPid1 设成 true——那是那一条命令的属性，不是"bwrap 本身好不好用"
      // 这个问题的属性）。
      dieWithParent: true,
      asPid1: false,
      newSession: true,
    },
    mounts: profile.mounts.filter((mount) => !mount.sessionSpecific),
    env: {
      clearEnv: true,
      vars: PREFLIGHT_ENV,
    },
    launch: {
      argv: PREFLIGHT_ARGV,
      // 不下发 --chdir：探针没有会话，没有合法的沙箱内路径。
      maxProcessCount: 0,
    },
  };
}

export interface PreflightProfileInput {
  readonly systemSkillRoot: string;
  readonly uid?: number;
  readonly gid?: number;
  /**
   * 仅供不想依赖真实 `writableRoots()` 实现的调用方使用（例如它还没实现完，
   * 或者调用方就是想避免为一个反正会被过滤掉的挂载去解析可写根）。
   * 默认使用真正的 `writableRoots()`。
   */
  readonly writableRootsFn?: WritableRootsFn;
}

/**
 * 合成一个不依赖任何真实会话的探针 `WorkspaceContext`，构造出对应 profile，
 * 再套用 `toPreflightProfile()`。
 *
 * `workspaceRoot`/`tempRoot` 用明显是占位符的路径——`toPreflightProfile()`
 * 会把引用它们的挂载全部过滤掉，这两个值本身永远不会出现在最终探针 argv 里，
 * 也永远不会被拿去做真实的文件系统访问（`build.ts` 是纯函数）。
 */
export function buildPreflightProfile(input: PreflightProfileInput): IsolationProfile {
  const probeContext: WorkspaceContext = {
    orgId: '__preflight__',
    userId: '__preflight__',
    workspaceId: '__preflight__',
    workspaceRoot: '/nonexistent/preflight/workspace',
    tempRoot: '/nonexistent/preflight/temp',
    systemSkillRoot: input.systemSkillRoot,
    enabledSkillPackages: [],
  };
  const mode: SandboxMode = 'workspace-write'; // 无关紧要：这两个根的挂载会被过滤掉。
  const full = buildIsolationProfile({
    context: probeContext,
    mode,
    command: PREFLIGHT_ARGV,
    ...(input.uid !== undefined ? { uid: input.uid } : {}),
    ...(input.gid !== undefined ? { gid: input.gid } : {}),
    ...(input.writableRootsFn !== undefined ? { writableRootsFn: input.writableRootsFn } : {}),
  });
  return toPreflightProfile(full);
}
