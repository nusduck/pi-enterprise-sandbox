/**
 * Bubblewrap runner：把 `IsolationProfile` 变成真正的子进程（ADR 0008 D3）。
 *
 * `profile.ts` / `render.ts` / `build.ts` / `preflight.ts` 都是纯函数——不碰
 * 文件系统、不判断当前环境有什么。这个文件是唯一做真实世界 I/O 的地方：
 *
 * - 读 `/proc/self/status` 决定要不要在 exec 前用 `setpriv` 剥离服务自身的
 *   Linux capabilities（今天 `_capability_drop_prefix()`，
 *   `sandbox/isolation/bubblewrap.py:40-72`）
 * - spawn 之前探测每条 `required: false` 挂载的源路径，把探测失败的挂载从
 *   最终 argv 里摘掉——见下面 `resolveEffectiveMounts()` 的文档，这里做了一个
 *   相对今天 Python 版的**泛化**，不是纯移植，务必看完整段注释
 * - 对 `ensureDir: true` 的挂载（XDG home 三个子目录）先 mkdir
 * - 真正 spawn（探针用 `preflightCheck()`，正式启动用 `spawnLaunch()`）
 *
 * 因为所有 I/O 都收在这一个文件里，`profile.ts`/`render.ts`/`build.ts`/
 * `preflight.ts` 的测试才能在没有 bwrap、甚至没有 Linux 命名空间支持的
 * macOS 开发机上跑；只有本文件里真正 spawn bwrap 的测试需要跳过。
 */
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { render, type RenderOptions } from './render.js';
import type { BindMount, IsolationProfile, Mount, MountPlan } from './profile.js';

/** Bubblewrap 本身不可用（缺可执行文件、缺 `setpriv`、探针跑不通）时抛出。
 * 对应今天 Python 版的 `IsolationUnavailable`——注意它专指"这个环境跑不了
 * bwrap"，不是"这次的 profile 数据有问题"（那是 `IsolationConfigError`，见
 * `profile.ts`，由 `render.ts`/`build.ts` 抛）。 */
export class IsolationUnavailable extends Error {
  override readonly name = 'IsolationUnavailable';
}

// ── 能力剥离前缀 ──────────────────────────────────────────────────────

/** 服务进程自己是否仍带着 Linux capabilities。对应 `_inherited_capabilities()`。
 * 非 Linux（没有 `/proc/self/status`，例如 macOS 开发机）直接返回 false——
 * 这条检查的存在意义只在容器化的 Linux 部署里成立。 */
function inheritedCapabilities(): boolean {
  let status: string;
  try {
    status = readFileSync('/proc/self/status', 'ascii');
  } catch {
    return false;
  }
  for (const line of status.split('\n')) {
    const match = /^Cap(?:Eff|Inh|Amb):\s*([0-9a-fA-F]+)/.exec(line);
    if (match?.[1] !== undefined) {
      try {
        if (BigInt(`0x${match[1]}`) !== 0n) return true;
      } catch {
        // 格式异常按"没有能力"处理，与 Python 版 ValueError → False 一致。
      }
    }
  }
  return false;
}

function which(name: string): string | undefined {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 不在这个目录，继续找下一个。
    }
  }
  return undefined;
}

export interface CapabilityDropOverrides {
  /** 测试替身：真实实现读 `/proc/self/status`，在没有 Linux capabilities 的
   * 开发机（比如 macOS）上永远是 false，没法覆盖"服务确实带着能力"这条分支。 */
  readonly hasCapabilities?: () => boolean;
  /** 测试替身：真实实现在 `PATH` 里找 `setpriv`。 */
  readonly which?: (name: string) => string | undefined;
}

/**
 * 服务进程若仍带着 capabilities，在 exec bwrap 之前用 `setpriv` 清空它们。
 *
 * 服务可能保留 `CAP_KILL` 以便重启恢复时信号一个已验证的孤儿进程，但这个
 * capability 绝不能被未受信的子进程继承——bwrap 在建立用户命名空间之前会
 * 拒绝带 inherited capabilities 的调用者。`setpriv` 是运行时镜像自带的工具；
 * 如果服务确实带着 capabilities 但镜像里没有 `setpriv`，这是部署故障，
 * fail closed（抛错而不是静默跳过剥离）。
 *
 * `overrides` 只用于测试：真实的能力检测只在 Linux 上有意义，macOS 开发机
 * 上 `/proc/self/status` 不存在，没法测到"服务确实带着能力"这条分支，
 * 所以留了这个注入点。生产路径不传。
 */
export function capabilityDropPrefix(overrides?: CapabilityDropOverrides): readonly string[] {
  const hasCapabilities = overrides?.hasCapabilities ?? inheritedCapabilities;
  const resolveWhich = overrides?.which ?? which;
  if (!hasCapabilities()) return [];
  const setpriv = resolveWhich('setpriv');
  if (!setpriv) {
    throw new IsolationUnavailable(
      'setpriv is required to drop service capabilities before Bubblewrap',
    );
  }
  return [setpriv, '--inh-caps=-all', '--ambient-caps=-all', '--'];
}

// ── 挂载源探测 ────────────────────────────────────────────────────────

export interface ResolveMountsOptions {
  /** 某条 `required: false` 挂载因为源不可用被摘掉时的回调，默认 `console.warn`。
   * ENOENT（源不存在）是正常状态，不会触发这个回调——只有"存在但探测失败"
   * （最常见是 EACCES）才会，与今天 Python 版的 `logger.warning(...)` 对应。 */
  readonly onDegraded?: (mount: BindMount, error: unknown) => void;
}

function defaultOnDegraded(mount: BindMount, error: unknown): void {
  console.warn(
    `[isolation] optional mount source is present but not accessible; continuing without it: ` +
      `${mount.source} -> ${mount.target} (${String(error)})`,
  );
}

/**
 * spawn 前把 `MountPlan` 变成"这次真的能挂"的版本。这是相对今天 Python 版的
 * 一处泛化，不是逐字移植，主控评审时请留意：
 *
 * Python 版只对**用户 skill 目录**这一条 `--ro-bind-try` 做了探测（见
 * `sandbox/isolation/bubblewrap.py:158-179`）：先 `stat()`，`ENOENT` 就正常
 * 略过，其它错误（典型是 `0700` 权限导致的 `EACCES`）就打日志退回系统 skill
 * 层，而不是把这条 `--ro-bind-try` 原样传给 bwrap。原因是 bwrap 自己的
 * `--ro-bind-try`/`--bind-try` **只**吃 `ENOENT`——源存在但不可读会让 bwrap
 * 直接整体失败，`bash`、`python`、连 `pwd` 都用不了。
 *
 * ADR 0008 D4 把这条"一个包坏了不能拖累全部工具"的要求从"唯一一条用户
 * skill 绑定"泛化成了"逐包绑定，每一包都是独立的 `required: false` 挂载"。
 * 如果只对包挂载沿用 Python 那样的显式白名单探测，静态列表（`/usr`、`/bin`
 * 等）仍然是不探测直接传 `--ro-bind-try` 的老路——理论上一样有"权限异常导致
 * 整个 bwrap 失败"的风险，只是今天的部署形态下这些路径的可读性由服务自身
 * 的运行身份保证，从没实际触发过。
 *
 * 与其保留这条"只对某一类挂载特殊处理"的隐性假设，这里把探测规则应用到
 * **所有** `required: false` 的挂载：探测失败（非 ENOENT）就把这条挂载从
 * 最终 argv 里摘掉并打警告，而不是让它有机会把整个启动拖下水。这与
 * `required` 在类型里写的语义（"仅 ENOENT 可恕"）是一回事，只是把它从
 * "调用方约定俗成的心智负担"变成一条对所有挂载生效的实际检查。
 *
 * `required: true` 的挂载不在这里"探测后丢弃"——源缺失就应该失败，只是
 * 失败时给一句人话（而不是 bwrap 那句 "can't find source path"），并且
 * （仅对标了 `ensureDir` 的挂载）在检查前先把目录建好。
 */
export function resolveEffectiveMounts(
  mounts: MountPlan,
  options: ResolveMountsOptions = {},
): MountPlan {
  const onDegraded = options.onDegraded ?? defaultOnDegraded;
  const resolved: Mount[] = [];
  for (const mount of mounts) {
    if (mount.kind !== 'ro_bind' && mount.kind !== 'bind') {
      resolved.push(mount);
      continue;
    }
    const bind = mount;
    if (bind.required) {
      if (bind.ensureDir) {
        mkdirSync(bind.source, { recursive: true });
      } else {
        try {
          statSync(bind.source);
        } catch (error) {
          throw new IsolationUnavailable(
            `Required mount source is missing or inaccessible: ${bind.source} ` +
              `(target ${bind.target}) — this is a deployment fault; every sandboxed ` +
              `command will fail until it is fixed. Cause: ${String(error)}`,
          );
        }
      }
      resolved.push(bind);
      continue;
    }
    // required: false — 探测一次，ENOENT 静默跳过（bwrap 的 -try 本来就会
    // 这么做，我们只是提前做，避免下面的"非 ENOENT 也跳过"分支显得不一致）；
    // 任何其它错误也跳过，但要说一声，因为这偏离了调用方对"应该能挂上"的预期。
    try {
      statSync(bind.source);
      resolved.push(bind);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        onDegraded(bind, error);
      }
      // 摘掉这条挂载：不传给 render()，也就不会出现在最终 argv 里。
    }
  }
  return resolved;
}

// ── 组装最终可执行的调用 ─────────────────────────────────────────────

export interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * 把 `profile` 变成一次真正可以 `spawn` 的调用：先用 `resolveEffectiveMounts()`
 * 把挂载列表落实成"这次真的能挂"的版本，再交给 `render()`（唯一的 argv
 * 渲染函数）产出 bwrap 参数，最后按需要拼上能力剥离前缀。
 *
 * `executable` 是 `bwrap` 二进制的绝对路径，由调用方给出（通常来自配置或
 * `which('bwrap')`）——这里不做路径发现，只做"给定路径，组出最终 argv"。
 */
export function resolveInvocation(
  executable: string,
  profile: IsolationProfile,
  resolveOptions?: ResolveMountsOptions,
  capabilityOverrides?: CapabilityDropOverrides,
  renderOptions?: RenderOptions,
): Invocation {
  const resolvedMounts = resolveEffectiveMounts(profile.mounts, resolveOptions);
  const resolvedProfile: IsolationProfile = { ...profile, mounts: resolvedMounts };
  const bwrapArgs = render(resolvedProfile, renderOptions);
  const prefix = capabilityDropPrefix(capabilityOverrides);
  if (prefix.length === 0) {
    return { command: executable, args: bwrapArgs };
  }
  const [command, ...restPrefix] = prefix as [string, ...string[]];
  return { command, args: [...restPrefix, executable, ...bwrapArgs] };
}

// ── 真正 spawn ────────────────────────────────────────────────────────

/** 外层（未进入命名空间前）跑 bwrap 本身要用的环境——刻意最小化，不透传服务
 * 进程的环境变量。正式启动时会在这个最小环境上叠加已校验的 `EnvPlan`，
 * 但不会把值渲染进 bwrap 的 argv；否则 `ps`/`/proc/<pid>/cmdline` 会暴露业务
 * 数据库凭据。沙箱内部的环境仍只来自这份受控环境，不会继承完整宿主 env。 */
export const OUTER_PROCESS_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
};

/**
 * `spawnLaunch` 的选项。**故意排除 `env`**：沙箱内的环境只能来自 `EnvPlan`，
 * 调用方不得从外面注入（见 `spawnLaunch` 里的说明）。
 */
export type SpawnLaunchOptions = Omit<SpawnOptionsWithoutStdio, 'env'>;

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * 服务启动时的健康检查：这个环境里的 bwrap 到底能不能跑。
 *
 * `profile` 应该是 `preflight.ts` 产出的探针 profile（`toPreflightProfile()`
 * 或 `buildPreflightProfile()`）——传一个带会话特定挂载的正常 profile 进来
 * 大概率会因为源路径不存在而失败，这不是这个函数的职责范围。
 */
export function preflightCheck(
  executable: string,
  profile: IsolationProfile,
  opts?: { readonly timeoutMs?: number },
): void {
  let stat;
  try {
    stat = statSync(executable);
  } catch {
    throw new IsolationUnavailable(`Bubblewrap executable unavailable: ${executable}`);
  }
  if (!stat.isFile()) {
    throw new IsolationUnavailable(`Bubblewrap executable unavailable: ${executable}`);
  }
  try {
    accessSync(executable, fsConstants.X_OK);
  } catch {
    throw new IsolationUnavailable(`Bubblewrap executable unavailable: ${executable}`);
  }

  const { command, args } = resolveInvocation(executable, profile);
  const result = spawnSync(command, args, {
    timeout: opts?.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS,
    env: OUTER_PROCESS_ENV,
  });
  if (result.error) {
    throw new IsolationUnavailable(`Bubblewrap preflight failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr?.toString('utf-8') ?? '').trim().slice(0, 500);
    throw new IsolationUnavailable(`Bubblewrap preflight exited ${result.status}: ${detail}`);
  }
}

/**
 * 正式启动一次隔离执行。这里只负责把 `profile` 变成一个 `ChildProcess`——
 * stdout/stderr 管理、资源限制的 preexec、作业登记（重启后仍能查到）都是
 * `exec/src/shell/executor.ts`（W2-A）与 `job-registry.ts`（W2-B）的职责，
 * 不在本次 W1-C 范围内，这里刻意保持成一个薄封装。
 */
export function spawnLaunch(
  executable: string,
  profile: IsolationProfile,
  options?: SpawnLaunchOptions,
): ChildProcess {
  const { command, args } = resolveInvocation(executable, profile, undefined, undefined, {
    envMode: 'inherited',
  });
  // 沙箱内进程的环境**只有**这两个来源：最小外层环境 + 已校验的 `EnvPlan`。
  //
  // `envMode: 'inherited'` 不发 `--clearenv`，于是 bwrap 把自己的环境原样传给
  // 子进程——"不继承宿主 env" 这条不变量因此从 bwrap 的 argv 挪到了这一行。
  // 调用方给的 `env` 在类型上被排除，运行时再剥一次：漏一个 `env: process.env`
  // 进来，整个服务进程的环境（含 DB 凭据）就进沙箱了。
  const { env: _rejected, ...safeOptions } = (options ?? {}) as SpawnOptionsWithoutStdio;
  const env: Record<string, string> = { ...OUTER_PROCESS_ENV, ...profile.env.vars };
  return spawn(command, args, { ...safeOptions, env });
}
