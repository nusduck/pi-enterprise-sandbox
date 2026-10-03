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
 * 与已退役的 Python 执行面（旧 `sandbox/services/process_manager.py`，现按职责拆到本目录各模块）1733 行的关系：
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
  DEFAULT_PERSIST_MIN_INTERVAL_MS,
  FileJobOutputStore,
  MAX_PERSIST_INTERVAL_MS,
} from './job-output-store.js';
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

/**
 * 终止类信号：语义是结束作业，走活句柄 `cancel()` + `stopping`。
 * 非终止信号（允许集里的 SIGINT / SIGHUP 等）只经 `safeSignalIdentity`
 * 投递，不结束作业、不改状态。允许集由公共路由的 `ALLOWED_SIGNALS`
 * 限定，这里不扩大它，只按种类决定行为。
 */
const TERMINATING_SIGNALS: ReadonlySet<string> = new Set(['SIGTERM', 'SIGKILL', 'SIGQUIT']);

function isTerminatingSignal(signal: NodeJS.Signals): boolean {
  return TERMINATING_SIGNALS.has(signal);
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
  // 上次落盘时刻（毫秒，`Date.now()`）。`read()` 触发的落盘按
  // `persistMinIntervalMs` 节流；后台定时器走强制落盘（见
  // `startLivePersistTimer`，输出不变时直接跳过、不调写盘）。
  lastPersistAt: number;
  // 上次落盘覆盖到的 buffer 总量（`snapshotState().total`，单调递增）。
  // 定时器靠它判断"自上次落盘以来有没有新输出"，没有就不写盘。
  lastPersistedTotal: number;
  // 同一个作业落盘的串行链：定时器每次 tick 都链到它后面，保证同一时刻
  // 只有一个落盘在飞，不能重入；链永不 reject（内部已吞错）。
  persistChain: Promise<void>;
  // 运行中定时落盘的句柄（仅启用 outputStore 时存在，已 `.unref()`）。
  // `settle()` 时先清（最终强制落盘之前，避免并发写）；回收/丢弃条目时也清。
  timer: NodeJS.Timeout | undefined;
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
  /**
   * 作业输出落盘目录（生产装配传 `<controlRoot>/job-output`，见
   * `job-output-store.ts`）。省略则不持久化——无 live 条目时的 `read()`
   * 保持旧语义（空文本、`lossy=false`），只供旧单测使用。
   */
  readonly jobOutputDir?: string | null | undefined;
  /**
   * 运行中落盘节流下限（毫秒），默认 1000。钳在 `[0, 2000]`：
   * 运行中允许丢失最近一个落盘间隔的数据，但间隔有界；结算是强制落盘，
   * 不受它限制。为 0 时后台定时器的周期取默认值（1000，不能 0 间隔空转）。
   */
  readonly persistMinIntervalMs?: number;
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
  private readonly outputStore: FileJobOutputStore | null;
  private readonly persistMinIntervalMs: number;
  /**
   * 工作区 GC 已删过落盘文件的作业 id（内存集合，重启即失）。
   * 作用是关掉一个竞态：`DELETE /sessions/:id` 先 `kill()` 再删文件，
   * 被杀作业的 `settle()` 是异步的，可能在删文件之后才落"最终窗口"、
   * 把刚删的文件重建回来。集合里的 id 不再落盘。`start()` 遇到同名 id
   * 会把它移出集合（新作业、新输出，不继承删除标记）。
   */
  private readonly purgedOutput = new Set<string>();
  private readonly captureIdentityFn: (pid: number) => Promise<string | null>;

  constructor(store: JobStore, options: JobRegistryOptions = {}) {
    this.store = store;
    this.maxActivePerOwner = Math.max(0, options.maxActivePerOwner ?? DEFAULT_MAX_ACTIVE_PER_OWNER);
    this.maxOutputBytes = Math.max(1, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);
    this.settledRetentionMs = Math.max(0, options.settledRetentionMs ?? DEFAULT_SETTLED_RETENTION_MS);
    this.maxSettledEntries = Math.max(0, options.maxSettledEntries ?? DEFAULT_MAX_SETTLED_ENTRIES);
    this.persistMinIntervalMs = Math.min(
      MAX_PERSIST_INTERVAL_MS,
      Math.max(0, options.persistMinIntervalMs ?? DEFAULT_PERSIST_MIN_INTERVAL_MS),
    );
    this.outputStore =
      options.jobOutputDir === undefined || options.jobOutputDir === null
        ? null
        : new FileJobOutputStore(options.jobOutputDir, { maxBytes: this.maxOutputBytes });
    this.captureIdentityFn = options.captureIdentity ?? ((pid) => captureStartIdentity(pid));
  }

  /**
   * 从活句柄拉取增量并搬进 buffer（`handle.readOutput()` → `append` → 登记
   * spill 引用）。`read()`、`settle()`、后台定时器三处共用——不要复制。
   * 同步、永不抛错：拉取失败视为无增量，不影响已缓冲的历史数据。
   */
  private drainHandle(id: string, entry: LiveEntry): void {
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
      // 读取失败视为无增量，不影响已缓冲的历史数据。
    }
  }

  /**
   * 把一个 live 条目的保留窗口落盘。best-effort 永不抛错
   * （`FileJobOutputStore.save` 内部已吞错记 warn）。
   * `force=false` 时按 `persistMinIntervalMs` 节流；定时器与结算路径传 `true`。
   */
  private async persistLiveOutput(id: string, entry: LiveEntry, force: boolean): Promise<void> {
    if (this.outputStore === null) return;
    // 工作区 GC 删过的输出不再重建（见 `purgedOutput` 的注释）。
    if (this.purgedOutput.has(id)) return;
    if (!force) {
      const now = Date.now();
      if (now - entry.lastPersistAt < this.persistMinIntervalMs) return;
      entry.lastPersistAt = now;
    } else {
      entry.lastPersistAt = Date.now();
    }
    // 快照与取窗口文本之间无 await：单线程下两者是原子的，落盘内容与标量一致。
    const state = entry.buffer.snapshotState();
    await this.outputStore.save(id, state, entry.buffer.snapshotText(), entry.physicalRoots);
    // 记这次落盘覆盖到的 total：写盘期间并发 append 的新数据（total 更大）
    // 会使下一次检查判定为"有变化"，不会被误判为已落盘。
    entry.lastPersistedTotal = state.total;
  }

  /**
   * 起运行中定时落盘（仅启用 outputStore 时由 `start()` 调用）。
   *
   * 为什么需要它：输出只积在 `process-runner` 的 tracker 里，`read()` 之前
   * buffer 是空的——从不被 read 的运行中作业在结算前一个字节都不会落盘，
   * exec 重启会全丢。定时器每拍先 `drainHandle` 再看 total 有没有变化，
   * 有才强制落盘，所以"运行中最多丢最近一个落盘间隔（≤2s）"。
   */
  private startLivePersistTimer(id: string, entry: LiveEntry): void {
    if (this.outputStore === null) return;
    // 为 0 时用默认值，不能 0 间隔空转。
    const period =
      this.persistMinIntervalMs > 0 ? this.persistMinIntervalMs : DEFAULT_PERSIST_MIN_INTERVAL_MS;
    const timer = setInterval(() => {
      // 先 drain 再看 total：输出不变就不写盘。tick 内全部吞错（链永不 reject）。
      void this.enqueuePersist(id, entry, true, true);
    }, period);
    // 不阻止进程退出：exec 是常驻服务，但单测 / 嵌入式使用不能被它卡住。
    timer.unref();
    entry.timer = timer;
  }

  /**
   * 把一次落盘排进该作业的串行链并等它完成。read() / 定时器 / settle() 的写盘
   * 都必须走这里：它们写同一组 `.tmp` 再 rename，并发会让 log 与 meta 来自
   * 不同快照（恢复时按损坏处理）。链永不 reject。
   */
  private enqueuePersist(id: string, entry: LiveEntry, force: boolean, drainFirst = false): Promise<void> {
    entry.persistChain = entry.persistChain
      .then(async () => {
        if (drainFirst) this.drainHandle(id, entry);
        if (force && entry.buffer.snapshotState().total === entry.lastPersistedTotal && entry.lastPersistAt !== 0) return;
        await this.persistLiveOutput(id, entry, force);
      })
      .catch(() => {});
    return entry.persistChain;
  }

  /** 清定时器（settle / 回收 / 丢弃前调用，幂等）。 */
  private clearLiveTimer(entry: LiveEntry): void {
    if (entry.timer !== undefined) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
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
    // 同名 id 复用（Agent 预留 id）时清除旧的 GC 删除标记——新作业配新输出。
    this.purgedOutput.delete(id);
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
      lastPersistAt: 0,
      lastPersistedTotal: 0,
      persistChain: Promise.resolve(),
      timer: undefined,
      spillPaths: new Map(),
    };
    // 同名 id 复用（Agent 预留 id）时旧条目即被丢弃：先清它的定时器。
    const prev = this.lives.get(id);
    if (prev !== undefined) this.clearLiveTimer(prev);
    this.lives.set(id, entry);
    // 只有启用落盘才起定时器：从不被 read 的运行中作业也最多丢最近一个间隔。
    this.startLivePersistTimer(id, entry);
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

    // 先停定时器（最终强制落盘之前），再等它手里那一次落盘结束——
    // 之后本函数是唯一的写盘者，与定时器没有并发写。
    this.clearLiveTimer(entry);

    // 最后一次把 handle 里的残留输出刷进 buffer，并强制落盘（排在已在飞的
    // 落盘之后，`await` 的）：作业结束后的最终窗口一定完整，这是"结束 5 分钟后 /
    // exec 重启后还能读"的前提。best-effort，不影响结算。
    entry.lastPersistAt = 0;
    await this.enqueuePersist(id, entry, true, true);

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
   * 回收不用定时器（落盘定时器见 `startLivePersistTimer`，两码事）：回收挂在
   * `start()` 与 `settle()` 上，作业越密集收得越勤，正是需要的。
   */
  private pruneSettled(now: number = Date.now()): void {
    const settled: { id: string; at: number }[] = [];
    for (const [id, entry] of this.lives) {
      if (entry.settledAt === null) continue;
      if (now - entry.settledAt >= this.settledRetentionMs) {
        this.clearLiveTimer(entry);
        this.lives.delete(id);
        continue;
      }
      settled.push({ id, at: entry.settledAt });
    }
    if (settled.length <= this.maxSettledEntries) return;
    settled.sort((a, b) => a.at - b.at);
    for (const { id } of settled.slice(0, settled.length - this.maxSettledEntries)) {
      const entry = this.lives.get(id);
      if (entry !== undefined) this.clearLiveTimer(entry);
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
      this.drainHandle(id, live);
      // 读触发的节流落盘保留（不交给定时器，二选一的决定）：交互式读之后
      // 调用方往往立刻取结果，定时器下一拍最多晚一个间隔；两者共用
      // drainHandle 与 lastPersistAt/lastPersistedTotal 节流，读得再频繁
      // 也不会多写盘。从不 read 的作业由后台定时器兜底（见
      // `startLivePersistTimer`），这里只是让"读过"的作业 fresher。
      await this.enqueuePersist(id, live, false);
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

    // 无活句柄（已结算被回收，或 Worker 重启后）：先试落盘恢复——从文件重建
    // 一个只读缓冲，游标语义与落盘前完全一致（generation / dropped 判定只
    // 依赖快照标量与窗口字节，见 `job-cursor.ts` 的 `restore()`）。
    // 文件缺失或损坏时诚实地报 `outputUnavailable: true` + `lossy: true`，
    // 调用方得以区分"确实没有新输出"和"输出已经丢了"。
    if (this.outputStore !== null) {
      const loaded = await this.outputStore.load(id, this.maxOutputBytes);
      if (loaded.ok) {
        const cur = cursor ?? INITIAL_CURSOR;
        try {
          parseCursor(cur);
        } catch (e) {
          const msg = redactPhysicalRoots(e instanceof Error ? e.message : String(e), physicalRoots);
          throw new Error(msg);
        }
        const res = loaded.buffer.read(cur, limit);
        return {
          text: res.data,
          lossy: res.dropped || res.truncated,
          cursor: res.cursor,
          nextCursor: res.nextCursor,
          truncated: res.truncated,
          logTotal: res.logTotal,
          snapshot: toSnapshot(record),
        };
      }
      try {
        if (cursor !== null && cursor !== undefined && cursor !== '') parseCursor(cursor);
      } catch (e) {
        const msg = redactPhysicalRoots(e instanceof Error ? e.message : String(e), physicalRoots);
        throw new Error(msg);
      }
      return {
        text: '',
        lossy: true,
        outputUnavailable: true,
        cursor: cursor || INITIAL_CURSOR,
        nextCursor: cursor || INITIAL_CURSOR,
        truncated: false,
        logTotal: 0,
        snapshot: toSnapshot(record),
      };
    }

    // 未配置落盘时的旧语义（只供旧单测）：buffer 也不在内存，退化成快照
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

    if (!isTerminatingSignal(signal)) {
      // 非终止信号：只经按身份验证的安全信号（防 PID 复用）发给进程组，
      // 不调用活句柄 `cancel()`、不改作业状态。没有活句柄时的
      // `JobControlUnavailableError` 已在函数入口处理，与原来一致。
      const rec = await this.store.getById(id, scope);
      if (rec?.pid) {
        await safeSignalIdentity({ pid: rec.pid, pgid: rec.pgid, startIdentity: rec.startIdentity, signal }).catch(() => {});
      }
      const current = await this.store.getById(id, scope);
      if (!current) throw new JobNotFoundError(id);
      return toSnapshot(current);
    }

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

  /**
   * 删一个工作区全部作业的落盘输出（工作区 GC 用）。
   *
   * 作业 id 只从持久化账本（`store.listByOwner`，生产即 MySQL）里取，
   * **不按目录名猜**：目录里有什么文件不代表是谁的，反过来账本删了的行
   * 对应的文件也不在这里碰（那是"账本有、文件无"的缺失路径，`read()` 已
   * 按 `outputUnavailable` 处理）。best-effort 永不抛错，返回尝试删除数。
   */
  async deleteJobOutputsForOwner(owner: JobOwnerScope): Promise<number> {
    if (this.outputStore === null) return 0;
    let ids: string[];
    try {
      ids = (await this.store.listByOwner(owner, 10_000)).map((row) => row.id);
    } catch {
      return 0;
    }
    const n = await this.outputStore.deleteMany(ids);
    // 记住删除标记，关掉 kill→settle 异步重建的竞态（见 `purgedOutput` 注释）。
    // 集合只增不查、无定时清理，钳在 4096——工作区 GC 本来就是低频操作。
    for (const id of ids) this.purgedOutput.add(id);
    while (this.purgedOutput.size > 4096) {
      const oldest = this.purgedOutput.values().next();
      if (oldest.done) break;
      this.purgedOutput.delete(oldest.value);
    }
    return n;
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
