/**
 * 作业登记（MySqlJobRegistry）—— `exec/` 侧的 durable 作业账本。
 *
 * 这是什么：`@deepseek-ai/dsh-jobs` 的 `JobRegistry` 契约说"全部记录在内存，
 * 重启即丢"，ADR 0008 D7 要求"Worker 重启后仍能查到进程"，所以自建一个
 * 实现同样语义但记录落 MySQL 的注册表。本文件是唯一知道"作业"是什么、
 * 怎么起、怎么查、怎么杀的地方——`process-runner.ts` 只管把一个隔离好的
 * `ChildProcess` 跑起来，`job-store-*.ts` 只管一行 SQL，组装在这一层。
 *
 * 为什么不直接复用 `process_executions` 表：`JobStore` 顶部注释已说明
 * `workspaceId` 层级与 `sandbox_session_id` 不对齐、NOT NULL 外键等。
 * 新表 `exec_jobs` 由 W3-D 建，迁移权威在 `agent/`。
 *
 * 与 Python 版 `sandbox/services/process_manager.py`（1733 行）的关系：
 * 那 1733 行被按职责拆成：`job-types.ts`（词汇）、`job-cursor.ts`（环形
 * 缓冲）、`job-identity.ts`（PID 复用防护）、`job-owner-access.ts`（归属）、
 * `job-store-*.ts`（持久化）、`output-capture.ts`（前/后台输出）、
 * `process-runner.ts`（真正 spawn+bwrap）、本文件（编排 + first-wins 结算）。
 * 本文件只保留 Python 版中"被调用方认作契约"的部分：起进程/查状态/读输出/
 * 发信号/写 stdin/杀掉 + 孤儿回收，其它如 `transient_execution_stream`
 * 的 live fan-out 直接去掉——`exec/` 是 HTTP 服务，一次请求一个游标，
 * 不需要在进程内另起一个事件总线。
 */

import { randomUUID } from 'node:crypto';
import { redactPhysicalRoots } from '../fs/redact.js';
import {
  INITIAL_CURSOR,
  StreamCursorBuffer,
  parseCursor,
} from './job-cursor.js';
import {
  captureStartIdentity,
  identityMatches,
  safeSignalIdentity,
} from './job-identity.js';
import { JobNotFoundError, requireOwnedRecord } from './job-owner-access.js';
import type {
  JobOwner,
  JobOwnerScope,
  JobProcessChunk,
  JobProcessHandle,
  JobProcessOutcome,
  JobRead,
  JobRecord,
  JobSnapshot,
  JobStartSpec,
  JobStatus,
  JobStore,
} from './job-types.js';

const DEFAULT_MAX_ACTIVE_PER_OWNER = 20;
const DEFAULT_MAX_OUTPUT_BYTES = 500_000;
// 结算后 live 条目的保留窗口。留一段时间是为了让调用方把最后那点增量读完
// （`settle()` 已经把残留输出刷进 buffer）；过了窗口就整条丢掉，read 退化成
// 与"Worker 重启后"完全相同的那条路径——快照终态 + 空增量。
const DEFAULT_SETTLED_RETENTION_MS = 5 * 60_000;
// 保留窗口之外再加一道硬上限：短命作业密集时（每个都带一个最大 500KB 的
// 环形缓冲和一个子进程句柄）光靠时间窗口收得不够快。
const DEFAULT_MAX_SETTLED_ENTRIES = 512;

// ── 工具 ────────────────────────────────────────────────────────────────

function nowDate(): Date {
  return new Date();
}

function newJobId(kind: string, requested?: string): string {
  if (requested !== undefined) {
    if (!new RegExp(`^${kind}-[A-Za-z0-9_-]{1,160}$`).test(requested)) {
      throw new Error('invalid requested job id');
    }
    return requested;
  }
  // 用 uuid 保证唯一，前缀与 `kind` 对齐 `dsh-jobs` 的 `bash-1` 可预测风格
  // 但不照抄它的顺序 id——那在 durable 场景下会因重启而回卷。
  const short = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${kind}-${short}`;
}

function toSnapshot(record: JobRecord): JobSnapshot {
  return {
    id: record.id,
    ...(record.runId ? { runId: record.runId } : {}),
    kind: record.kind,
    label: record.label,
    outputLimitBytes: record.outputLimitBytes ?? undefined,
    ownerWorkspaceId: record.workspaceId,
    status: record.status,
    detail: record.detail ?? undefined,
    startedAt: record.startedAt ? record.startedAt.getTime() : record.createdAt.getTime(),
    finishedAt: record.finishedAt ? record.finishedAt.getTime() : undefined,
    exitCode: record.exitCode,
    pid: record.pid,
    reported: record.reported,
  };
}

function chunkToText(chunk: JobProcessChunk | undefined): string {
  if (!chunk) return '';
  // 合并 stdout + stderr 的 delta 已经在 `output-capture.ts` 里做过，
  // 这里只把 `delta` 原样吐出去，`lossy` 由调用方（本文件的 read）决定。
  return chunk.delta ?? '';
}

// ── live 状态：内存里那一半 ──────────────────────────────────────────

interface LiveEntry {
  readonly handle: JobProcessHandle;
  readonly owner: JobOwner;
  readonly buffer: StreamCursorBuffer;
  readonly physicalRoots: readonly string[];
  // first-wins 结算：一个作业只能被结算一次（完成/被杀/孤儿回收三条路径并发时）
  settled: boolean;
  // 结算时刻（毫秒）。`null` 表示还在跑。清理只看这个字段——活作业永不被回收。
  settledAt: number | null;
  // spill 引用 → 物理路径的映射（只在内存有效，重启后 spill 引用即失效，
  // 调用方拿着旧引用再来读会得到 lossy=true + 空增量，不会泄漏旧路径）。
  spillPaths: Map<string, string>;
}

export interface JobRegistryOptions {
  readonly maxActivePerOwner?: number;
  readonly maxOutputBytes?: number;
  /** 结算后 live 条目的保留窗口（毫秒），默认 5 分钟。0 表示结算即回收。 */
  readonly settledRetentionMs?: number;
  /** 同时保留的已结算条目上限，默认 512。超出时按结算时间从旧到新丢弃。 */
  readonly maxSettledEntries?: number;
  /** 仅测试注入：覆盖默认的身份捕获实现。 */
  readonly captureIdentity?: (pid: number) => Promise<string | null>;
}

/**
 * MySqlJobRegistry —— durable 作业登记。
 *
 * - 持久化只认 `JobStore`（W3-D 接手，见 `job-store-*.ts`）。
 * - 活句柄（`JobProcessHandle`）只在内存这一层，重启后必然丢失——这正是
 *   `recoverOrphans()` 存在的理由：把"还在 running 但已经没有活句柄"的
 *   记录标记为终态，防止它永远占着 `running`。
 */
export class MySqlJobRegistry {
  private readonly store: JobStore;
  private readonly maxActivePerOwner: number;
  private readonly maxOutputBytes: number;
  private readonly lives = new Map<string, LiveEntry>();
  private readonly settledRetentionMs: number;
  private readonly maxSettledEntries: number;
  private readonly captureIdentityFn: (pid: number) => Promise<string | null>;

  constructor(store: JobStore, options: JobRegistryOptions = {}) {
    this.store = store;
    this.maxActivePerOwner = Math.max(0, options.maxActivePerOwner ?? DEFAULT_MAX_ACTIVE_PER_OWNER);
    this.maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.settledRetentionMs = Math.max(0, options.settledRetentionMs ?? DEFAULT_SETTLED_RETENTION_MS);
    this.maxSettledEntries = Math.max(0, options.maxSettledEntries ?? DEFAULT_MAX_SETTLED_ENTRIES);
    this.captureIdentityFn = options.captureIdentity ?? ((pid) => captureStartIdentity(pid));
  }

  // ── Start ───────────────────────────────────────────────────────────

  async start(spec: JobStartSpec): Promise<JobSnapshot> {
    const ownerScope: JobOwnerScope = {
      orgId: spec.owner.orgId,
      userId: spec.owner.userId,
      workspaceId: spec.owner.workspaceId,
    };

    // 准入：只数 running + stopping（与 `job-store` 的 `countActiveForOwner` 对齐）。
    if (this.maxActivePerOwner > 0) {
      try {
        const n = await this.store.countActiveForOwner(ownerScope);
        if (n >= this.maxActivePerOwner) {
          throw new Error(`max concurrent jobs for owner reached (${this.maxActivePerOwner})`);
        }
      } catch (err) {
        // 持久化层故障是基础设施故障，直接抛（调用方 HTTP 层映射成 500 并脱敏）。
        const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), spec.physicalRoots);
        throw new Error(msg);
      }
    }

    const id = newJobId(spec.kind, spec.id);
    const createdAt = nowDate();
    let handle: JobProcessHandle;
    try {
      handle = spec.run();
    } catch (err) {
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), spec.physicalRoots);
      throw new Error(msg);
    }

    const pid = handle.pid ?? null;
    let pgid: number | null = handle.pgid ?? null;
    let startIdentity: string | null = null;
    if (pid !== null) {
      try {
        startIdentity = await this.captureIdentityFn(pid);
      } catch {
        startIdentity = null;
      }
    }

    try {
      await this.store.insert({
        id,
        kind: spec.kind,
        label: spec.label,
        orgId: spec.owner.orgId,
        userId: spec.owner.userId,
        workspaceId: spec.owner.workspaceId,
        runId: spec.owner.runId ?? null,
        outputLimitBytes: spec.outputLimitBytes ?? null,
        pid,
        pgid,
        startIdentity,
        createdAt,
      });
    } catch (err) {
      // 插入失败时尽力取消已起的句柄，避免孤儿泄漏。
      try {
        handle.cancel('store insert failed');
      } catch {
        // ignore
      }
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), spec.physicalRoots);
      throw new Error(msg);
    }

    const buffer = new StreamCursorBuffer(this.maxOutputBytes);
    const entry: LiveEntry = {
      handle,
      owner: spec.owner,
      buffer,
      physicalRoots: [...spec.physicalRoots],
      settled: false,
      settledAt: null,
      spillPaths: new Map(),
    };
    this.lives.set(id, entry);
    // 新作业进来时顺手收一次：不起后台定时器，回收永远发生在有请求的时候。
    this.pruneSettled();

    // 结算钩子：first-wins。
    handle.done
      .then((outcome: JobProcessOutcome) => this.settle(id, ownerScope, outcome, entry))
      .catch(() => {
        // done 按契约不应 reject（生产者吞成 failed），这里兜底。
        void this.settle(
          id,
          ownerScope,
          { status: 'failed', exitCode: null, signal: null, detail: 'process handle rejected' },
          entry,
        );
      });

    const record = await this.store.getById(id, ownerScope);
    if (!record) throw new Error(`job ${id} not found after insert`);
    return toSnapshot(record);
  }

  private async settle(
    id: string,
    owner: JobOwnerScope,
    outcome: JobProcessOutcome,
    entry: LiveEntry,
  ): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;

    // 最后一次把 handle 里的残留输出刷进 buffer（`readOutput` 可能还有没吐的 delta）。
    try {
      const chunk = entry.handle.readOutput?.();
      const text = chunkToText(chunk);
      if (text) entry.buffer.append(text);
      // spill 路径若存在，登记为不透明引用（物理路径绝不进 MySQL）。
      if (chunk?.stdoutSpillPath ?? chunk?.stderrSpillPath) {
        const ref = `spill:${id}:${Date.now()}`;
        const phys = chunk?.stdoutSpillPath ?? chunk?.stderrSpillPath ?? '';
        entry.spillPaths.set(ref, phys);
      }
    } catch {
      // 读取残留输出失败不影响结算。
    }

    const status: JobStatus =
      outcome.status === 'completed' ? 'completed' : outcome.status === 'killed' ? 'killed' : 'failed';
    const detail = outcome.detail ?? (outcome.signal ? `killed: ${outcome.signal}` : outcome.exitCode !== null ? `exit code: ${outcome.exitCode}` : null);

    try {
      await this.store.updateStatus(id, owner, {
        status,
        detail,
        exitCode: outcome.exitCode,
        reported: false,
        finishedAt: nowDate(),
      });
    } catch {
      // 结算写 MySQL 失败：内存里仍标记为 settled，防止重复尝试无限重试；
      // 下一次启动时的 `recoverOrphans` 会把仍为 running 的记录再次标记为终态。
    } finally {
      // 这条 live 条目从此只对 read 有用（buffer 里可能还有没被消费的增量），
      // 句柄本身已经没有进程可控。打上结算时间，交给 `pruneSettled()` 回收——
      // 以前这里只有一句"活句柄用完即丢"的注释，实际什么都没丢：`lives` 里
      // 的条目（子进程句柄 + 最大 500KB 环形缓冲）从进程启动起只增不减。
      entry.settledAt = Date.now();
      this.pruneSettled();
    }
  }

  /**
   * 回收已结算的 live 条目：超过保留窗口的先丢，仍超上限时按结算时间从旧到新
   * 继续丢。**只碰 `settledAt !== null` 的条目**——还在跑的作业永远不动。
   *
   * 不用定时器：那要么阻止进程退出（不 unref），要么在空闲时不触发（unref）。
   * 回收挂在 `start()` 与 `settle()` 上，作业越密集收得越勤，正是需要的。
   */
  private pruneSettled(now: number = Date.now()): void {
    const settled: { id: string; at: number }[] = [];
    for (const [id, entry] of this.lives) {
      if (entry.settledAt === null) continue;
      if (now - entry.settledAt >= this.settledRetentionMs) {
        this.lives.delete(id);
        continue;
      }
      settled.push({ id, at: entry.settledAt });
    }
    if (settled.length <= this.maxSettledEntries) return;
    settled.sort((a, b) => a.at - b.at);
    for (const { id } of settled.slice(0, settled.length - this.maxSettledEntries)) {
      this.lives.delete(id);
    }
  }

  // ── Read ────────────────────────────────────────────────────────────

  async get(id: string, owner: JobOwner): Promise<JobSnapshot> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const live = this.lives.get(id);
    const physicalRoots = live?.physicalRoots ?? [];
    let record: JobRecord | null;
    try {
      record = await requireOwnedRecord(this.store, id, scope);
    } catch (err) {
      if (err instanceof JobNotFoundError) throw err;
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), physicalRoots);
      throw new Error(msg);
    }
    return toSnapshot(record);
  }

  async read(
    id: string,
    owner: JobOwner,
    cursor: string | null | undefined,
    limit: number,
  ): Promise<JobRead> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const live = this.lives.get(id);
    const physicalRoots = live?.physicalRoots ?? [];

    let record: JobRecord;
    try {
      record = await requireOwnedRecord(this.store, id, scope);
    } catch (err) {
      if (err instanceof JobNotFoundError) throw err;
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), physicalRoots);
      throw new Error(msg);
    }

    // 活句柄存在时，先把新增的 delta 刷进 buffer，保证"连续读不重复"的语义
    // 与上游 `ShellProcess.readOutput()` 的"每次 read 都把这次的新输出吐完"
    // 完全一致。
    if (live) {
      try {
        const chunk = live.handle.readOutput?.();
        const text = chunkToText(chunk);
        if (text) live.buffer.append(text);
        if (chunk?.stdoutSpillPath ?? chunk?.stderrSpillPath) {
          const ref = `spill:${id}:${Date.now()}`;
          live.spillPaths.set(ref, chunk?.stdoutSpillPath ?? chunk?.stderrSpillPath ?? '');
        }
      } catch {
        // 读取失败视为无增量，不影响已缓冲的历史数据。
      }
      const cur = cursor ?? INITIAL_CURSOR;
      // 校验游标格式，非法抛 400（与 Python 版 read_stream 同一条映射）。
      try {
        parseCursor(cur);
      } catch (e) {
        const msg = redactPhysicalRoots(e instanceof Error ? e.message : String(e), physicalRoots);
        throw new Error(msg);
      }
      const res = live.buffer.read(cur, limit);
      const snapshot = toSnapshot(record);
      // 若本次读取检测到丢数据（generation 变化），指向最新 spill 引用（若有）。
      let stdoutSpillRef: string | undefined;
      let stderrSpillRef: string | undefined;
      if (res.dropped && live.spillPaths.size > 0) {
        const last = [...live.spillPaths.keys()].pop();
        stdoutSpillRef = last;
      }
      return {
        text: res.data,
        lossy: res.dropped || res.truncated,
        cursor: res.cursor,
        nextCursor: res.nextCursor,
        truncated: res.truncated,
        logTotal: res.logTotal,
        stdoutSpillRef,
        stderrSpillRef,
        snapshot,
      };
    }

    // 无活句柄（已结束或 Worker 重启后）：buffer 也不在内存，退化成快照
    // 的终态信息，`text` 为空但 `lossy` 标记为 false——历史上已缓冲的增量
    // 在重启后确实丢了，但这时已经没有办法把物理 spill 路径找回来（重启
    // 前的 `spillPaths` 映射已随进程内存一起丢失），所以这里诚实地返回
    // "没有增量"，而不是编造一个指向已不存在文件的引用。
    try {
      if (cursor !== null && cursor !== undefined && cursor !== '') parseCursor(cursor);
    } catch (e) {
      const msg = redactPhysicalRoots(e instanceof Error ? e.message : String(e), physicalRoots);
      throw new Error(msg);
    }
    return {
      text: '',
      lossy: false,
      cursor: cursor || INITIAL_CURSOR,
      nextCursor: cursor || INITIAL_CURSOR,
      truncated: false,
      logTotal: 0,
      snapshot: toSnapshot(record),
    };
  }

  // ── Signal / Kill / Stdin ───────────────────────────────────────────

  async kill(id: string, owner: JobOwner): Promise<JobSnapshot> {
    return this.signalInternal(id, owner, 'SIGTERM');
  }

  async signal(id: string, owner: JobOwner, sig: NodeJS.Signals): Promise<JobSnapshot> {
    return this.signalInternal(id, owner, sig);
  }

  private async signalInternal(id: string, owner: JobOwner, signal: NodeJS.Signals): Promise<JobSnapshot> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const live = this.lives.get(id);
    if (!live) {
      // 没有活句柄时不拿存档里的 pid 去裸发信号（见 job-owner-access.ts 的注释）。
      // 区分"不存在/不属于你"和"没有活句柄"两种失败，调用方据此给不同的 HTTP 状态。
      try {
        await requireOwnedRecord(this.store, id, scope);
      } catch (err) {
        if (err instanceof JobNotFoundError) throw err;
        throw err;
      }
      const { JobControlUnavailableError } = await import('./job-owner-access.js');
      throw new JobControlUnavailableError(id);
    }
    if (!sameOwnerInternal(live.owner, owner)) {
      throw new JobNotFoundError(id);
    }
    const physicalRoots = live.physicalRoots;

    // 有活句柄时优先走句柄自己的 cancel（它懂自己是怎么起的——bwrap 进程组、
    // namespace init 等），这与 Python 版 `Popen.terminate()` + 进程组语义
    // 对齐，比裸 `process.kill(pid)` 更精确。
    try {
      live.handle.cancel(`signal ${signal}`);
    } catch (err) {
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), physicalRoots);
      throw new Error(msg);
    }

    // 同时尝试按身份验证的安全信号（防 PID 复用），作为句柄 cancel 的补充
    // 防线——句柄 cancel 本身可能因为 bwrap 已经退出了而不再有效。
    const rec = await this.store.getById(id, scope);
    if (rec?.pid) {
      await safeSignalIdentity({ pid: rec.pid, pgid: rec.pgid, startIdentity: rec.startIdentity, signal }).catch(() => {});
    }

    try {
      await this.store.updateStatus(id, scope, { status: 'stopping', detail: `signal ${signal}` });
    } catch {
      // 更新为 stopping 失败不阻塞信号本身。
    }

    const after = await this.store.getById(id, scope);
    if (!after) throw new JobNotFoundError(id);
    return toSnapshot(after);
  }

  async writeStdin(id: string, owner: JobOwner, data: string, eof: boolean): Promise<void> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const live = this.lives.get(id);
    if (!live) {
      try {
        await requireOwnedRecord(this.store, id, scope);
      } catch (err) {
        if (err instanceof JobNotFoundError) throw err;
        throw err;
      }
      const { JobControlUnavailableError } = await import('./job-owner-access.js');
      throw new JobControlUnavailableError(id);
    }
    if (!sameOwnerInternal(live.owner, owner)) throw new JobNotFoundError(id);
    if (!live.handle.writeStdin) {
      throw new Error(`job ${id} does not support stdin`);
    }
    try {
      live.handle.writeStdin(data, eof);
    } catch (err) {
      const msg = redactPhysicalRoots(err instanceof Error ? err.message : String(err), live.physicalRoots);
      throw new Error(msg);
    }
  }

  // ── List ────────────────────────────────────────────────────────────

  async list(owner: JobOwner, limit = 100): Promise<JobSnapshot[]> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const rows = await this.store.listByOwner(scope, limit);
    return rows.map(toSnapshot);
  }

  async listByRun(runId: string, owner: JobOwner, limit = 100): Promise<JobSnapshot[]> {
    const scope: JobOwnerScope = { orgId: owner.orgId, userId: owner.userId, workspaceId: owner.workspaceId };
    const rows = await this.store.listByRun(runId, scope, limit);
    return rows.map(toSnapshot);
  }

  // ── Orphan recovery ────────────────────────────────────────────────

  /**
   * 启动期调用（用户路由挂载之前）。遍历 `running`/`stopping` 记录，
   * 逐个验证"这个 pid 是否还是当初登记的那个进程"，不是则标记为 `killed`。
   * 返回本次回收的条数。
   */
  async recoverOrphans(): Promise<number> {
    const actives = await this.store.listActiveForRecovery(1000);
    let recovered = 0;
    for (const rec of actives) {
      const scope: JobOwnerScope = { orgId: rec.orgId, userId: rec.userId, workspaceId: rec.workspaceId };
      const live = this.lives.get(rec.id);
      // 本进程内还有活句柄的，无需回收——它会在稍后通过 done 正常结算
      //（first-wins 保证回收与正常结算不会双写）。
      if (live && !live.settled) continue;

      const stillSame = rec.pid ? await identityMatches(rec.pid, rec.startIdentity) : false;
      if (stillSame) {
        // pid 仍指向同一进程：尝试优雅终止（先 TERM，身份仍匹配再 KILL），
        // 与 Python 版 `terminate_process_group` 的两级升级一致。
        if (rec.pid) {
          const term = await safeSignalIdentity({ pid: rec.pid, pgid: rec.pgid, startIdentity: rec.startIdentity, signal: 'SIGTERM' });
          if (term.signaled) {
            // 给一个极短的宽限期（50ms）让 TERM 生效，再决定是否升级。
            await new Promise((r) => setTimeout(r, 50));
            const still = await identityMatches(rec.pid!, rec.startIdentity);
            if (still) {
              await safeSignalIdentity({ pid: rec.pid!, pgid: rec.pgid, startIdentity: rec.startIdentity, signal: 'SIGKILL' }).catch(() => {});
            }
          }
        }
        // 即便信号链全部成功，DB 行仍标记为 killed（"孤儿：Worker 重启"），
        // 因为这条记录已经没有活句柄可以再次正常结算了。
      }

      try {
        await this.store.updateStatus(rec.id, scope, {
          status: 'killed',
          detail: 'orphaned: worker restarted',
          exitCode: null,
          reported: false,
          finishedAt: nowDate(),
        });
        recovered += 1;
      } catch {
        // 单条标记失败不影响其它条。
      }
    }
    return recovered;
  }

  /** 仅测试用：当前内存里的 live 条目数（含尚未回收的已结算条目）。 */
  liveEntryCount(): number {
    return this.lives.size;
  }

  /**
   * 仅测试用：把物理 spill 引用换回物理路径（owner 校验过的）。
   * 生产的 HTTP 下载端点应通过它拿到真实路径后，再做一次路径归属检查
   * 才发送文件内容。
   */
  resolveSpillPath(id: string, owner: JobOwner, spillRef: string): string | null {
    const live = this.lives.get(id);
    if (!live || !sameOwnerInternal(live.owner, owner)) return null;
    return live.spillPaths.get(spillRef) ?? null;
  }
}

function sameOwnerInternal(a: JobOwner, b: JobOwner): boolean {
  return a.orgId === b.orgId && a.userId === b.userId && a.workspaceId === b.workspaceId;
}
