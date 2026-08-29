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
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import type { Context } from '@deepseek-ai/cordis';
import { ExecRpcClient, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

export interface RemoteShellOptions extends ExecRpcConfig {}

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

  constructor(
    private readonly rpc: ExecRpcClient,
    private readonly roots: readonly string[],
    private readonly id: string,
  ) {
    let resolver: () => void = () => undefined;
    this.done = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    this.doneResolver = resolver;
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
    if (this.status !== 'running') return false;
    void this.rpc
      .post<{ id: string }, unknown>('/internal/v1/jobs/kill', { id: this.id }, this.roots)
      .then(() => {
        this.status = 'killed';
        this.doneResolver();
      })
      .catch(() => undefined);
    return true;
  }

  /** 供 `RemoteShell.start` 收到 exec 通知后推进状态 */
  settleFromExec(status: 'completed' | 'killed' | 'failed', exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.status = status === 'completed' ? 'completed' : 'killed';
    this.exitCode = exitCode;
    this.signal = signal;
    this.doneResolver();
  }

  private async pull(): Promise<void> {
    try {
      const data = await this.rpc.post<{ id: string }, { text: string; lossy: boolean }>(
        '/internal/v1/jobs/read',
        { id: this.id },
        this.roots,
      );
      if (data.text.length > 0) this.outputBuf += data.text;
      if (data.lossy) this.lossy = true;
    } catch {
      // 网络抖动不抛给模型，留给下一次 readOutput
    }
  }
}

export class RemoteShell extends ShellExecutor {
  private readonly rpc: ExecRpcClient;
  private roots: readonly string[];

  constructor(ctx: Context, options: Partial<RemoteShellOptions> = {}) {
    super(ctx as unknown as never);
    const resolved = resolveExecRpcConfig(options);
    this.rpc = new ExecRpcClient(resolved);
    this.roots = resolved.physicalRoots;
  }

  rebind(options: ExecRpcConfig): void {
    this.rpc.rebind(options);
    this.roots = options.physicalRoots;
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

    // `start` 是同步返回句柄的契约，内部异步通知通过 done Promise
    const rpc = this.rpc;
    const roots = this.roots;
    const proc = new RemoteShellProcess(rpc, roots, `pending-${Date.now()}`);

    // 后台发起，不阻塞调用方
    void (async () => {
      try {
        const res = await rpc.post<Record<string, unknown>, { id: string; status: string }>(
          '/internal/v1/shell/start',
          payload,
          roots,
        );
        // 用 exec 返回的 id 替换 pending 句柄的 id（通过私有字段重绑定）
        (proc as unknown as Record<string, unknown>)['id'] = res.id;
      } catch {
        proc.settleFromExec('killed', null, null);
      }
    })();

    return proc;
  }
}

export default RemoteShell;
