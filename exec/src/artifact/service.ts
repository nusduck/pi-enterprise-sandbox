/**
 * 产物提交/下载服务——移植自 Python 版
 * `sandbox/artifact/infrastructure/manager.py` + `application/facade.py` 的
 * `submit` / `resolve_download` 路径。
 *
 * 落点：`exec_artifacts` 表（`exec/src/db/repositories/artifacts.ts`），
 * 物理文件走 `WorkspaceFileSystem` 围栏，大小走 `WorkspaceQuotaLedger`
 * 预留账本（工作区外，防删超卖）。错误一律经 `redactPhysicalRoots()` 脱敏。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { sanitizeFilename } from '../attachment/sanitize.js';
import type { ExecArtifactRecord } from '../db/repositories/artifacts.js';
import { InMemoryArtifactStore, type ExecArtifactInsert } from '../db/repositories/artifacts.js';
import { InMemoryQuotaStore } from '../workspace/quota-store.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';

export class ArtifactError extends Error {
  override name = 'ArtifactError';
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

export interface ArtifactSubmitRequest {
  readonly workspace: WorkspaceContext;
  /** 逻辑源路径（工作区内已存在的文件），为空时仅落库不拷文件。 */
  readonly sourcePath?: string | undefined;
  /** 期望落库的文件名；不传则从 sourcePath 推导，仍经 sanitize。 */
  readonly filename?: string | undefined;
  /** 直接以字节提交（无源文件时用）；与 sourcePath 二选一。 */
  readonly content?: Uint8Array | undefined;
}

export class ArtifactService {
  private readonly quotaLedger: WorkspaceQuotaLedger;

  constructor(
    private readonly fsFactory: (workspace: WorkspaceContext) => WorkspaceFileSystem,
    private readonly store: InMemoryArtifactStore = new InMemoryArtifactStore(),
    quotaLedger?: WorkspaceQuotaLedger,
  ) {
    this.quotaLedger =
      quotaLedger ??
      new WorkspaceQuotaLedger(new InMemoryQuotaStore(), new InProcessWorkspaceLock(), {
        defaultQuotaMb: 1024,
      });
  }

  private roots(workspace: WorkspaceContext): readonly string[] {
    return [workspace.workspaceRoot, workspace.tempRoot];
  }

  private redact(err: unknown, workspace: WorkspaceContext): never {
    const roots = this.roots(workspace);
    const msg = err instanceof Error ? err.message : String(err);
    const redacted = redactPhysicalRoots(msg, roots);
    if (err instanceof ArtifactError) throw new ArtifactError(err.code, redacted, err.status);
    throw new Error(redacted);
  }

  async submit(req: ArtifactSubmitRequest): Promise<ExecArtifactRecord> {
    try {
      return await this.submitInner(req);
    } catch (err) {
      this.redact(err, req.workspace);
    }
  }

  private async submitInner(req: ArtifactSubmitRequest): Promise<ExecArtifactRecord> {
    const { workspace, sourcePath, filename, content } = req;
    const fs = this.fsFactory(workspace);

    let bytes: Uint8Array | undefined;
    let sizeBytes = 0;
    let sanitized: string;

    if (content !== undefined) {
      sanitized = sanitizeFilename(filename ?? 'artifact');
      bytes = content;
      sizeBytes = content.byteLength;
    } else if (sourcePath !== undefined) {
      sanitized = sanitizeFilename(filename ?? sourcePath.split('/').pop() ?? 'artifact');
      const target = await fs.resolve(sourcePath);
      // 经围栏校验后通过物理路径读取（WorkspaceFileSystem 无 writeBytes/readBytes 的二进制版本，复用 targetKey）
      bytes = new Uint8Array(await readFile(target.targetKey));
      sizeBytes = bytes.byteLength;
    } else {
      throw new ArtifactError('artifact_missing_source', 'artifact submit requires sourcePath or content', 400);
    }

    const artifactId = `art_${randomUUID().replace(/-/g, '')}`;

    const reservation = await this.quotaLedger.reserve(
      workspace.workspaceRoot,
      workspace.workspaceId,
      sizeBytes,
    );
    try {
      // 产物物理存放：控制面逻辑路径 `artifacts/{id}/{name}` 同样走工作区围栏
      // （本实现落在工作区内，便于用 WorkspaceFileSystem 统一围栏；生产可换控制面目录）
      if (bytes !== undefined) {
        const dest = await fs.resolve(`artifacts/${artifactId}/${sanitized}`);
        await mkdir(path.dirname(dest.targetKey), { recursive: true });
        await writeFile(dest.targetKey, bytes);
      }
      await reservation.commit();
    } catch (err) {
      try {
        await reservation.release();
      } catch {}
      throw err;
    }

    const rec: ExecArtifactInsert = {
      artifactId,
      workspaceId: workspace.workspaceId,
      orgId: workspace.orgId,
      userId: workspace.userId,
      filename: sanitized,
      sizeBytes,
    };
    await this.store.insert(rec);
    const got = await this.store.getById(artifactId);
    if (!got) throw new ArtifactError('artifact_not_found', 'artifact insert not visible', 500);
    return got;
  }

  async download(artifactId: string, workspace: WorkspaceContext): Promise<{ record: ExecArtifactRecord; content: Uint8Array }> {
    try {
      const rec = await this.store.getById(artifactId);
      if (!rec) throw new ArtifactError('artifact_not_found', `artifact ${artifactId} not found`, 404);
      if (rec.workspaceId !== workspace.workspaceId) {
        throw new ArtifactError('artifact_not_found', `artifact ${artifactId} not found`, 404);
      }
      const fs = this.fsFactory(workspace);
      const target = await fs.resolve(`artifacts/${artifactId}/${rec.filename}`);
      const content = await readFile(target.targetKey);
      return { record: rec, content: new Uint8Array(content) };
    } catch (err) {
      this.redact(err, workspace);
    }
  }

  async list(workspace: WorkspaceContext): Promise<ExecArtifactRecord[]> {
    try {
      return await this.store.listByWorkspace(workspace.workspaceId);
    } catch (err) {
      this.redact(err, workspace);
    }
  }
}
