/**
 * 隔离的命令执行器——W2-A 主入口。
 *
 * 这个文件是 `exec/src/shell/` 的**唯一**对外执行入口（ADR 0007 D11）：
 * 任何想要在沙箱里启动进程的代码都必须经过这里，没有第二条 spawn 路径。
 * 它本身是薄组合层：策略判定 → 环境清洗 → Python 物化 → `process-runner.ts`
 * 真正 spawn——隔离层的构造（`buildIsolationProfile`/`render`/`spawnLaunch`）
 * 全部藏在 `process-runner` 内部，这里不再复述 bwrap 细节。
 *
 * 设计取舍（对比 Python 版 `execution_manager.py` 638 行）：
 * - 单会话串行（`_session_locks`/`_admit`）不在这里——那是 HTTP 层或
 *   `job-registry` 的并发控制职责，隔离执行器只保证"这次 spawn 是隔离的"。
 * - 子进程配额监控（`ChildWorkspaceQuotaWatch`）不在这里——W2-C 的
 *   `child-quota.ts` 已有，HTTP 层在 spawn 前后编排它。
 * - `run()` 只在**基础设施故障**时 reject，非零退出/超时/取消都 resolve
 *   成 `ShellRunResult`（dsh-shell 契约原文）；`start()` 绝不套超时，且
 *   spawn 失败结算成 `killed` 而非 reject。
 */

import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { parseShellWorkdir, type ShellWorkdir } from '@dsh/contract/shell-payload.js';
import type { ResourceLimitPlan } from '../isolation/profile.js';
import type { SandboxMode, WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import { isBlockedCommand } from './blocked-commands.js';
import { buildSafeEnvOverrides } from './safe-env.js';
import { DEFAULT_OUTPUT_CAP_CHARS } from './output-capture.js';
import { planPythonLaunch, shouldMaterialize } from './python-materialize.js';
import {
  runForeground,
  startBackground,
  type LiveProcessHandle,
  type SpawnTarget,
} from './process-runner.js';

/** 默认前台超时（毫秒），与 Python 版 `execution_timeout_seconds=120` 对齐。 */
const DEFAULT_TIMEOUT_MS = 120_000;

/** 构造器入参——`WorkspaceContext` 是物理路径的唯一来源。 */
export interface IsolatedShellExecutorOptions {
  readonly workspace: WorkspaceContext;
  readonly bwrapExecutable: string;
  /** 沙箱模式固定为 `workspace-write` 或 `read-only`（无 `danger-full-access`）。 */
  readonly mode: SandboxMode;
  readonly defaultTimeoutMs?: number;
  readonly outputCapChars?: number;
  /**
   * 命名空间内部的 RLIMIT_NPROC 上限（`SANDBOX_MAX_PROCESS_COUNT`）。
   * 缺省 0 = 不限制。**生产装配必须传**——2026-09-16 之前这里从来没有
   * 调用方传值，Compose 声明的 20 从未生效（审查 R1）。
   */
  readonly maxProcessCount?: number;
  /** 其余命名空间内部 rlimit（NOFILE / CPU / FSIZE / AS）。 */
  readonly rlimits?: ResourceLimitPlan;
  /** 测试注入：覆盖 process.env。 */
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * `ShellExecSpec.workdir`（沙箱逻辑路径）→ runner 的 `relativeCwd` + `cwdScope`。
 *
 * 2026-09-16 之前 `workdir` 在这一层被彻底忽略：executor 从不把它传给
 * `process-runner`，模型指定的子目录一律退化成工作区根（审查 R4）。
 * 越界路径在这里抛错（`parseShellWorkdir` 的 `ENVELOPE_INVALID`），
 * 不静默退回根目录——"悄悄换个目录执行"比"拒绝执行"危险得多。
 */
function resolveWorkdir(workdir: string | undefined): ShellWorkdir {
  return parseShellWorkdir(workdir);
}

/** 便于测试的 bwrap 路径解析器注入。 */
function requireBwrapExecutable(executable: string): string {
  const trimmed = (executable ?? '').trim();
  if (!trimmed) {
    throw new Error('bwrap executable is required');
  }
  return trimmed;
}

/** 把租户上下文转成脱敏所需的物理根列表。 */
function physicalRootsForRedact(workspace: WorkspaceContext): readonly string[] {
  return [workspace.workspaceRoot, workspace.tempRoot];
}

/** 统一的物理路径脱敏。 */
function redact(text: string, workspace: WorkspaceContext): string {
  return redactPhysicalRoots(text, physicalRootsForRedact(workspace));
}

/** 受阻结果的统一构造——resolve 而非 reject。 */
function blockedRunResult(
  workspace: WorkspaceContext,
  mode: SandboxMode,
  command: string,
  timeoutMs: number,
): ShellRunResult {
  return deniedRunResult(
    workspace,
    mode,
    `blocked: dangerous command denied: ${command.slice(0, 200)}`,
    timeoutMs,
  );
}

/**
 * 「这次执行被拒绝」的统一结果形状。与 {@link blockedRunResult} 同一契约
 * （resolve 而非 reject，`sandbox.denied` 为 true），但消息由调用方给——
 * HTTP 层的配额准入用它把「工作区超额」这件事如实交到模型手上，而不是
 * 变成一个没有原因的 500。
 */
export function deniedRunResult(
  workspace: WorkspaceContext,
  mode: SandboxMode,
  message: string,
  timeoutMs: number,
): ShellRunResult {
  return {
    exitCode: 126,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: redact(message, workspace), truncated: false },
    sandbox: { mode, denied: true },
  };
}

/** 受阻的后台句柄——按 dsh-shell 契约结算成 killed，错误进 stderr。 */
function blockedProcessHandle(
  workspace: WorkspaceContext,
  mode: SandboxMode,
  command: string,
): ShellProcess {
  return deniedProcessHandle(
    workspace,
    mode,
    `blocked: dangerous command denied: ${command.slice(0, 200)}`,
  );
}

/** 与 {@link deniedRunResult} 对应的后台形态：立刻结算成 killed，消息进 stderr。 */
export function deniedProcessHandle(
  workspace: WorkspaceContext,
  mode: SandboxMode,
  message: string,
): ShellProcess {
  const redacted = redact(message, workspace);
  // 手写一个最小 ShellProcess：status killed，readOutput 能读到错误，done 已 settle。
  let delivered = false;
  return {
    status: 'killed',
    exitCode: null,
    signal: null,
    done: Promise.resolve(),
    sandbox: { mode, denied: true },
    readOutput() {
      if (delivered) return { delta: '', lossy: false };
      delivered = true;
      return { delta: redacted, lossy: false };
    },
    kill() {
      return false;
    },
  };
}

/**
 * 隔离的 Shell 执行器——实现 `dsh-shell` 的 `resolve`/`run`/`start`/`sandboxMode`。
 *
 * 与 cordis 的 `ShellExecutor` 抽离：exec 容器没有 cordis 上下文，HTTP 层
 * 直接实例化这个类并传入 `WorkspaceContext`。需要对接 cordis 时，薄包装一层
 * 即可（见未来的 `runtime/providers/remote-shell.ts`）。
 */
export class IsolatedShellExecutor {
  readonly workspace: WorkspaceContext;
  readonly bwrapExecutable: string;
  readonly mode: SandboxMode;
  readonly defaultTimeoutMs: number;
  readonly outputCapChars: number;
  readonly maxProcessCount: number;
  readonly rlimits: ResourceLimitPlan | undefined;
  readonly processEnv: Readonly<Record<string, string | undefined>> | undefined;

  constructor(options: IsolatedShellExecutorOptions) {
    this.workspace = options.workspace;
    this.bwrapExecutable = requireBwrapExecutable(options.bwrapExecutable);
    this.mode = options.mode;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.outputCapChars = options.outputCapChars ?? DEFAULT_OUTPUT_CAP_CHARS;
    this.maxProcessCount = options.maxProcessCount ?? 0;
    this.rlimits = options.rlimits;
    this.processEnv = options.processEnv;
  }

  get sandboxMode(): SandboxMode {
    return this.mode;
  }

  /** 输出上限的字节天花板。见 `resolve()` 里对单位换算的说明。 */
  get outputCapBytes(): number {
    return this.outputCapChars * 4;
  }

  /**
   * `ShellExecSpec` → `process-runner` 的 `SpawnTarget`。**run 与 start 共用**，
   * 这样「workdir / stdin / env / 资源限额有没有真的传下去」只有一处需要核对。
   *
   * 2026-09-16 之前这两条路径各拼各的，而且两边都没传 `relativeCwd` 与
   * `maxProcessCount`——模型指定的子目录与 Compose 声明的进程数上限同时失效
   * （审查 R1/R4），却没有任何一层报错。
   */
  spawnTargetFor(argv: readonly string[], spec: ShellExecSpec): SpawnTarget {
    const cwd = resolveWorkdir(spec.workdir);
    return {
      workspace: this.workspace,
      mode: this.mode,
      argv,
      envOverrides: buildSafeEnvOverrides({
        ...(spec.env !== undefined ? { overrides: spec.env } : {}),
        ...(this.processEnv !== undefined ? { processEnv: this.processEnv } : {}),
      }),
      relativeCwd: cwd.relative,
      cwdScope: cwd.scope,
      maxProcessCount: this.maxProcessCount,
      ...(this.rlimits !== undefined ? { rlimits: this.rlimits } : {}),
      ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}),
    };
  }

  /**
   * 填充默认值与上限——对应 `dsh-shell` 的 `ShellExecutor.resolve()` 契约。
   * 不做任何 I/O，不抛业务错误，只做纯数据补全。
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const command = (request.command ?? '').trim();
    // 上限是**本执行面的预算**，不是一个与配置无关的 24 小时常数：
    // `SANDBOX_EXECUTION_TIMEOUT_SECONDS` 说了前台最多跑多久，超出的请求
    // 在 HTTP 层已被拒绝，这里再夹一次作为直接调用方的兜底。
    const timeoutRaw = request.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutMs = Math.max(1, Math.min(timeoutRaw, this.defaultTimeoutMs));
    // `stdoutMaxBytes` 是**字节**。执行面的配置 `SANDBOX_MAX_OUTPUT_CHARS`
    // 是字符数，两者不能直接互换：一个 UTF-16 code unit 最多占 3 个 UTF-8
    // 字节，所以字节天花板取 `outputCapChars * 4`（留一档余量，与本文件
    // 以前的默认值一致），而**缺省预算**取字符数本身当字节用——同一个数字
    // 按字节解释永远比按字符解释更紧，不会因为接线而放宽现有上限。
    const stdoutMaxBytes = Math.max(
      1,
      Math.min(request.stdoutMaxBytes ?? this.outputCapChars, this.outputCapBytes),
    );
    return {
      command,
      workdir: request.workdir ?? '.',
      timeoutMs,
      stdoutMaxBytes,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  /**
   * 前台执行。只在基础设施故障时 reject；命令非零、超时、取消、受阻都 resolve。
   * 每次启动必经 `process-runner` → `isolation/build` → `render`（硬要求）。
   */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const command = spec.command ?? '';
    if (!command.trim()) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: redact('command is required', this.workspace), truncated: false },
        sandbox: { mode: this.mode, denied: false },
      };
    }

    if (isBlockedCommand(command)) {
      return blockedRunResult(this.workspace, this.mode, command, spec.timeoutMs);
    }

    // 调用方给了字节预算就按字节算；没给就退回执行面自己的字符上限。
    // 两者单位不同，混用会在非 ASCII 输出上差出一倍，所以显式带上单位。
    const outputBudget =
      spec.stdoutMaxBytes !== undefined && spec.stdoutMaxBytes > 0
        ? { limit: spec.stdoutMaxBytes, unit: 'bytes' as const }
        : { limit: this.outputCapChars, unit: 'chars' as const };

    try {
      const outcome = await runForeground(
        // 绝不 shell-quote：目标命令永远是 `bash -c <command>` 的 argv 数组。
        this.spawnTargetFor(['bash', '-c', command], spec),
        { bwrapExecutable: this.bwrapExecutable },
        {
          timeoutMs: spec.timeoutMs,
          ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
          stdoutMaxChars: outputBudget.limit,
          stderrMaxChars: outputBudget.limit,
          outputUnit: outputBudget.unit,
        },
      );

      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        timeoutMs: spec.timeoutMs,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sandbox: { mode: this.mode, denied: false },
      };
    } catch (err) {
      // 基础设施故障——唯一允许 reject 的分支，按 `_shared.md` 必须无条件脱敏。
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(message, this.workspace));
    }
  }

  /**
   * 后台启动，立即返回句柄，不套超时。受阻时同样返回 killed 句柄而非抛错。
   */
  start(spec: ShellExecSpec): ShellProcess {
    const command = spec.command ?? '';
    if (!command.trim()) {
      return blockedProcessHandle(this.workspace, this.mode, 'empty command');
    }

    if (isBlockedCommand(command)) {
      return blockedProcessHandle(this.workspace, this.mode, command);
    }

    const handle = startBackground(
      this.spawnTargetFor(['bash', '-c', command], spec),
      { bwrapExecutable: this.bwrapExecutable },
      {
        ...(spec.signal !== undefined ? { signal: spec.signal } : {}),
        outputMaxChars: this.outputCapChars,
      },
    );

    return adaptLiveHandle(handle, this.mode);
  }

  /**
   * Python 代码专用入口：根据阈值决定 `python3 -c` 还是物化文件。
   * 这是 W2-A 硬要求"短单行走 -c，多行/超阈值先落工作区临时文件"的落地点。
   * 返回的 argv 已可直接交给 `run`/`start`（调用方把 `command` 换成 shell
   * 语法的 `python3 ...` 仍可，但这里直接产出 argv 更安全——无 shell 注入面）。
   *
   * 默认前台走 `runPython`，后台走 `startPython`，两者共享同一份物化逻辑。
   */
  async runPython(input: {
    code: string;
    executionId: string;
    args?: readonly string[];
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }): Promise<ShellRunResult> {
    const launch = await planPythonLaunch({
      code: input.code,
      executionId: input.executionId,
      workspaceRoot: this.workspace.workspaceRoot,
      ...(input.args !== undefined ? { args: input.args } : {}),
    });

    const command = launch.argv.join(' ');
    if (isBlockedCommand(command)) {
      return blockedRunResult(this.workspace, this.mode, command, input.timeoutMs ?? this.defaultTimeoutMs);
    }

    const envOverrides = buildSafeEnvOverrides({
      ...(input.env !== undefined ? { overrides: input.env } : {}),
      ...(this.processEnv !== undefined ? { processEnv: this.processEnv } : {}),
    });

    try {
      const outcome = await runForeground(
        {
          workspace: this.workspace,
          mode: this.mode,
          argv: launch.argv,
          envOverrides,
          maxProcessCount: this.maxProcessCount,
          ...(this.rlimits !== undefined ? { rlimits: this.rlimits } : {}),
        },
        { bwrapExecutable: this.bwrapExecutable },
        {
          timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          stdoutMaxChars: this.outputCapChars,
          stderrMaxChars: this.outputCapChars,
        },
      );
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        aborted: outcome.aborted,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        sandbox: { mode: this.mode, denied: false },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(redact(message, this.workspace));
    }
  }

  startPython(input: {
    code: string;
    executionId: string;
    args?: readonly string[];
    signal?: AbortSignal;
    env?: Record<string, string>;
  }): ShellProcess {
    // 同步校验；物化是异步（需落盘），但 start 必须同步返回句柄。
    // 因此这里用 shouldMaterialize 做快速判断：短单行直接起 inline，
    // 否则返回一个已结算为 killed 的句柄并提示调用方改用异步路径。
    // 正确的后台 Python 物化应由调用方先 await planPythonLaunch 再 start argv；
    // 这个便捷方法只覆盖最常见的 inline 场景，避免把异步物化塞进同步 start。
    if (shouldMaterialize(input.code)) {
      // 需要物化的多行/超阈值代码不能在同步 start 里安全地落盘而不阻塞返回。
      // 按契约结算成 killed，错误进 stderr，调用方改用 `planPythonLaunch` + `start` 的两步路径。
      const msg = 'python code requires materialization; use planPythonLaunch then start with the file argv';
      return blockedProcessHandle(this.workspace, this.mode, msg);
    }

    const launchPromise = planPythonLaunch({
      code: input.code,
      executionId: input.executionId,
      workspaceRoot: this.workspace.workspaceRoot,
      ...(input.args !== undefined ? { args: input.args } : {}),
    });

    // 已知是 inline，同步构造 ShellProcess 的最佳近似：先返回 running 句柄，
    // 后台再替换 argv。简化起见，这里退化为直接用 `python3 -c` 同步起。
    const envOverrides = buildSafeEnvOverrides({
      ...(input.env !== undefined ? { overrides: input.env } : {}),
      ...(this.processEnv !== undefined ? { processEnv: this.processEnv } : {}),
    });

    // 由于 shouldMaterialize 已保证 inline，直接同步起。
    // 若 planPythonLaunch 异步失败，start 契约要求结算成 killed。
    let handle: LiveProcessHandle | undefined;
    try {
      // 同步路径：inline 必成功，直接起。
      // 注意：这里不能 await launchPromise（start 必须同步返回），因此用已知的 inline argv。
      const inlineArgv: readonly string[] = ['python3', '-c', input.code, ...(input.args ?? [])];
      if (isBlockedCommand(inlineArgv.join(' '))) {
        return blockedProcessHandle(this.workspace, this.mode, inlineArgv.join(' '));
      }
      handle = startBackground(
        {
          workspace: this.workspace,
          mode: this.mode,
          argv: inlineArgv,
          envOverrides,
          maxProcessCount: this.maxProcessCount,
          ...(this.rlimits !== undefined ? { rlimits: this.rlimits } : {}),
        },
        { bwrapExecutable: this.bwrapExecutable },
        {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          outputMaxChars: this.outputCapChars,
        },
      );
      // 若后续 launchPromise 发现其实需要物化（极端竞态），已起的 inline 进程仍有效；
      // 两种路径结果一致（都是同一份 code 的执行），不纠正。
      void launchPromise.catch(() => undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return blockedProcessHandle(this.workspace, this.mode, redact(message, this.workspace));
    }
    return adaptLiveHandle(handle as LiveProcessHandle, this.mode);
  }
}

/** 把 `process-runner` 的 LiveProcessHandle 适配成 `dsh-shell` 的 ShellProcess。 */
function adaptLiveHandle(handle: LiveProcessHandle, mode: SandboxMode): ShellProcess {
  return {
    pid: handle.pid,
    pgid: handle.pgid,
    get status() {
      return handle.status;
    },
    get exitCode() {
      return handle.exitCode;
    },
    get signal() {
      return handle.signal;
    },
    get done() {
      return handle.done;
    },
    get sandbox() {
      return { mode, denied: false };
    },
    readOutput: () => handle.readOutput(),
    kill: () => handle.kill(),
    writeStdin: (data: string, eof: boolean) => handle.writeStdin(data, eof),
  } as ShellProcess & {
    pid: number | null;
    pgid: number | null;
    writeStdin(data: string, eof: boolean): void;
  };
}
