/**
 * `ctx.shell` 的 RPC 代理——本机零子进程，全部转发 exec 内部面。
 *
 * 为什么需要它：执行面在另一个容器里，`dsh-shell` 的本地 executor 在 Agent 侧
 * 没有可用的 `bwrap`/`setpriv`。dsh-rebuild 3.0 进程图里 `agent(worker) → exec(HTTP)`
 * 这条边就是它。上游 `ShellExecutor.resolve()` 本来就存在“需要 I/O 的远程后端”
 * 分支，这里就是那个远程后端。
 *
 * `run()` 只在基础设施故障时 reject，非零退出不是 reject（dsh-shell 契约）；
 * `start()` 绝不套超时，立即返回 `ShellProcess`（后台句柄）。
 */

import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import { randomUUID } from 'node:crypto';
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import type { Context } from '@deepseek-ai/cordis';
import { ContractError } from '@pi/contract/errors.js';
import { currentExecJobId, ExecRpcClient, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

/** 后台作业监控的节奏。仅测试注入——生产用下面那三个常量。 */
export interface MonitorTuning {
  readonly minDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly failureDeadlineMs?: number;
}

export interface RemoteShellOptions extends ExecRpcConfig {
  /** 仅测试注入：覆盖后台作业监控的轮询节奏与失败截止。 */
  readonly monitor?: MonitorTuning;
}

// 后台作业监控的轮询节奏。成功一次就回到最小间隔；连续失败时指数退避，
// 并且有一个总的失败截止时间——没有截止的话，一个查不到的作业会让 Worker
// 以 5 次/秒的频率永远空转下去（`settled` 永远不会变成 true）。
const MONITOR_MIN_DELAY_MS = 200;
const MONITOR_MAX_DELAY_MS = 2_000;
const MONITOR_FAILURE_DEADLINE_MS = 60_000;

/**
 * exec 说"这个作业不存在"——`internal-jobs.ts` 把 `JobNotFoundError` 映射成
 * `WORKSPACE_NOT_FOUND`。这是终态而不是抖动：句柄没了、账本里也查不到，
 * 再问一万次也是同一个答案。
 */
function isJobGone(err: unknown): boolean {
  return err instanceof ContractError && err.code === 'WORKSPACE_NOT_FOUND';
}

function defaultWorkdir(_request: ShellExecRequest): string {
  return '/home/sandbox/workspace';
}

function resolveSpec(request: ShellExecRequest): ShellExecSpec {
  const command = request.command;
  const workdir = request.workdir ?? defaultWorkdir(request);
  const timeoutMs = request.timeoutMs ?? 120_000;
  const stdoutMaxBytes = request.stdoutMaxBytes ?? 50 * 1024;
  return {
    command,
    workdir,
    timeoutMs,
    stdoutMaxBytes,
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
    ...(request.env !== undefined ? { env: request.env } : {}),
    ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
    sandboxPolicy: request.sandboxPolicy,
  };
}

class RemoteShellProcess implements ShellProcess {
  status: 'running' | 'completed' | 'killed' = 'running';
  exitCode: number | null = null;
  signal: NodeJS.Signals | null = null;
  readonly done: Promise<void>;
  private doneResolver: () => void = () => undefined;
  private outputBuf = '';
  private lossy = false;
  private cursor: string | null = null;
  private pullInFlight: Promise<void> | null = null;
  private settled = false;

  constructor(
    private readonly rpc: ExecRpcClient,
    private readonly roots: readonly string[],
    readonly id: string,
    private readonly tuning: MonitorTuning = {},
  ) {
    let resolver: () => void = () => undefined;
    this.done = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    this.doneResolver = resolver;
  }

  start(request: Promise<{ id: string; status: string }>): void {
    void request
      .then((res) => {
        if (res.id !== this.id) throw new Error('exec returned a mismatched process id');
        void this.monitor();
      })
      .catch(() => this.settleFromExec('killed', null, null));
  }

  readOutput(): { delta: string; lossy: boolean } {
    const delta = this.outputBuf;
    this.outputBuf = '';
    const wasLossy = this.lossy;
    this.lossy = false;
    // 仍走 RPC 增量拉取（若 exec 侧有新数据）——简化：同步返回本地缓冲，同时后台轮询一次
    void this.pull();
    return { delta, lossy: wasLossy };
  }

  kill(): boolean {
    if (this.settled || this.status !== 'running') return false;
    void this.rpc
      .post<{ id: string }, unknown>('/internal/v1/jobs/kill', { id: this.id }, this.roots)
      .then((data: any) => {
        if (data?.status === 'completed' || data?.status === 'killed' || data?.status === 'failed') {
          this.settleFromExec(data.status, data.exitCode ?? null, data.signal ?? null);
        }
      })
      .catch(() => undefined);
    return true;
  }

  /** 供 `RemoteShell.start` 收到 exec 通知后推进状态 */
  settleFromExec(status: 'completed' | 'killed' | 'failed', exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.status = status === 'completed' ? 'completed' : 'killed';
    this.exitCode = exitCode;
    this.signal = signal;
    this.doneResolver();
  }

  private async monitor(): Promise<void> {
    const minDelayMs = this.tuning.minDelayMs ?? MONITOR_MIN_DELAY_MS;
    const maxDelayMs = this.tuning.maxDelayMs ?? MONITOR_MAX_DELAY_MS;
    const failureDeadlineMs = this.tuning.failureDeadlineMs ?? MONITOR_FAILURE_DEADLINE_MS;
    let delayMs = minDelayMs;
    let firstFailureAt: number | null = null;
    while (!this.settled) {
      try {
        const data = await this.rpc.post<{ id: string }, any>(
          '/internal/v1/jobs/status',
          { id: this.id },
          this.roots,
        );
        await this.pull();
        firstFailureAt = null;
        delayMs = minDelayMs;
        if (data.status === 'completed' || data.status === 'killed' || data.status === 'failed') {
          this.settleFromExec(data.status, data.exitCode ?? null, data.signal ?? null);
          return;
        }
      } catch (err) {
        // 作业已经不存在：立刻结算，不再轮询。
        if (isJobGone(err)) {
          this.settleFromExec('killed', null, null);
          return;
        }
        // 其余错误按抖动处理，但要退避、而且有截止时间——不抛给模型不等于
        // 可以无限重试。连续失败超过 deadline 就当作 failed 结算，让上层
        // 看到一个终态，而不是一个永远 running 的幽灵进程。
        const now = Date.now();
        if (firstFailureAt === null) {
          firstFailureAt = now;
        } else if (now - firstFailureAt >= failureDeadlineMs) {
          this.settleFromExec('failed', null, null);
          return;
        }
        delayMs = Math.min(delayMs * 2, maxDelayMs);
      }
      if (!this.settled) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
      }
    }
  }

  private pull(): Promise<void> {
    if (this.pullInFlight !== null) return this.pullInFlight;
    const payload: Record<string, unknown> = { id: this.id };
    if (this.cursor !== null) payload.cursor = this.cursor;
    const task = this.rpc
      .post<Record<string, unknown>, { text?: string; lossy?: boolean; nextCursor?: string; cursor?: string }>(
        '/internal/v1/jobs/read',
        payload,
        this.roots,
      )
      .then((data) => {
        const text = typeof data.text === 'string' ? data.text : '';
        if (text.length > 0) this.outputBuf += text;
        if (data.lossy === true) this.lossy = true;
        const nextCursor = data.nextCursor ?? data.cursor;
        if (typeof nextCursor === 'string' && nextCursor !== '') this.cursor = nextCursor;
      })
      .catch(() => {
        // 网络抖动不抛给模型，留给下一次 readOutput
      })
      .finally(() => {
        this.pullInFlight = null;
      });
    this.pullInFlight = task;
    return task;
  }
}

export class RemoteShell extends ShellExecutor {
  private readonly rpc: ExecRpcClient;
  private readonly monitorTuning: MonitorTuning;

  constructor(ctx: Context, options: Partial<RemoteShellOptions> = {}) {
    super(ctx as unknown as never);
    const resolved = resolveExecRpcConfig(options);
    this.rpc = new ExecRpcClient(resolved);
    this.monitorTuning = options.monitor ?? {};
  }

  rebind(options: ExecRpcConfig): void {
    this.rpc.rebind(options);
  }

  /**
   * 脱敏用的物理根，**每次调用时从本 Run 的 ALS 取**（ADR 0009 D3）。
   *
   * 2026-08-31 之前这是一个字段，由 `rebind()` 按 Run 改写。而 provider 是
   * 全进程共享的单例（`ensureCtx` 是 `bootOnce`），所以并发的第二个 Run 会把
   * 第一个 Run 的脱敏根换掉——A 的未分类错误按 B 的根脱敏 = A 的真实路径原样泄漏。
   * 见 `tests/runtime/tenant-isolation.test.ts`。
   */
  private get roots(): readonly string[] {
    return this.rpc.activeConfig().physicalRoots;
  }

  /** 围栏在 exec 侧；不宣称本机 sandboxMode，工具层才不会要求 ctx.sandboxPolicy。 */
  override get sandboxMode(): 'workspace-write' | undefined {
    return undefined;
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return resolveSpec(request);
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const payload: Record<string, unknown> = {
      command: spec.command,
      workdir: spec.workdir,
      timeoutMs: spec.timeoutMs,
      stdoutMaxBytes: spec.stdoutMaxBytes,
    };
    if (spec.signal !== undefined) payload['signal'] = true;
    if (spec.stdin !== undefined) payload['stdin'] = spec.stdin;
    if (spec.env !== undefined) payload['env'] = spec.env;
    // dshEnv/sandboxPolicy 透传由 exec 侧隔离层决定，这里只转发 command/timeout/workdir 基础集

    const data = await this.rpc.post<Record<string, unknown>, ShellRunResult>(
      '/internal/v1/shell/run',
      payload,
      this.roots,
    );
    return data;
  }

  override start(spec: ShellExecSpec): ShellProcess {
    const payload: Record<string, unknown> = {
      command: spec.command,
      workdir: spec.workdir,
    };
    if (spec.stdin !== undefined) payload['stdin'] = spec.stdin;
    if (spec.env !== undefined) payload['env'] = spec.env;
    const active = this.rpc.activeConfig();
    const id = currentExecJobId() ?? `bash-${randomUUID().replace(/-/g, '')}`;
    payload['id'] = id;
    if (active.runId) payload['runId'] = active.runId;

    // `start` 是同步返回句柄的契约，内部异步通知通过 done Promise
    const rpc = this.rpc;
    const roots = this.roots;
    const proc = new RemoteShellProcess(rpc, roots, id, this.monitorTuning);
    proc.start(rpc.post<Record<string, unknown>, { id: string; status: string }>(
      '/internal/v1/shell/start',
      payload,
      roots,
    ));

    return proc;
  }
}

export default RemoteShell;
