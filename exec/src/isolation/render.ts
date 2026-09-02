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
   * `argv` 保持可审计的传统 `--setenv` 形式；`inherited` 由正式 spawn 使用，
   * 先校验环境计划但不把值放进 bwrap 参数，调用方会把它交给 spawn 的 env。
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
 * >0 时把命令包进一层命名空间内部执行的 ulimit 包装器。
 * 字符串逐字保留今天 Python 版的 shell 片段，行为不变。
 */
const NPROC_WRAPPER_SCRIPT =
  'set -eu; limit="$1"; shift; ulimit -S -u "$limit"; ulimit -H -u "$limit"; exec "$@"';

function renderCommand(launch: LaunchPlan): string[] {
  const args: string[] = [];
  if (launch.cwd !== undefined) {
    args.push('--chdir', launch.cwd);
  }
  args.push('--');
  if (launch.maxProcessCount > 0) {
    args.push(
      '/bin/bash',
      '-c',
      NPROC_WRAPPER_SCRIPT,
      '--',
      String(launch.maxProcessCount),
      ...launch.argv,
    );
  } else {
    args.push(...launch.argv);
  }
  return args;
}

/** 是否会给命令套上 nproc 包装器——纯粹由 `LaunchPlan.maxProcessCount` 决定，
 * 调用方（如 `bubblewrap.ts`）不需要重新解析 argv 就能知道这件事。 */
export function nprocWrapperApplied(profile: IsolationProfile): boolean {
  return profile.launch.maxProcessCount > 0;
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
