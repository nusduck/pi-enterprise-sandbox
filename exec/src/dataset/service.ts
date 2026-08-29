/**
 * 数据集上传——**三段式流式**：`beginUpload` → `writeChunk` → `finishUpload`。
 * 移植自 `sandbox/services/dataset_manager.py`。
 *
 * **为什么必须是流式**：之前的 TS 版签名是 `create(content: Uint8Array)`，
 * 整个文件进内存。`STATUS.md` C8 记着一次 5GiB 实测——那个签名下 5GiB 会
 * 直接把进程打死。这不是少写了几个函数，是接口形状本身就不成立。
 *
 * 落盘路径与 Python 一致：先在**控制面**暂存（`.part`），完整收完并校验后
 * 再发布到工作区的 `datasets/{id}/{safeName}`。中途失败不会在工作区留下
 * 半个文件——模型看到的要么是完整数据集，要么什么都没有。
 *
 * ## Model Experience
 * 模型通过工作区里的 `datasets/{id}/{name}` 读数据集，路径在 `stored_relative_path`
 * 里给出；未 ready 的数据集这个字段是空串，模型因此不会去读一个正在写的文件。
 *
 * ## Known Limitations and Deferred Work
 * - `isReadableByAgent`（Python 的 agent 侧可读闸门）未移植：当前没有调用方。
 * - 幂等判定只比对 key，不比对 Python 的 `dataset_upload_request_hash`
 *   （同 key 不同内容会拿到首次的结果）。补齐需要先定 hash 的输入字段集合。
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import type { WriteStream } from 'node:fs';
import path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import type {
  DatasetOwnerScope,
  DatasetStore,
  ExecDatasetRecord,
} from '../db/repositories/datasets.js';
import { InMemoryDatasetStore } from '../db/repositories/datasets.js';
import { InMemoryQuotaStore } from '../workspace/quota-store.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';
import {
  readControlPlaneRoots,
  validateSegment,
  type ControlPlaneRoots,
} from '../artifact/control-plane-storage.js';

export class DatasetError extends Error {
  override name = 'DatasetError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

const DEFAULT_MAX_DATASET_BYTES = 100 * 1024 * 1024;

/** 复合扩展名要整体保留，否则 `a.tar.gz` 截断后变成 `a.gz`。 */
const COMPOUND_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst'];

export function extensionOf(filename: string): string {
  const lower = (filename || '').toLowerCase().trim();
  for (const compound of COMPOUND_SUFFIXES) {
    if (lower.endsWith(compound)) return compound;
  }
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot) : '';
}

/** 逐条对应 Python `sanitize_dataset_filename`。 */
export function sanitizeDatasetFilename(name: string): string {
  const raw = name || 'dataset';
  if (raw.includes('\0')) {
    throw new DatasetError('dataset_filename_invalid', 'NUL in filename', 400);
  }
  if (raw.startsWith('/') || raw.startsWith('\\') || (raw.length > 1 && raw[1] === ':')) {
    throw new DatasetError('dataset_filename_invalid', 'Absolute paths are not accepted', 400);
  }
  let base = path.posix.basename(raw.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1f\x7f]/g, '');
  base = base.replace(/\.\./g, '_').trim().replace(/^\.+|\.+$/g, '');
  if (!base || base === '.' || base === '..') base = 'dataset';
  if (base.length > 200) {
    const ext = extensionOf(base);
    const stem = ext ? base.slice(0, 200 - ext.length) : base.slice(0, 200);
    base = ext && !stem.endsWith(ext) ? `${stem}${ext}` : stem;
  }
  return base;
}

export function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  if (!key) return null;
  if (key.length > 255 || [...key].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    throw new DatasetError(
      'dataset_idempotency_key_invalid',
      'Idempotency-Key must be 1..255 printable characters',
      400,
    );
  }
  return key;
}

export function logicalDatasetPath(datasetId: string, safeFilename: string): string {
  return `datasets/${datasetId}/${safeFilename}`;
}

interface InFlight {
  readonly datasetId: string;
  readonly workspace: WorkspaceContext;
  readonly stagingPath: string;
  readonly logicalPath: string;
  readonly handle: WriteStream;
  readonly hasher: ReturnType<typeof createHash>;
  size: number;
}

export interface BeginUploadInput {
  readonly workspace: WorkspaceContext;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly owner: DatasetOwnerScope;
  readonly originalFilename: string;
  readonly mimeType?: string | null;
  readonly declaredSize?: number | null;
  readonly idempotencyKey?: string | null;
}

export interface DatasetServiceOptions {
  readonly roots?: ControlPlaneRoots;
  readonly maxBytes?: number;
  readonly quotaLedger?: WorkspaceQuotaLedger;
}

export class DatasetService {
  readonly #roots: ControlPlaneRoots;
  readonly #maxBytes: number;
  readonly #quotaLedger: WorkspaceQuotaLedger;
  readonly #inflight = new Map<string, InFlight>();

  constructor(
    private readonly fsFactory: (workspace: WorkspaceContext) => WorkspaceFileSystem,
    private readonly store: DatasetStore = new InMemoryDatasetStore(),
    options: DatasetServiceOptions = {},
  ) {
    this.#roots = options.roots ?? readControlPlaneRoots();
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_DATASET_BYTES;
    this.#quotaLedger =
      options.quotaLedger ??
      new WorkspaceQuotaLedger(new InMemoryQuotaStore(), new InProcessWorkspaceLock(), {
        defaultQuotaMb: 4096,
      });
  }

  get maxBytes(): number {
    return this.#maxBytes;
  }

  #redact(err: unknown, workspace: WorkspaceContext): never {
    const roots = [workspace.workspaceRoot, workspace.tempRoot, this.#roots.controlRoot];
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactPhysicalRoots(msg, roots);
    if (err instanceof DatasetError) throw new DatasetError(err.code, redacted, err.status);
    throw new Error(redacted);
  }

  #stagingPath(workspaceId: string, datasetId: string, safeName: string): string {
    return path.join(
      this.#roots.controlRoot,
      'datasets',
      validateSegment(workspaceId, 'workspace_id'),
      validateSegment(datasetId, 'dataset_id'),
      `${validateSegment(safeName, 'filename')}.part`,
    );
  }

  /**
   * 开一次上传。返回已有记录表示幂等命中——调用方不该再写 chunk。
   */
  async beginUpload(
    input: BeginUploadInput,
  ): Promise<{ record: ExecDatasetRecord; reused: boolean }> {
    const idemKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (idemKey !== null) {
      const existing = await this.store.findByIdempotencyKey(
        input.sessionId,
        input.owner,
        idemKey,
      );
      // 幂等命中：直接回已有记录，不新建 id、不再写一遍字节。
      if (existing !== null) return { record: existing, reused: true };
    }

    if (input.declaredSize != null && input.declaredSize > this.#maxBytes) {
      throw new DatasetError(
        'dataset_too_large',
        `File exceeds max size of ${Math.floor(this.#maxBytes / (1024 * 1024))}MB`,
        413,
      );
    }

    const datasetId = `ds_${randomUUID().replace(/-/g, '')}`;
    const safeName = sanitizeDatasetFilename(input.originalFilename);
    const logicalPath = logicalDatasetPath(datasetId, safeName);
    const stagingPath = this.#stagingPath(input.workspace.workspaceId, datasetId, safeName);

    await mkdir(path.dirname(stagingPath), { recursive: true, mode: 0o700 });
    const handle = createWriteStream(stagingPath, { flags: 'wx', mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      handle.once('open', () => resolve());
      handle.once('error', reject);
    });

    this.#inflight.set(datasetId, {
      datasetId,
      workspace: input.workspace,
      stagingPath,
      logicalPath,
      handle,
      hasher: createHash('sha256'),
      size: 0,
    });

    await this.store.insert({
      datasetId,
      sessionId: input.sessionId,
      conversationId: input.conversationId,
      workspaceId: input.workspace.workspaceId,
      orgId: input.owner.orgId,
      userId: input.owner.userId,
      originalFilename: input.originalFilename,
      storedRelativePath: logicalPath,
      mimeType: (input.mimeType ?? '').trim() || 'application/octet-stream',
      sha256: null,
      sizeBytes: 0,
      status: 'uploading',
      idempotencyKey: idemKey,
      completedAt: null,
    });

    const record = await this.store.getOwned(datasetId, input.owner);
    if (!record) throw new DatasetError('dataset_not_found', 'dataset insert not visible', 500);
    return { record, reused: false };
  }

  /** 写一块。超过上限即中止整次上传并抛 413。 */
  async writeChunk(datasetId: string, chunk: Uint8Array): Promise<number> {
    if (chunk.byteLength === 0) return 0;
    const inflight = this.#inflight.get(datasetId);
    if (inflight === undefined) {
      throw new DatasetError('dataset_not_uploading', 'No in-flight upload for dataset', 409);
    }
    const newSize = inflight.size + chunk.byteLength;
    if (newSize > this.#maxBytes) {
      await this.abortUpload(datasetId);
      throw new DatasetError(
        'dataset_too_large',
        `File exceeds max size of ${Math.floor(this.#maxBytes / (1024 * 1024))}MB`,
        413,
      );
    }
    await new Promise<void>((resolve, reject) => {
      inflight.handle.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    inflight.hasher.update(chunk);
    inflight.size = newSize;
    return chunk.byteLength;
  }

  /** 收尾：关暂存 → 预留配额 → 发布进工作区 → 落库。 */
  async finishUpload(datasetId: string, owner: DatasetOwnerScope): Promise<ExecDatasetRecord> {
    const inflight = this.#inflight.get(datasetId);
    if (inflight === undefined) {
      throw new DatasetError('dataset_not_uploading', 'No in-flight upload for dataset', 409);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        inflight.handle.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });

      const staged = await stat(inflight.stagingPath);
      if (staged.size !== inflight.size) {
        throw new DatasetError(
          'dataset_size_mismatch',
          `staged size ${staged.size} != streamed total ${inflight.size}`,
          500,
        );
      }

      const reservation = await this.#quotaLedger.reserve(
        inflight.workspace.workspaceRoot,
        inflight.workspace.workspaceId,
        inflight.size,
      );
      try {
        // 围栏只有一处：目标路径经 WorkspaceFileSystem.resolve()。
        const fs = this.fsFactory(inflight.workspace);
        const target = await fs.resolve(inflight.logicalPath);
        await mkdir(path.dirname(target.targetKey), { recursive: true });
        // 暂存与工作区可能不同挂载点，rename 会 EXDEV；那时退化成拷贝。
        await rename(inflight.stagingPath, target.targetKey).catch(async (err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
          const { copyFile } = await import('node:fs/promises');
          await copyFile(inflight.stagingPath, target.targetKey);
          await rm(inflight.stagingPath, { force: true });
        });
        await reservation.commit();
      } catch (err) {
        await reservation.release().catch(() => {});
        throw err;
      }

      const sha256 = inflight.hasher.digest('hex');
      await this.store.complete(datasetId, {
        sha256,
        sizeBytes: inflight.size,
        status: 'ready',
        completedAt: new Date(),
      });
      const record = await this.store.getOwned(datasetId, owner);
      if (!record) throw new DatasetError('dataset_not_found', 'dataset not visible', 500);
      return record;
    } catch (err) {
      await this.store.markFailed(datasetId).catch(() => {});
      await rm(inflight.stagingPath, { force: true }).catch(() => {});
      this.#inflight.delete(datasetId);
      this.#redact(err, inflight.workspace);
    } finally {
      this.#inflight.delete(datasetId);
    }
  }

  /** 放弃一次上传：关句柄、删暂存、标记 failed。 */
  async abortUpload(datasetId: string): Promise<void> {
    const inflight = this.#inflight.get(datasetId);
    this.#inflight.delete(datasetId);
    if (inflight === undefined) return;
    await new Promise<void>((resolve) => inflight.handle.end(() => resolve()));
    await rm(inflight.stagingPath, { force: true }).catch(() => {});
    await this.store.markFailed(datasetId).catch(() => {});
  }

  /** 便捷入口：把一个可异步迭代的字节流一次走完三段式。 */
  async uploadStream(
    input: BeginUploadInput,
    body: AsyncIterable<Uint8Array>,
  ): Promise<ExecDatasetRecord> {
    const { record, reused } = await this.beginUpload(input);
    if (reused) return record;
    try {
      for await (const chunk of body) {
        await this.writeChunk(record.datasetId, chunk);
      }
    } catch (err) {
      await this.abortUpload(record.datasetId).catch(() => {});
      throw err;
    }
    return await this.finishUpload(record.datasetId, input.owner);
  }

  async get(datasetId: string, owner: DatasetOwnerScope): Promise<ExecDatasetRecord | null> {
    return await this.store.getOwned(datasetId, owner);
  }

  async list(sessionId: string, owner: DatasetOwnerScope): Promise<ExecDatasetRecord[]> {
    return await this.store.listBySession(sessionId, owner);
  }

  /** 解析出数据集在工作区里的物理路径，供路由流式回读。 */
  async resolveContentPath(
    record: ExecDatasetRecord,
    workspace: WorkspaceContext,
  ): Promise<string> {
    if (record.status !== 'ready') {
      throw new DatasetError('dataset_not_ready', 'dataset is not ready', 409);
    }
    const fs = this.fsFactory(workspace);
    const target = await fs.resolve(record.storedRelativePath);
    return target.targetKey;
  }
}
