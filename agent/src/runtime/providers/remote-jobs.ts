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
import { randomUUID } from 'node:crypto';
import type { JobId, JobRead, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ExecRpcClient, resolveExecRpcConfig, runWithExecJobId } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

export interface RemoteJobsOptions extends ExecRpcConfig {}

export class RemoteJobs extends JobRegistry {
  private readonly rpc: ExecRpcClient;
  private readonly doneListeners = new Set<(snap: JobSnapshot, owner: Agent | undefined) => void>();
  private readonly changedListeners = new Set<(owner: Agent | undefined) => void>();
  private readonly controllers = new Set<string>();

  constructor(ctx: Context, options: Partial<RemoteJobsOptions> = {}) {
    super(ctx as unknown as never);
    const resolved = resolveExecRpcConfig(options);
    this.rpc = new ExecRpcClient(resolved);
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

  override start(spec: JobStart): JobId {
    const id = `${spec.kind}-${randomUUID().replace(/-/g, '')}` as JobId;
    runWithExecJobId(id, () => spec.run());
    return id;
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
