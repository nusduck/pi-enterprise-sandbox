/**
 * 作业输出落盘——`<controlRoot>/job-output/<jobId>.log` + 边车元数据。
 *
 * 这是什么：`MySqlJobRegistry` 的内存环形缓冲（`job-cursor.ts`）只活在进程
 * 内存里，结算后 live 条目最多保留 5 分钟 / 512 条，exec 重启后全丢。本模块
 * 把每个作业的保留窗口同时写进 exec 控制根下的文件，使"结束 5 分钟后"和
 * "exec 重启后"都能按同一套游标语义继续读。
 *
 * 为什么是这个目录：控制根来自已有的 `SANDBOX_CONTROL_ROOT`
 * （`readControlPlaneRoots()`，compose 里是 `/var/sandbox/control`，宿主持久
 * 挂载），**不新增环境变量**。它不会被 bind 进 bwrap 沙箱——
 * `isolation/build.ts` 的 `buildIsolationProfile()` 只挂 workspace 根、
 * temp 根、草稿根、temp 下的 `.home` 子目录、数据源 socket、静态只读运行时
 * 与 skill 包，挂载表里根本没有控制根（`control-plane-storage.ts` 头注释
 * 同一条纪律："沙箱子进程的挂载表里根本没有它"），模型读写不到这些文件。
 *
 * 落盘格式（v1）：
 * - `<jobId>.log`：保留窗口的原始字节（与内存缓冲内容逐字节一致）。
 * - `<jobId>.meta.json`：`{version:1, generation, baseOffset, total, truncated}`，
 *   即 `StreamCursorBuffer.snapshotState()` 的 JSON。`baseOffset` 是窗口首字节
 *   的绝对偏移，`total` 是有史以来 append 的绝对字节总数。
 * - 写入先落 `<name>.tmp` 再 `rename`（与 `control-plane-storage.ts` 同一招），
 *   中途失败不留下截断的最终文件；先写 log 再写 meta，恢复时严格校验
 *   `log 字节数 === total - baseOffset`，对不上即视为损坏。
 *
 * 环形语义：落的是**与内存缓冲一致的保留窗口**（超过上限时最老的数据已经在
 * 内存里被丢掉、`generation` 已经自增），不是全量追加——磁盘占用天然有界，
 * 与 `maxOutputBytes` 同一个上限。
 *
 * 落盘间隔：三处——live `read()` 后节流落盘（默认最多 1 秒一次）+
 * 每个 live 作业的后台定时器（仅启用落盘时起，周期
 * `persistMinIntervalMs`、为 0 时取默认 1000，已 `.unref()`；每拍先拉
 * `handle.readOutput()` 再看 buffer 总量，有变化才强制落盘，无变化跳过，
 * 同一作业的落盘经 promise 链串行、不能重入）+ 结算时强制落盘一次。
 * 也就是说**运行中允许丢失最近一个落盘间隔的数据，但间隔有界
 * （≤ persistMinIntervalMs，默认 1s，硬上限 2s）**；作业结束后的最终窗口
 * 一定完整（settle 先停定时器、等手里那次落盘结束，再 `await` 落最终窗口）。
 * 定时器在 settle 时清除，回收/丢弃条目时也清，不阻止进程退出。
 *
 * 失败语义：所有文件 IO 走 best-effort——失败记 warn 日志后吞掉，**绝不让
 * 作业本身失败、绝不让 exec 崩溃**。warn 内容只含作业 id 与脱敏后的错误
 * （经 `redactPhysicalRoots`，输出正文永不进日志）。读侧把"文件缺失/损坏"
 * 诚实地报成 `outputUnavailable`（见 `job-registry.ts` 的无 live 路径）。
 *
 * 路径安全：`jobId` 先按 `job-registry.ts` 里 `newJobId` 的字符集校验
 * （`[A-Za-z0-9_-]`，拒绝 `/`、`\`、`\0`、`..` 与绝对路径），非法 id 直接
 * 拒绝、不触碰文件系统——调用方在归属层本就会先 404，这里是纵深第二道。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StreamCursorBuffer, type StreamBufferSnapshotState } from './job-cursor.js';
import { redactPhysicalRoots } from '../fs/redact.js';

/** 控制根下的子目录名。 */
export const JOB_OUTPUT_SUBDIR = 'job-output';

/** 边车元数据的格式版本。 */
const OUTPUT_META_VERSION = 1;

/**
 * 运行中落盘节流的默认间隔（毫秒）。registry 侧可配，但硬上限
 * `MAX_PERSIST_INTERVAL_MS` 保证"运行中最多丢最近 2 秒的数据"。
 */
export const DEFAULT_PERSIST_MIN_INTERVAL_MS = 1000;
export const MAX_PERSIST_INTERVAL_MS = 2000;

/**
 * 与 `job-registry.ts` 的 `newJobId`（`^${kind}-[A-Za-z0-9_-]{1,160}$`）
 * 同一字符集的路径安全校验：只允许字母数字、`_`、`-`，首字符不能是 `-`；
 * 含 `/`、`\`、`\0` 的、`..` 的、绝对路径形态的一律拒绝。
 */
const SAFE_JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export function isSafeJobId(jobId: string): boolean {
  if (typeof jobId !== 'string' || jobId.length === 0 || jobId.length > 200) return false;
  if (!SAFE_JOB_ID_RE.test(jobId)) return false;
  if (jobId === '.' || jobId === '..' || jobId.includes('..')) return false;
  return true;
}

/** 已有控制根 → 作业输出目录（不建目录，只拼路径）。 */
export function resolveJobOutputDir(controlRoot: string): string {
  return path.join(controlRoot, JOB_OUTPUT_SUBDIR);
}

function logPathFor(outputDir: string, jobId: string): string | null {
  if (!isSafeJobId(jobId)) return null;
  return path.join(outputDir, `${jobId}.log`);
}

function metaPathFor(outputDir: string, jobId: string): string | null {
  if (!isSafeJobId(jobId)) return null;
  return path.join(outputDir, `${jobId}.meta.json`);
}

export interface FileJobOutputStoreOptions {
  /** 与内存环形缓冲同一个字节上限（语义一致：超限丢最老、generation 自增）。 */
  readonly maxBytes: number;
  /** warn 日志出口，默认 `process.stderr`；测试可注入数组。 */
  readonly warn?: ((line: string) => void) | undefined;
}

export type JobOutputLoadResult =
  | { readonly ok: true; readonly buffer: StreamCursorBuffer }
  | { readonly ok: false; readonly reason: 'disabled' | 'unsafe-id' | 'missing' | 'corrupt' };

/**
 * 作业输出的文件持久化。无状态（除配置外）：同一目录可被多个
 * `MySqlJobRegistry` 实例共用——这正是"exec 重启后新实例能读到旧输出"的前提。
 */
export class FileJobOutputStore {
  private readonly outputDir: string | null;
  private readonly maxBytes: number;
  private readonly warn: (line: string) => void;

  constructor(outputDir: string | null | undefined, options: FileJobOutputStoreOptions) {
    this.outputDir = outputDir ?? null;
    this.maxBytes = Math.max(1, Math.trunc(options.maxBytes));
    this.warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  }

  get enabled(): boolean {
    return this.outputDir !== null;
  }

  /**
   * 把内存缓冲的当前保留窗口整体落盘（先写 tmp 再 rename，原子替换）。
   * best-effort：失败只记 warn，永不抛错。
   */
  async save(
    jobId: string,
    state: StreamBufferSnapshotState,
    windowText: string,
    physicalRoots: readonly string[],
  ): Promise<void> {
    try {
      if (this.outputDir === null) return;
      const logPath = logPathFor(this.outputDir, jobId);
      const metaPath = metaPathFor(this.outputDir, jobId);
      if (logPath === null || metaPath === null) return;
      const windowBytes = Buffer.from(windowText, 'utf8');
      const meta = {
        version: OUTPUT_META_VERSION,
        generation: state.generation,
        baseOffset: state.baseOffset,
        total: state.total,
        truncated: state.truncated,
      };
      await mkdir(this.outputDir, { recursive: true, mode: 0o700 });
      // 先清残留 tmp（上次崩溃可能剩半截），再写 tmp → rename，与
      // `control-plane-storage.ts` 的 `streamCopyHashToControl` 同一顺序。
      await unlink(`${logPath}.tmp`).catch(() => {});
      await unlink(`${metaPath}.tmp`).catch(() => {});
      await writeFile(`${logPath}.tmp`, windowBytes, { mode: 0o600 });
      await rename(`${logPath}.tmp`, logPath);
      await writeFile(`${metaPath}.tmp`, JSON.stringify(meta), { mode: 0o600 });
      await rename(`${metaPath}.tmp`, metaPath);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // 日志里只放作业 id 与脱敏后的错误：输出正文与物理根永不进日志。
      this.warn(`exec WARNING: job output persist failed for job ${jobId}: ${redactPhysicalRoots(raw, physicalRoots)}`);
    }
  }

  /**
   * 从落盘文件重建一个只读缓冲（游标语义与落盘前一致）。
   * 文件缺失 → `missing`；JSON 非法/字段非法/窗口长度对不上 → `corrupt`。
   * 真实 IO 错误（非 ENOENT）记 warn 后按 `corrupt` 报——调用方一律视为
   * "输出不可用"，不抛错。
   */
  async load(jobId: string, maxBytes?: number): Promise<JobOutputLoadResult> {
    if (this.outputDir === null) return { ok: false, reason: 'disabled' };
    const logPath = logPathFor(this.outputDir, jobId);
    const metaPath = metaPathFor(this.outputDir, jobId);
    if (logPath === null || metaPath === null) return { ok: false, reason: 'unsafe-id' };
    let metaRaw: string;
    let windowBytes: Buffer;
    try {
      metaRaw = await readFile(metaPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      this.warn(`exec WARNING: job output meta read failed for job ${jobId}`);
      return { ok: false, reason: 'corrupt' };
    }
    try {
      windowBytes = await readFile(logPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
      this.warn(`exec WARNING: job output log read failed for job ${jobId}`);
      return { ok: false, reason: 'corrupt' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(metaRaw) as unknown;
    } catch {
      this.warn(`exec WARNING: job output meta corrupt for job ${jobId}`);
      return { ok: false, reason: 'corrupt' };
    }
    const meta = parsed as Partial<StreamBufferSnapshotState> & { version?: unknown };
    if (meta?.version !== OUTPUT_META_VERSION) {
      this.warn(`exec WARNING: job output meta corrupt for job ${jobId}`);
      return { ok: false, reason: 'corrupt' };
    }
    try {
      const buffer = StreamCursorBuffer.restore(maxBytes ?? this.maxBytes, meta as StreamBufferSnapshotState, windowBytes);
      return { ok: true, buffer };
    } catch {
      this.warn(`exec WARNING: job output snapshot mismatch for job ${jobId}`);
      return { ok: false, reason: 'corrupt' };
    }
  }

  /** 删一个作业的落盘文件（log + meta + 可能的 tmp 残留）。best-effort 静默。 */
  async delete(jobId: string): Promise<void> {
    if (this.outputDir === null) return;
    const logPath = logPathFor(this.outputDir, jobId);
    const metaPath = metaPathFor(this.outputDir, jobId);
    if (logPath === null || metaPath === null) return;
    for (const target of [logPath, metaPath, `${logPath}.tmp`, `${metaPath}.tmp`]) {
      try {
        await unlink(target);
      } catch {
        // 不存在或删不掉都不是错误：调用方是在做清理。
      }
    }
  }

  /** 批量删（工作区 GC 用）。返回尝试删除的作业数，永不抛错。 */
  async deleteMany(jobIds: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of jobIds) {
      try {
        await this.delete(id);
        n += 1;
      } catch {
        // ignore（delete 本身已吞错，这里是兜底）。
      }
    }
    return n;
  }
}
