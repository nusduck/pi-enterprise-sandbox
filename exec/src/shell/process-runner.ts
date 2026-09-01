/**
 * 真正的进程生命周期：从 `IsolationProfile` 到一个可以观测/可以杀死的
 * `ChildProcess`。这是 `executor.ts` 与隔离层之间唯一的连接点——硬要求
 * "每一次 spawn 都必须先过 `exec/src/isolation/`"（ADR 0007 D11）就落在
 * 这一个文件的 {@link spawnConfined} 里：仓库里只有这一处调用
 * `isolation/bubblewrap.ts` 的 `spawnLaunch()`，其它任何想要执行命令的
 * 代码都必须经过这个模块，没有第二条路。
 *
 * 相对 `sandbox/utils/resource_limits.py` 的 `run_with_timeout()`，这里做了
 * 大量简化——不是漏做，是 Node 的事件循环替我们免费拿到了 Python 版专门
 * 起线程池才能做到的事：
 *
 * - Python 版要手写 `StoppableStreamReader` 线程 + `select()` 轮询，是因为
 *   `subprocess.Popen` 的阻塞读需要单独线程才不卡主线程；Node 的
 *   `ChildProcess.stdout`/`stderr` 天生是异步 `Readable`，`'data'` 事件
 *   直接在事件循环里跑，不需要额外线程。
 * - Python 版要手动管理进程组（`os.setsid` + `killpg`），因为它跑在
 *   "同一个世界"里，子进程可能逃逸出预期的进程组。这里的目标进程永远是
 *   Bubblewrap（`spawnLaunch` 的返回值），Bubblewrap 自己的
 *   `--unshare-pid` + `--die-with-parent`（见 `isolation/build.ts` 的
 *   `NamespacePlan`）已经保证了"杀掉这一个 bwrap 进程，命名空间内部全部
 *   后代进程跟着被内核回收"——不需要在宿主侧再维护一份进程组账本。这里
 *   仍然用 `detached: true` + 目标进程组信号作为兜底防线（万一某次调用没有
 *   经过 bwrap，比如未来测试直接 spawn 别的东西），但不是主要的安全机制。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { buildIsolationProfile } from '../isolation/build.js';
import { spawnLaunch } from '../isolation/bubblewrap.js';
import type { IsolationProfile, NetworkMode } from '../isolation/profile.js';
import type { SandboxMode, WorkspaceContext } from '../types.js';
import { fuseDeadline } from './deadline.js';
import { BoundedTextCapture, LiveOutputTracker, finalizeCapture, type CollectedOutputLike } from './output-capture.js';

/** SIGTERM → SIGKILL 升级前的默认宽限期（毫秒）。与 `dsh-bash-local` 的
 * `DEFAULT_GRACE_MS` 对齐（其注释："matches OpenCode's 3s"）。 */
export const DEFAULT_GRACE_MS = 3_000;

/** spawn 阶段（进程还没跑起来）就失败——基础设施故障，调用方应当据此
 * reject `run()`，或在 `start()` 里结算成 `killed` 并把消息写进 stderr。
 * 不要跟 `isolation/bubblewrap.ts` 的 `IsolationUnavailable`/
 * `IsolationConfigError` 混在一起判断——那两个是**同步**抛出（profile 还
 * 没变成一个真正的 `ChildProcess` 之前）；这个是子进程对象已经拿到手、
 * 但 Node 事件循环稍后才告诉我们"其实没启动成功"（比如 bwrap 可执行文件
 * 路径本身在 spawn 那一刻消失了）。两者对调用方的意义相同（基础设施
 * 故障），但触发时机不同，调用方需要分别在同步 `try/catch` 与
 * `awaitSettlement()` 的 rejection 里各接一次。 */
export class SpawnInfrastructureError extends Error {
  override readonly name = 'SpawnInfrastructureError';
}

export interface SpawnTarget {
  readonly workspace: WorkspaceContext;
  readonly mode: SandboxMode;
  /** 沙箱内要跑的目标命令，未净化，例如 `['bash', '-c', cmd]`。 */
  readonly argv: readonly string[];
  readonly relativeCwd?: string | undefined;
  /** 已经过 `safe-env.ts` 洗过的环境变量表。 */
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly networkMode?: NetworkMode | undefined;
  readonly maxProcessCount?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly stdin?: string | undefined;
}

export interface RunnerConfig {
  /** `bwrap` 可执行文件的绝对路径。 */
  readonly bwrapExecutable: string;
}

function buildProfile(target: SpawnTarget): IsolationProfile {
  return buildIsolationProfile({
    context: target.workspace,
    mode: target.mode,
    command: target.argv,
    envOverrides: target.envOverrides,
    ...(target.relativeCwd !== undefined ? { relativeCwd: target.relativeCwd } : {}),
    ...(target.networkMode !== undefined ? { networkMode: target.networkMode } : {}),
    ...(target.maxProcessCount !== undefined ? { maxProcessCount: target.maxProcessCount } : {}),
    ...(target.uid !== undefined ? { uid: target.uid } : {}),
    ...(target.gid !== undefined ? { gid: target.gid } : {}),
  });
}

interface LiveSpawn {
  readonly child: ChildProcess;
  readonly profile: IsolationProfile;
}

/**
 * 硬要求落地点：先 `buildIsolationProfile()`，再 `spawnLaunch()`
 * （内部只做 `resolveInvocation()` → `render()` → `child_process.spawn()`，
 * 见 `isolation/bubblewrap.ts`）。可能同步抛出 `IsolationUnavailable` /
 * `IsolationConfigError`——调用方必须当作基础设施故障处理，不吞掉。
 *
 * `detached: true`：让 bwrap 子进程成为宿主侧一个独立的进程组 leader，
 * 使得 {@link killGroup} 可以用负 pid 对整个组发信号，而不只是这一个
 * 直接子进程。
 */
function spawnConfined(target: SpawnTarget, config: RunnerConfig): LiveSpawn {
  const profile = buildProfile(target);
  const child = spawnLaunch(config.bwrapExecutable, profile, { detached: true });
  return { child, profile };
}

function wireOutput(child: ChildProcess, stdout: BoundedTextCapture, stderr: BoundedTextCapture): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.feedBytes(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.feedBytes(chunk);
  });
}

/** 没有 stdin 内容时立刻关闭 fd 0（不留一个悬空、命令可能会一直等着读的
 * 管道）；有内容时写入后关闭——一次性写入，不支持持续交互（与 dsh-shell
 * 的 `ShellExecSpec.stdin` 契约一致："written once at spawn and closed"）。 */
function writeStdin(child: ChildProcess, stdin: string | undefined): void {
  if (!child.stdin) return;
  if (stdin !== undefined && stdin.length > 0) {
    child.stdin.end(stdin, 'utf-8');
  } else {
    child.stdin.end();
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** 优先对进程组发信号（`detached: true` 让 `child.pid` 同时是组 id）；
 * 拿不到 pid 或者组信号失败（例如目标其实不是组 leader）时退回直接
 * 信号这一个子进程，尽力而为，不让升级路径本身抛错中断调用方。 */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // 进程已经不在了，忽略。
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (hasExited(child)) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

/** SIGTERM → 宽限期 → SIGKILL，与 Python 版 `terminate_process_group()`
 * 同样的两级升级，但不需要它那套"进程组是否还存在"的显式探测——直接
 * 再发一次信号，目标不存在时 {@link killGroup} 自己吞掉 `ESRCH`。 */
async function terminateWithGrace(child: ChildProcess, graceMs: number): Promise<void> {
  if (hasExited(child)) return;
  killGroup(child, 'SIGTERM');
  await Promise.race([onceExit(child), delay(graceMs)]);
  if (!hasExited(child)) {
    killGroup(child, 'SIGKILL');
  }
}

/** 等到 Node 认定"进程已退出**且**所有 stdio 流都已经关闭"（`'close'`
 * 事件——比 `'exit'` 更适合我们：保证这时候 `wireOutput()` 已经收完了
 * 全部可以收到的数据）。spawn 阶段本身失败时 Node 会先触发 `'error'`，
 * 这里把它转换成 {@link SpawnInfrastructureError} 而不是让调用方误把
 * "进程根本没跑起来"当成"跑起来了、退出码恰好很奇怪"。 */
function awaitSettlement(
  child: ChildProcess,
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(
        new SpawnInfrastructureError(
          `failed to spawn sandboxed process: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code, signal: signal as NodeJS.Signals | null });
    });
  });
}

// ── 前台执行：run() ─────────────────────────────────────────────────

export interface ForegroundOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdout: CollectedOutputLike;
  readonly stderr: CollectedOutputLike;
}

export interface RunForegroundOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly stdoutMaxChars: number;
  readonly stderrMaxChars: number;
  readonly graceMs?: number | undefined;
}

/**
 * 前台执行一次。可能抛出的两类异常都代表基础设施故障，调用方
 * （`executor.ts` 的 `run()`）应当原样 reject，不要转换成 `ShellRunResult`：
 * - 同步：`spawnConfined()` 内部的 `IsolationUnavailable` / `IsolationConfigError`
 * - 异步：{@link SpawnInfrastructureError}（来自 `awaitSettlement()`）
 *
 * 命令本身的非零退出、超时杀、取消杀都通过正常返回值表达，不抛出。
 */
export async function runForeground(
  target: SpawnTarget,
  config: RunnerConfig,
  opts: RunForegroundOptions,
): Promise<ForegroundOutcome> {
  const { child } = spawnConfined(target, config);

  const stdoutCap = new BoundedTextCapture(opts.stdoutMaxChars);
  const stderrCap = new BoundedTextCapture(opts.stderrMaxChars);
  wireOutput(child, stdoutCap, stderrCap);
  writeStdin(child, target.stdin);

  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const fused = fuseDeadline(opts.signal, opts.timeoutMs);
  const onAbort = (): void => {
    void terminateWithGrace(child, graceMs);
  };
  if (fused.signal.aborted) {
    onAbort();
  } else {
    fused.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const settlement = await awaitSettlement(child);
    const timedOut = fused.timedOut();
    return {
      exitCode: settlement.exitCode,
      signal: settlement.signal,
      timedOut,
      // 互斥：只有"融合信号确实触发了、且不是因为我们自己的超时定时器"
      // 才算调用方取消（dsh-shell README 的"first cause"分类）。
      aborted: fused.signal.aborted && !timedOut,
      stdout: finalizeCapture(stdoutCap),
      stderr: finalizeCapture(stderrCap),
    };
  } finally {
    fused.signal.removeEventListener('abort', onAbort);
    fused.clear();
  }
}

// ── 后台执行：start() ───────────────────────────────────────────────

export interface LiveProcessHandle {
  pid: number | null;
  pgid: number | null;
  status: 'running' | 'completed' | 'killed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  done: Promise<void>;
  readOutput(): { readonly delta: string; readonly lossy: boolean };
  kill(): boolean;
  writeStdin(data: string, eof: boolean): void;
}

export interface StartBackgroundOptions {
  readonly signal?: AbortSignal | undefined;
  /** stdout 与 stderr 共用同一个上限（dsh-shell README："background jobs
   * ... keep the executor's own output cap"——不像前台那样按调用方预算）。 */
  readonly outputMaxChars: number;
  readonly graceMs?: number | undefined;
}

/**
 * 后台启动一次。**不 reject**——包括 spawn 阶段的基础设施故障：那类失败
 * 按 `ShellProcess` 的契约结算成 `status: 'killed'`，错误文本写进
 * `readOutput()` 能读到的 stderr 里（dsh-shell README："spawn failures
 * settle as `killed` with the error on stderr"）。这是 `start()` 与
 * `run()` 在错误处理上唯一不对称的地方，直接对应两者在 dsh-shell 里
 * 不同的契约文本。
 */
export function startBackground(
  target: SpawnTarget,
  config: RunnerConfig,
  opts: StartBackgroundOptions,
): LiveProcessHandle {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const tracker = new LiveOutputTracker(opts.outputMaxChars);

  const proc: LiveProcessHandle = {
    pid: null,
    pgid: null,
    status: 'running',
    exitCode: null,
    signal: null,
    done: Promise.resolve() as Promise<void>,
    readOutput: () => tracker.read(),
    kill: () => false,
    writeStdin: () => {
      throw new Error('process is not running');
    },
  } as LiveProcessHandle;

  let child: ChildProcess;
  try {
    ({ child } = spawnConfined(target, config));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracker.stderr.feedBytes(Buffer.from(`spawn failed: ${message}`, 'utf-8'));
    tracker.stderr.flush();
    proc.status = 'killed';
    return proc;
  }

  wireOutput(child, tracker.stdout, tracker.stderr);
  writeStdin(child, target.stdin);
  proc.pid = child.pid ?? null;
  proc.pgid = child.pid ?? null;
  proc.writeStdin = (data, eof) => {
    if (proc.status !== 'running' || child.stdin === null) {
      throw new Error('process stdin is unavailable');
    }
    if (data.length > 0) child.stdin.write(data);
    if (eof) child.stdin.end();
  };

  let killRequested = false;
  proc.kill = () => {
    if (proc.status !== 'running') return false;
    killRequested = true;
    void terminateWithGrace(child, graceMs);
    return true;
  };

  if (opts.signal) {
    if (opts.signal.aborted) {
      proc.kill();
    } else {
      opts.signal.addEventListener('abort', () => proc.kill(), { once: true });
    }
  }

  proc.done = awaitSettlement(child)
    .then((settlement) => {
      tracker.stdout.flush();
      tracker.stderr.flush();
      proc.exitCode = settlement.exitCode;
      proc.signal = settlement.signal;
      proc.status = killRequested || settlement.signal !== null ? 'killed' : 'completed';
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      tracker.stderr.feedBytes(Buffer.from(`\n[spawn error] ${message}`, 'utf-8'));
      tracker.stderr.flush();
      proc.status = 'killed';
      // `done` 按契约从不 reject：错误已经落进 stderr，这里吞掉。
    });

  return proc;
}
