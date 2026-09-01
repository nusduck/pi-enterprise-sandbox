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
import type {
  JobId,
  JobHooks,
  JobOutcome,
  JobRead,
  JobSnapshot,
  JobStart,
  JobStatus,
} from '@deepseek-ai/dsh-jobs';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ExecRpcClient, resolveExecRpcConfig, runWithExecJobId } from './exec-rpc.js';
import type { ExecRpcConfig } from './exec-rpc.js';

export interface RemoteJobsOptions extends ExecRpcConfig {}

interface RemoteJobEntry {
  readonly id: JobId;
  readonly kind: JobSnapshot['kind'];
  readonly label: string;
  readonly outputLimitBytes?: number;
  readonly owner?: Agent;
  readonly hooks: JobHooks;
  readonly startedAt: number;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
  status: JobStatus;
  detail?: string;
  finishedAt?: number;
  reported: boolean;
  output?: string;
}

function isTerminal(status: JobStatus): boolean {
  return status === 'completed' || status === 'killed' || status === 'failed';
}

function snapshotOf(entry: RemoteJobEntry): JobSnapshot {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    ...(entry.outputLimitBytes !== undefined
      ? { outputLimitBytes: entry.outputLimitBytes }
      : {}),
    ...(entry.owner?.id !== undefined ? { ownerSession: entry.owner.id } : {}),
    status: entry.status,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    startedAt: entry.startedAt,
    ...(entry.finishedAt !== undefined ? { finishedAt: entry.finishedAt } : {}),
    reported: entry.reported,
  } as JobSnapshot;
}

export class RemoteJobs extends JobRegistry {
  private readonly rpc: ExecRpcClient;
  private readonly entries = new Map<JobId, RemoteJobEntry>();
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
    if (!spec || typeof spec.kind !== 'string' || spec.kind.length === 0) {
      throw new Error('invalid job kind: expected a non-empty string');
    }
    if (typeof spec.label !== 'string' || spec.label.length === 0) {
      throw new Error('invalid job label: expected a non-empty string');
    }
    if (
      spec.outputLimitBytes !== undefined &&
      (!Number.isSafeInteger(spec.outputLimitBytes) || spec.outputLimitBytes <= 0)
    ) {
      throw new Error('invalid outputLimitBytes: expected a positive safe integer');
    }
    const id = `${spec.kind}-${randomUUID().replace(/-/g, '')}` as JobId;
    const hooks = runWithExecJobId(id, () => spec.run());
    if (!hooks || typeof hooks !== 'object' || typeof hooks.done?.then !== 'function') {
      throw new Error('background job producer must return hooks with a done promise');
    }
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const entry: RemoteJobEntry = {
      id,
      kind: spec.kind,
      label: spec.label,
      ...(spec.outputLimitBytes !== undefined
        ? { outputLimitBytes: spec.outputLimitBytes }
        : {}),
      ...(spec.owner !== undefined ? { owner: spec.owner } : {}),
      hooks,
      startedAt: Date.now(),
      settled,
      resolveSettled,
      status: 'running',
      reported: false,
    };
    this.entries.set(id, entry);
    void Promise.resolve(hooks.done).then(
      (outcome) => this.settle(entry, outcome),
      (error) =>
        this.settle(entry, {
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        }),
    );
    this.notifyChanged(spec.owner);
    return id;
  }

  override list(caller?: Agent): JobSnapshot[] {
    return [...this.entries.values()]
      .filter((entry) => entry.owner === undefined || entry.owner.id === caller?.id)
      .map(snapshotOf);
  }

  override get(id: JobId, caller?: Agent): JobSnapshot {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.assertAccess(entry, caller);
      return snapshotOf(entry);
    }
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
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.assertAccess(entry, caller);
      const text =
        typeof entry.hooks.readOutput === 'function'
          ? entry.hooks.readOutput()
          : isTerminal(entry.status)
            ? entry.output ?? ''
            : '';
      if (isTerminal(entry.status)) entry.reported = true;
      return { text, snapshot: snapshotOf(entry) } as JobRead;
    }
    void this.rpc
      .post<{ id: JobId }, unknown>('/internal/v1/jobs/read', { id }, this.roots)
      .catch(() => undefined);
    return {
      text: '',
      snapshot: this.get(id),
    } as unknown as JobRead;
  }

  override kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished' {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.assertAccess(entry, caller);
      if (isTerminal(entry.status)) {
        entry.reported = true;
        return 'already-finished';
      }
      entry.hooks.cancel(reason);
      entry.status = 'stopping';
      entry.reported = true;
      this.notifyChanged(entry.owner);
      return 'requested';
    }
    void this.rpc
      .post<{ id: JobId }, unknown>('/internal/v1/jobs/kill', { id }, this.roots)
      .catch(() => undefined);
    return 'requested';
  }

  override async wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot> {
    const entry = this.entries.get(id);
    if (entry !== undefined) {
      this.assertAccess(entry, caller);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('invalid wait timeout: expected a positive number of milliseconds');
      }
      if (!isTerminal(entry.status)) {
        await new Promise<void>((resolve, reject) => {
          let finished = false;
          const timer = setTimeout(() => {
            if (finished) return;
            finished = true;
            signal?.removeEventListener('abort', onAbort);
            resolve();
          }, timeoutMs);
          const onAbort = () => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            entry.settled.then(resolve, resolve);
            reject(new Error('wait aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          entry.settled.then(() => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
          });
          if (signal?.aborted) onAbort();
        });
      }
      if (isTerminal(entry.status)) entry.reported = true;
      return snapshotOf(entry);
    }
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

  private assertAccess(entry: RemoteJobEntry, caller?: Agent): void {
    if (entry.owner !== undefined && entry.owner.id !== caller?.id) {
      throw new Error(`job ${entry.id} belongs to another session`);
    }
  }

  private settle(entry: RemoteJobEntry, outcome: JobOutcome): void {
    if (isTerminal(entry.status)) return;
    entry.status = outcome.status;
    if (outcome.detail !== undefined) entry.detail = outcome.detail;
    if (outcome.output !== undefined) entry.output = outcome.output;
    entry.finishedAt = Date.now();
    entry.resolveSettled();
    this.notifyChanged(entry.owner);
    const snapshot = snapshotOf(entry);
    for (const listener of this.doneListeners) {
      try {
        listener(snapshot, entry.owner);
      } catch (error) {
        console.warn(`remote jobs completion listener failed: ${String(error)}`);
      }
    }
  }

  private notifyChanged(owner?: Agent): void {
    for (const listener of this.changedListeners) {
      try {
        listener(owner);
      } catch (error) {
        console.warn(`remote jobs change listener failed: ${String(error)}`);
      }
    }
  }
}

export default RemoteJobs;
