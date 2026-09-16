/**
 * 把 `IsolationProfile` 变成 bwrap 命令行参数——仓库里唯一允许拼 bwrap 参数
 * 的地方（ADR 0008 D3）。
 *
 * `render()` 是纯函数：只读 `profile`，不碰文件系统、不检查任何路径是否真的
 * 存在、不判断 bwrap 在不在。这些"这个世界现在是什么样"的问题属于
 * `bubblewrap.ts`（runner）——它在真正 spawn 之前，会拿 `resolveEffectiveMounts()`
 * 处理过的挂载列表来调这里的 `render()`，处理结果本身仍然是"先探测、再产出
 * 一份新的、已经确定可行的 profile"，`render()` 自己永远不做 I/O。
 *
 * 这条纯函数的边界正是"macOS 开发机没有 bwrap 也能测"的来源：对 argv/plan
 * 的断言只需要构造一个 `IsolationProfile`（普通对象字面量），调 `render()`，
 * 断言返回的字符串数组——不需要真的启动任何进程。
 *
 * argv 的分段顺序（相对今天 Python 版的一点调整，行为不变、更容易读）：
 *
 * 1. 命名空间与身份相关 flag（一次性给全，包含 `--as-pid-1` / `--unshare-net`，
 *    今天 Python 版把这两个夹在挂载列表中间，这里合并成一段——bwrap 对这些
 *    flag 之间的相对顺序没有要求，调整不改变行为）
 * 2. 按 `MountPlan` 顺序逐条挂载
 * 3. 环境变量（默认 `--clearenv` + 逐个 `--setenv`；正式 spawn 可改为从
 *    bwrap 的受控继承环境传入，避免敏感值出现在进程参数中）
 * 4. `--chdir`（如果 `LaunchPlan.cwd` 有值）+ `--` + （可能被 nproc 包装过的）命令
 */
import {
  type BindMount,
  type EnvPlan,
  type IsolationProfile,
  type LaunchPlan,
  type Mount,
  type NamespacePlan,
  IsolationConfigError,
} from './profile.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertValidEnvEntry(key: string, value: string): void {
  if (!ENV_NAME_RE.test(key) || value.includes('\x00')) {
    throw new IsolationConfigError(`Invalid environment variable: ${JSON.stringify(key)}`);
  }
}

function renderNamespace(ns: NamespacePlan): string[] {
  const args: string[] = [];
  if (ns.dieWithParent) args.push('--die-with-parent');
  if (ns.newSession) args.push('--new-session');
  if (ns.namespaces.includes('user')) {
    args.push('--unshare-user', '--uid', String(ns.uid), '--gid', String(ns.gid));
  }
  if (ns.namespaces.includes('pid')) args.push('--unshare-pid');
  if (ns.namespaces.includes('ipc')) args.push('--unshare-ipc');
  if (ns.namespaces.includes('uts')) args.push('--unshare-uts');
  if (ns.namespaces.includes('net')) args.push('--unshare-net');
  args.push('--cap-drop', ns.capDrop);
  if (ns.asPid1) args.push('--as-pid-1');
  return args;
}

function bindFlag(mount: BindMount): string {
  if (mount.kind === 'ro_bind') {
    return mount.required ? '--ro-bind' : '--ro-bind-try';
  }
  return mount.required ? '--bind' : '--bind-try';
}

function renderMount(mount: Mount): string[] {
  switch (mount.kind) {
    case 'ro_bind':
    case 'bind':
      return [bindFlag(mount), mount.source, mount.target];
    case 'dir':
      return ['--dir', mount.target];
    case 'proc':
      return ['--proc', mount.target];
    case 'dev':
      return ['--dev', mount.target];
    case 'tmpfs':
      return ['--tmpfs', mount.target];
  }
}

export interface RenderOptions {
  /**
   * `argv` 保持可审计的传统 `--clearenv` + `--setenv` 形式；`inherited` 由正式
   * spawn 使用，先校验环境计划但不把值放进 bwrap 参数（`ps` / `/proc/<pid>/cmdline`
   * 是全局可读的，凭据不能出现在那里）。
   *
   * **`inherited` 连 `--clearenv` 也不发**——bwrap 于是把自己的环境原样传给
   * 子进程。用它的调用方**必须**自己把 spawn 的 `env` 收成受控集合，否则
   * 整个宿主环境会进沙箱。目前唯一的调用方是 `bubblewrap.ts` 的 `spawnLaunch`。
   */
  readonly envMode?: 'argv' | 'inherited';
}

function renderEnv(env: EnvPlan, options: RenderOptions): string[] {
  const args: string[] = [];
  for (const [key, value] of Object.entries(env.vars)) {
    assertValidEnvEntry(key, value);
  }
  if (options.envMode === 'inherited') return args;
  if (env.clearEnv) args.push('--clearenv');
  for (const [key, value] of Object.entries(env.vars)) {
    args.push('--setenv', key, value);
  }
  return args;
}

/**
 * 在命名空间**内部**执行的 rlimit 包装器。
 *
 * 形状：`bash -c <SCRIPT> -- <flag> <value> [<flag> <value> ...] -- <argv...>`。
 * 第一个 `--` 之后是成对的 `ulimit` 选项与取值，第二个 `--` 之后是真正的命令。
 * 每一对都用软硬两次 `ulimit` 落实，与今天 Python 版对 nproc 的做法一致。
 *
 * 为什么要在里面设而不是在宿主侧设：`RLIMIT_NPROC` 按 **UID** 计数，而不是
 * 按命名空间——在 bwrap 之前收紧它，计的是宿主上共享该 UID 的全部无关进程
 * （exec 服务自身的线程也算），可能直接让命名空间建不起来。`RLIMIT_NOFILE`
 * 同理会把 bwrap 自己要打开的挂载 fd 一起限住。进了用户命名空间之后，
 * uid 已经被映射成沙箱内的身份，计数范围才是这一次执行的进程树。
 */
const RLIMIT_WRAPPER_SCRIPT =
  'set -eu; while [ "$1" != "--" ]; do f="$1"; v="$2"; shift 2; ' +
  'ulimit -S "$f" "$v"; ulimit -H "$f" "$v"; done; shift; exec "$@"';

/** `LaunchPlan` → 包装器要下发的 `ulimit` 选项对。空数组 = 不需要包装器。 */
function rlimitPairs(launch: LaunchPlan): string[] {
  const pairs: string[] = [];
  const push = (flag: string, value: number | undefined): void => {
    if (value !== undefined && Number.isFinite(value) && value > 0) {
      pairs.push(flag, String(Math.trunc(value)));
    }
  };
  push('-u', launch.maxProcessCount);
  push('-n', launch.rlimits?.maxOpenFiles);
  push('-t', launch.rlimits?.cpuSeconds);
  push('-f', launch.rlimits?.fileSizeKb);
  push('-v', launch.rlimits?.addressSpaceKb);
  return pairs;
}

function renderCommand(launch: LaunchPlan): string[] {
  const args: string[] = [];
  if (launch.cwd !== undefined) {
    args.push('--chdir', launch.cwd);
  }
  args.push('--');
  const pairs = rlimitPairs(launch);
  if (pairs.length > 0) {
    args.push('/bin/bash', '-c', RLIMIT_WRAPPER_SCRIPT, '--', ...pairs, '--', ...launch.argv);
  } else {
    args.push(...launch.argv);
  }
  return args;
}

/** 是否会给命令套上 rlimit 包装器——由 `LaunchPlan` 上的全部限额共同决定，
 * 调用方（如 `bubblewrap.ts`）不需要重新解析 argv 就能知道这件事。 */
export function nprocWrapperApplied(profile: IsolationProfile): boolean {
  return rlimitPairs(profile.launch).length > 0;
}

/** 把 `profile` 渲染成 bwrap 的参数列表（不含 `bwrap` 可执行文件本身，也不含
 * 服务自身的能力剥离前缀——那两者都是运行环境相关的东西，由 `bubblewrap.ts`
 * 在实际 spawn 时拼到这个返回值前面）。 */
export function render(profile: IsolationProfile, options: RenderOptions = {}): readonly string[] {
  return [
    ...renderNamespace(profile.namespace),
    ...profile.mounts.flatMap(renderMount),
    ...renderEnv(profile.env, options),
    ...renderCommand(profile.launch),
  ];
}
