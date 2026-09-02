/**
 * 附件上传服务——移植自 Python 版
 * `sandbox/services/attachment_manager.py` + `sandbox/routers/files.py` 的
 * `upload_attachment` 路径。
 *
 * 为什么这样设计：附件是用户以 multipart 形式直接上传的二进制，与
 * `WorkspaceFileSystem` 的模型可见文件不同——它们先落在
 * `uploads/{attachment_id}/{sanitized_name}` 这一段**逻辑路径**下，再由
 * 后续工具调用决定是否当作上下文消费。存放位置用 WorkspaceFileSystem 的
 * 围栏保证不越权；大小用 `WorkspaceQuotaLedger` 的预留账本卡住，不靠
 * 单纯的 `workspace_size_bytes` 事后扫描（否则并发上传会超卖）。
 *
 * 所有对外抛出的错误都经 `redactPhysicalRoots()` 无条件脱敏——参照
 * `_shared.md §1` 与 `contract/src/errors.ts` 的兜底分级，任何 `Error` /
 * 非 `Error` 的抛出物都不漏物理根。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { InMemoryQuotaStore } from '../workspace/quota-store.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import { isAllowedExtension, sanitizeFilename } from './sanitize.js';

export class AttachmentError extends Error {
  override name = 'AttachmentError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface AttachmentUploadRequest {
  readonly workspace: WorkspaceContext;
  /** 原始文件名（来自 multipart header）。 */
  readonly filename: string;
  /** 文件字节；调用方已在 HTTP 层做过 `max_file_bytes` 初筛，这里只做二次校验。 */
  readonly content: Uint8Array;
  /** 幂等键；同 workspace + 同 key 再次上传返回首次结果，不落第二份文件。 */
  readonly idempotencyKey?: string | undefined;
}

export interface AttachmentRecord {
  readonly attachmentId: string;
  readonly workspaceId: string;
  readonly filename: string;
  readonly logicalPath: string;
  readonly sizeBytes: number;
}

export interface AttachmentServiceOptions {
  /** 单次上传上限（字节），默认 50 MiB，与 Python 版 `max_file_bytes` 对齐。 */
  readonly maxFileBytes?: number | undefined;
}

const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * 附件服务。`store` 指 quota 账本背后的状态——默认用内存实现，测试与
 * macOS 无 MySQL 场景直接可用；生产传入 `MySqlQuotaStore` 即可落库。
 */
export class AttachmentService {
  private readonly maxFileBytes: number;
  private readonly quotaLedger: WorkspaceQuotaLedger;
  /** workspaceId -> idempotencyKey -> record */
  private readonly idem = new Map<string, Map<string, AttachmentRecord>>();

  constructor(
    private readonly fsFactory: (workspace: WorkspaceContext) => WorkspaceFileSystem,
    quotaLedger?: WorkspaceQuotaLedger,
    opts: AttachmentServiceOptions = {},
  ) {
    this.maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.quotaLedger =
      quotaLedger ??
      new WorkspaceQuotaLedger(new InMemoryQuotaStore(), new InProcessWorkspaceLock(), {
        defaultQuotaMb: 1024,
      });
  }

  private physicalRoots(workspace: WorkspaceContext): readonly string[] {
    return [workspace.workspaceRoot, workspace.tempRoot];
  }

  private redact(err: unknown, workspace: WorkspaceContext): never {
    const roots = this.physicalRoots(workspace);
    const msg =
      err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    const redacted = redactPhysicalRoots(msg, roots);
    if (err instanceof AttachmentError) {
      throw new AttachmentError(err.code, redacted, err.status);
    }
    if (err instanceof Error) {
      const e = new Error(redacted) as Error & { code?: string; status?: number };
      e.name = err.name;
      throw e;
    }
    throw new Error(redacted);
  }

  private idemKey(workspace: WorkspaceContext): Map<string, AttachmentRecord> {
    const bucketKey = workspace.workspaceId;
    let bucket = this.idem.get(bucketKey);
    if (!bucket) {
      bucket = new Map();
      this.idem.set(bucketKey, bucket);
    }
    return bucket;
  }

  async upload(req: AttachmentUploadRequest): Promise<AttachmentRecord> {
    try {
      return await this.uploadInner(req);
    } catch (err) {
      this.redact(err, req.workspace);
    }
  }

  private async uploadInner(req: AttachmentUploadRequest): Promise<AttachmentRecord> {
    const { workspace, filename, content, idempotencyKey } = req;

    if (idempotencyKey) {
      const hit = this.idemKey(workspace).get(idempotencyKey);
      if (hit) return hit;
    }

    const sanitized = sanitizeFilename(filename);
    if (!isAllowedExtension(sanitized)) {
      throw new AttachmentError(
        'attachment_bad_extension',
        `attachment extension not allowed: ${sanitized}`,
        400,
      );
    }
    if (content.byteLength > this.maxFileBytes) {
      throw new AttachmentError('attachment_too_large', `attachment exceeds ${this.maxFileBytes} bytes`, 413);
    }
    const attachmentId = `att_${randomUUID().replace(/-/g, '')}`;
    const logicalPath = `uploads/${attachmentId}/${sanitized}`;

    // 配额预留——经 QuotaStore（工作区外），不靠事后扫描
    const reservation = await this.quotaLedger.reserve(
      workspace.workspaceRoot,
      workspace.workspaceId,
      content.byteLength,
    );
    try {
      const fs = this.fsFactory(workspace);
      const target = await fs.resolve(logicalPath);
      // 通过 targetKey（已围栏校验过的物理路径）直接落盘，避免依赖 WorkspaceFileSystem 的 writeBytes
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      await writeFile(target.targetKey, content);
      // 写入成功即提交（释放预留，字节已算进磁盘用量）
      await reservation.commit();
    } catch (err) {
      // 预留失败或写入失败都要释放预留，避免悬空占位
      try {
        await reservation.release();
      } catch {
        // 释放失败不掩盖原错
      }
      throw err;
    }

    const record: AttachmentRecord = {
      attachmentId,
      workspaceId: workspace.workspaceId,
      filename: sanitized,
      logicalPath,
      sizeBytes: content.byteLength,
    };
    if (idempotencyKey) {
      this.idemKey(workspace).set(idempotencyKey, record);
    }
    return record;
  }
}
