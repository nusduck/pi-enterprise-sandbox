/**
 * 子进程磁盘监控——移植自 Python 版
 * `sandbox/services/child_workspace_quota.py`。
 *
 * 背景（原样保留自 Python 版模块级注释）：API 的文件/数据集路径走
 * `quota-ledger.ts` 那套控制面账本；但 `bash`/`python` 这些托管子进程直接
 * 往工作区绑定里写，只受 `RLIMIT_FSIZE`（单文件大小上限）约束——用大量小
 * 文件就能把磁盘写满而不触发那条限制。
 *
 * 这不是硬性的多租户磁盘隔离边界，是**纵深防御的监控**：
 *   - 有界的树测量（entry/inode 上限 + 出错即 fail-closed）
 *   - 准入检查 + 周期采样器，超配额或测量失败都会 kill/fail 子进程
 *   - 生产环境不能在配额为正数时只靠这层监控——还需要运维方在外部资源上
 *     （卷配额/项目配额）断言硬配额，这条闸门由启动配置校验负责，不在这
 *     个文件的范围内（对应 Python 版 `validate_production_settings()`；
 *     那是配置层，不属于"工作区管理、配额与路径"这个任务边界）。
 *
 * 硬字节总量需要 OS 项目/XFS/卷配额，这个进程管不到。
 *
 * **移植时发现的 Python 物理路径泄漏 bug（写进报告）**：
 * `measure_tree_bounded()` 把底层 `OSError` 的 `str(exc)` 原样拼进
 * `ChildQuotaMeasureError.message`（例如 `f"workspace root inaccessible:
 * {exc}"`），而 Python 的 `OSError.__str__()` 通常包含出错的物理路径
 * （`[Errno 13] Permission denied: '/var/sandbox/workspaces/...'`）。这条
 * 消息经 `format_decision_message()` 直接进了 `sandbox/services/
 * process_manager.py:544` 和 `execution_manager.py:273/361` 的 API 响应体
 * `error` 字段——**没有经过 `sanitize_path_error()`**，是一个真实的物理路径
 * 泄漏点。这里的 `measureTreeBounded()` 对**任何**离开这个函数的错误消息都
 * 无条件用 `redactPhysicalRoots()` 脱敏（脱敏对象至少是被扫描的 `root`
 * 本身——它的任何子路径都以它为前缀，脱敏后不会残留），不是"调用方传了
 * 物理根才脱敏"的可选项，硬约束 #1 的字面要求。
 */
import { opendir, stat } from 'node:fs/promises';
import path from 'node:path';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { QuotaStore } from './quota-store.js';

const MIN_SAMPLE_INTERVAL_S = 0.5;
const DEFAULT_SAMPLE_INTERVAL_S = 2.0;
const DEFAULT_MAX_ENTRIES = 100_000;

export const CODE_QUOTA_EXCEEDED = 'workspace_quota_exceeded';
export const CODE_INODE_LIMIT = 'workspace_inode_limit_exceeded';
export const CODE_ENFORCEMENT_FAILED = 'workspace_quota_enforcement_failed';

export class ChildQuotaMeasureError extends Error {
  override readonly name = 'ChildQuotaMeasureError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BoundedTreeMeasure {
  readonly sizeBytes: number;
  readonly entries: number;
}

export interface QuotaUsage {
  readonly workspaceBytes: number;
  readonly tempBytes: number;
  readonly reservedBytes: number;
  readonly quotaBytes: number;
  readonly tempQuotaBytes: number;
  readonly workspaceEntries: number;
  readonly tempEntries: number;
}

export function isWorkspaceOver(usage: QuotaUsage): boolean {
  return usage.quotaBytes > 0 && usage.workspaceBytes + usage.reservedBytes > usage.quotaBytes;
}

export function isTempOver(usage: QuotaUsage): boolean {
  return usage.tempQuotaBytes > 0 && usage.tempBytes > usage.tempQuotaBytes;
}

export interface ChildQuotaDecision {
  readonly allow: boolean;
  readonly code?: string;
  readonly message: string;
  readonly usage?: QuotaUsage;
}

/** `evaluateChildQuota()` / `ChildWorkspaceQuotaWatch` 需要的配置——对应
 * Python 版散落在 `settings.workspace_*` 上的字段，这里显式聚合成一个值
 * 对象而不是读全局单例：exec/src 目前没有共享的 `config.ts`（W2-C 范围内
 * 不新建一个），调用方（main.ts / http 层，均不在本任务范围）负责从环境
 * 变量组装这个对象再传进来。 */
export interface ChildQuotaConfig {
  readonly enforcement: boolean;
  readonly workspaceQuotaMb: number;
  readonly tempQuotaMb: number;
  readonly maxEntries?: number;
  readonly sampleIntervalS?: number;
}

function quotaBytesFromMb(mb: number): number {
  return Math.max(0, Math.trunc(mb)) * 1024 * 1024;
}

function maxEntriesOf(config: ChildQuotaConfig): number {
  return Math.max(1, config.maxEntries ?? DEFAULT_MAX_ENTRIES);
}

/**
 * 有界递归测量一棵物理目录树的大小与 entry 数（fail-closed）。
 *
 * - 每一个目录项（文件/目录/符号链接）都计入 `maxEntries`，零字节的 inode
 *   洪水攻击一样会触发上限。
 * - 遍历目录**从不**跟随符号链接（与 Python 版 `os.scandir` 默认行为一致，
 *   `Dirent`/`Stats` 的 `isSymbolicLink()`/`isDirectory()` 判断都基于
 *   `lstat`，不穿透）。
 * - 常规文件大小来自 `lstat`（符号链接本身的大小不算作目标大小）。
 * - 任何意外错误 → `workspace_quota_enforcement_failed`。
 * - 撞到 entry 上限 → `workspace_inode_limit_exceeded`（立即停止扫描，
 *   不再继续往下数）。
 */
export async function measureTreeBounded(
  root: string,
  maxEntries: number,
): Promise<BoundedTreeMeasure> {
  if (maxEntries < 1) {
    throw new ChildQuotaMeasureError(CODE_ENFORCEMENT_FAILED, 'invalid max entries');
  }

  try {
    await stat(root);
  } catch (err) {
    if (isEnoent(err)) {
      return { sizeBytes: 0, entries: 0 };
    }
    throw new ChildQuotaMeasureError(
      CODE_ENFORCEMENT_FAILED,
      redactPhysicalRoots(`workspace root inaccessible: ${describeError(err)}`, [root]),
    );
  }

  let total = 0;
  let entries = 0;
  const stack: string[] = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    let dir;
    try {
      dir = await opendir(current);
    } catch (err) {
      throw new ChildQuotaMeasureError(
        CODE_ENFORCEMENT_FAILED,
        redactPhysicalRoots(`scandir failed during quota measure: ${describeError(err)}`, [root]),
      );
    }
    try {
      for await (const dirent of dir) {
        entries += 1;
        if (entries > maxEntries) {
          throw new ChildQuotaMeasureError(
            CODE_INODE_LIMIT,
            `workspace tree entry limit exceeded (${maxEntries} entries); refusing unbounded scan`,
          );
        }
        const full = path.join(current, dirent.name);
        if (dirent.isSymbolicLink()) {
          // 计入 entry，不跟随。
          continue;
        }
        if (dirent.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (dirent.isFile()) {
          try {
            const st = await stat(full);
            total += st.size;
          } catch (err) {
            throw new ChildQuotaMeasureError(
              CODE_ENFORCEMENT_FAILED,
              redactPhysicalRoots(`stat failed during quota measure: ${describeError(err)}`, [root]),
            );
          }
        }
        // 其它特殊文件：计入 entry，不计大小——与 Python 版一致。
      }
    } finally {
      await dir.close().catch(() => undefined);
    }
  }

  return { sizeBytes: total, entries };
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MeasureUsageDeps {
  readonly quotaStore: QuotaStore;
}

export interface MeasureUsageOptions {
  readonly workspaceId?: string;
  readonly reservedBytes?: number;
  readonly maxEntries?: number;
}

/** 测量 workspace + temp 两棵树的用量。两棵树共享一份 `maxEntries` 预算——
 * 先给 workspace 一半，剩下的（至少 1）留给 temp，任一棵洪水攻击都会被
 * 限住，不会因为先扫的那棵吃满预算就让另一棵无限扫描。 */
export async function measureChildQuotaUsage(
  workspacePath: string,
  tempPath: string | null,
  config: ChildQuotaConfig,
  deps: MeasureUsageDeps,
  opts: MeasureUsageOptions = {},
): Promise<QuotaUsage> {
  const limit = opts.maxEntries ?? maxEntriesOf(config);
  const half = tempPath ? Math.max(1, Math.floor(limit / 2)) : limit;

  const ws = await measureTreeBounded(workspacePath, tempPath ? half : limit);
  const tmp = tempPath
    ? await measureTreeBounded(tempPath, Math.max(1, limit - ws.entries))
    : { sizeBytes: 0, entries: 0 };

  let reserved = opts.reservedBytes ?? 0;
  if (opts.reservedBytes === undefined && opts.workspaceId) {
    try {
      reserved = await deps.quotaStore.sumReserved(opts.workspaceId);
    } catch (err) {
      throw new ChildQuotaMeasureError(
        CODE_ENFORCEMENT_FAILED,
        redactPhysicalRoots(`reservation sum failed: ${describeError(err)}`, [
          workspacePath,
          ...(tempPath ? [tempPath] : []),
        ]),
      );
    }
  }
  reserved = Math.max(0, reserved);

  return {
    workspaceBytes: ws.sizeBytes,
    tempBytes: tmp.sizeBytes,
    reservedBytes: reserved,
    quotaBytes: quotaBytesFromMb(config.workspaceQuotaMb),
    tempQuotaBytes: quotaBytesFromMb(config.tempQuotaMb),
    workspaceEntries: ws.entries,
    tempEntries: tmp.entries,
  };
}

/** 单次判定（准入检查或周期采样共用）。测量失败一律 fail-closed
 * （`allow: false`），不是"发生错误就默认放行"。 */
export async function evaluateChildQuota(
  workspacePath: string,
  tempPath: string | null,
  config: ChildQuotaConfig,
  deps: MeasureUsageDeps,
  opts: MeasureUsageOptions = {},
): Promise<ChildQuotaDecision> {
  if (!config.enforcement) {
    return { allow: true, message: 'monitoring disabled' };
  }
  if (config.workspaceQuotaMb <= 0 && config.tempQuotaMb <= 0) {
    return { allow: true, message: 'no positive quota configured' };
  }

  let usage: QuotaUsage;
  try {
    usage = await measureChildQuotaUsage(workspacePath, tempPath, config, deps, opts);
  } catch (err) {
    if (err instanceof ChildQuotaMeasureError) {
      return { allow: false, code: err.code, message: err.message };
    }
    return {
      allow: false,
      code: CODE_ENFORCEMENT_FAILED,
      message: redactPhysicalRoots(`quota measure failed: ${describeError(err)}`, [
        workspacePath,
        ...(tempPath ? [tempPath] : []),
      ]),
    };
  }

  if (isWorkspaceOver(usage) || isTempOver(usage)) {
    return {
      allow: false,
      code: CODE_QUOTA_EXCEEDED,
      message: formatQuotaExceededMessage(usage),
      usage,
    };
  }
  return { allow: true, message: '', usage };
}

export function formatQuotaExceededMessage(usage: QuotaUsage): string {
  const parts: string[] = [];
  if (isWorkspaceOver(usage)) {
    parts.push(
      `workspace ${usage.workspaceBytes}+reserved ${usage.reservedBytes} > quota ${usage.quotaBytes}`,
    );
  }
  if (isTempOver(usage)) {
    parts.push(`temp ${usage.tempBytes} > quota ${usage.tempQuotaBytes}`);
  }
  return `Workspace quota exceeded by child process: ${parts.join('; ')}`;
}

/**
 * 后台**监控**采样器（不是硬磁盘配额）。`onViolation` 在超配额**或**测量
 * 失败 fail-closed 时最多调用一次。
 *
 * 与 Python 版 `threading.Thread` + `Event.wait()` 的差异：这里用递归
 * `setTimeout` 调度而不是 `setInterval`，保证"当前这次判定跑完之前不会
 * 叠加下一次"——`evaluate` 是异步的，`setInterval` 在判定耗时超过采样间隔
 * 时会并发触发多次判定，Python 的 `while not self._stop.wait(interval)`
 * 循环天然不会有这个问题（判定和等待是同一个线程里严格顺序的两步），这里
 * 用"判定完再排下一次"复现同样的顺序保证。
 */
export class ChildWorkspaceQuotaWatch {
  private readonly workspacePath: string;
  private readonly tempPath: string | null;
  private readonly workspaceId: string | null;
  private readonly config: ChildQuotaConfig;
  private readonly deps: MeasureUsageDeps;
  private readonly onViolation: ((decision: ChildQuotaDecision) => void) | undefined;
  private readonly intervalMs: number;

  private stopped = false;
  private tripped = false;
  private lastDecision: ChildQuotaDecision | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(opts: {
    readonly workspacePath: string;
    readonly tempPath: string | null;
    readonly workspaceId: string | null;
    readonly config: ChildQuotaConfig;
    readonly deps: MeasureUsageDeps;
    readonly onViolation?: (decision: ChildQuotaDecision) => void;
    readonly sampleIntervalS?: number;
  }) {
    this.workspacePath = opts.workspacePath;
    this.tempPath = opts.tempPath;
    this.workspaceId = opts.workspaceId;
    this.config = opts.config;
    this.deps = opts.deps;
    this.onViolation = opts.onViolation;
    const interval = opts.sampleIntervalS ?? opts.config.sampleIntervalS ?? DEFAULT_SAMPLE_INTERVAL_S;
    this.intervalMs = Math.max(MIN_SAMPLE_INTERVAL_S, interval) * 1000;
  }

  get exceeded(): boolean {
    return this.tripped;
  }

  get lastDecisionSeen(): ChildQuotaDecision | undefined {
    return this.lastDecision;
  }

  start(): void {
    if (!this.config.enforcement) return;
    if (this.config.workspaceQuotaMb <= 0 && this.config.tempQuotaMb <= 0) return;
    if (this.timer !== undefined || this.running !== undefined) return;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        if (!this.stopped && !this.tripped) this.scheduleNext();
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.tripped) return;
    const decision = await evaluateChildQuota(
      this.workspacePath,
      this.tempPath,
      this.config,
      this.deps,
      // `exactOptionalPropertyTypes` 下不能显式赋 `undefined`，没有 workspaceId
      // 时整个 key 都不出现在对象里，而不是出现且值为 undefined。
      this.workspaceId !== null ? { workspaceId: this.workspaceId } : {},
    );
    if (decision.allow || this.tripped) return;
    this.tripped = true;
    this.lastDecision = decision;
    try {
      this.onViolation?.(decision);
    } catch {
      // 与 Python 版一致：回调异常不应该打断监控器本身的收尾。
    }
  }

  /** 停止采样；等待当前正在跑的一轮判定收尾，超时不强等（对应 Python 版
   * `thread.join(timeout)`，这里默认给 2 秒，调用方可覆盖）。 */
  async stop(timeoutMs = 2000): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.running !== undefined) {
      await Promise.race([this.running, delay(timeoutMs)]);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
