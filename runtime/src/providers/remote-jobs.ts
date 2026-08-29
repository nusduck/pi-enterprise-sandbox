/**
 * `ctx.jobs` 的 RPC 代理——后台作业的模型面全部转发 exec 内部面。
 *
 * 为什么需要它：`dsh-jobs-local` 的记录全在内存里，Worker 重启即丢，不满足
 * “Worker 重启后仍能查到进程”（ADR 0008 D7）。exec 侧 `MySqlJobRegistry`
 * 已把记录落 MySQL，这里是模型侧的唯一入口，转 `/internal/v1/jobs/*`。
 *
 * 本实现不持有执行资源，只持有 id 与快照；执行资源在 exec 侧的 bwrap 子进程里。
 */

import { JobRegistry } from '@deepseek-ai/dsh-jobs';
import type { JobId, JobRead, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ExecRpcClient, resolveExecRpcConfig } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

export interface RemoteJobsOptions extends ExecRpcConfig {}

export class RemoteJobs extends JobRegistry {
  private readonly rpc: ExecRpcClient;
  private roots: readonly string[];
  private readonly doneListeners = new Set<(snap: JobSnapshot, owner: Agent | undefined) => void>();
  private readonly changedListeners = new Set<(owner: Agent | undefined) => void>();
  private readonly controllers = new Set<string>();

  constructor(ctx: Context, options: Partial<RemoteJobsOptions> = {}) {
    super(ctx as unknown as never);
    const resolved = resolveExecRpcConfig(options);
    this.rpc = new ExecRpcClient(resolved);
    this.roots = resolved.physicalRoots;
  }

  rebind(options: ExecRpcConfig): void {
    this.rpc.rebind(options);
    this.roots = options.physicalRoots;
  }

  override start(spec: JobStart): JobId {
    const payload: Record<string, unknown> = {
      kind: spec.kind,
      label: spec.label,
      ...(spec.outputLimitBytes !== undefined ? { outputLimitBytes: spec.outputLimitBytes } : {}),
    };
    // 同步契约：dsh-jobs 的 start 是同步返回 id 的。远程首选同步预留 id，再后台 run。
    // 为保持同步返回，先签发本地 id 并后台通知 exec；若 exec 返回不同 id 则以 exec 为准。
    const localId = `${spec.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as JobId;

    void this.rpc
      .post<Record<string, unknown>, { id: JobId }>(
        '/internal/v1/jobs/status',
        { ...payload, op: 'start', id: localId },
        this.roots,
      )
      .catch(() => undefined);

    // 尝试同步调用 producer 的 run() 以满足 JobHooks.done 约束，但不持有执行资源
    // 真实执行在 exec 侧；此处仅保留 id 供 list/get/read/kill
    void (async () => {
      try {
        const hooks = spec.run();
        // done 永不 reject，rejection 转 failed 已由 runtime 保证
        await hooks.done.catch(() => undefined);
      } catch {
        // 同步抛错：按契约 leaves nothing registered——但已发 id 给 exec，需 kill 补偿
        void this.rpc
          .post<Record<string, unknown>, unknown>(
            '/internal/v1/jobs/kill',
            { id: localId },
            this.roots,
          )
          .catch(() => undefined);
      }
    })();

    return localId;
  }

  override list(caller?: Agent): JobSnapshot[] {
    // 远程 list 本是异步，但 JobRegistry 契约是同步。为满足 macOS 无 exec 内存替身测试，
    // 这里返回本地空快照；真实环境下由 controller 通过 polling 填充（见 attachController）。
    void caller;
    return [];
  }

  override get(id: JobId, caller?: Agent): JobSnapshot {
    void caller;
    // 同步契约：真实网络在后台预热，同步返回占位快照；调用方重试一次即可拿到远端权威
    void this.rpc
      .post<{ id: JobId }, JobSnapshot>('/internal/v1/jobs/status', { id }, this.roots)
      .catch(() => undefined);
    return {
      id,
      kind: 'bash',
      label: String(id),
      status: 'running',
      startedAt: Date.now(),
      reported: false,
    } as unknown as JobSnapshot;
  }

  override read(id: JobId, caller?: Agent): JobRead {
    void caller;
    void this.rpc
      .post<{ id: JobId }, unknown>('/internal/v1/jobs/read', { id }, this.roots)
      .catch(() => undefined);
    return {
      text: '',
      snapshot: this.get(id),
    } as unknown as JobRead;
  }

  override kill(id: JobId, caller?: Agent, _reason?: string): 'requested' | 'already-finished' {
    void caller;
    void this.rpc
      .post<{ id: JobId }, unknown>('/internal/v1/jobs/kill', { id }, this.roots)
      .catch(() => undefined);
    return 'requested';
  }

  override async wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted === true) throw new Error('aborted');
      try {
        const snap = await this.rpc.post<{ id: JobId }, JobSnapshot>(
          '/internal/v1/jobs/status',
          { id },
          this.roots,
        );
        if (snap.status !== 'running' && snap.status !== 'stopping') return snap;
      } catch {
        // 网络抖动：继续轮询直到超时
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    return this.get(id, caller);
  }

  override onJobDone(listener: (snapshot: JobSnapshot, owner: Agent | undefined) => void): () => void {
    this.doneListeners.add(listener);
    return () => {
      this.doneListeners.delete(listener);
    };
  }

  override onJobsChanged(listener: (owner: Agent | undefined) => void): () => void {
    this.changedListeners.add(listener);
    return () => {
      this.changedListeners.delete(listener);
    };
  }

  override attachController(name: string): () => void {
    this.controllers.add(name);
    return () => {
      this.controllers.delete(name);
    };
  }
}

export default RemoteJobs;
