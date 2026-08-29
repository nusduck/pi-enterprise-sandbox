/**
 * 数据集读写服务——移植自 Python 版
 * `sandbox/services/dataset_manager.py` + `sandbox/routers/datasets.py`。
 *
 * 逻辑路径 `datasets/{dataset_id}/{safe_filename}`，经
 * `WorkspaceFileSystem` 围栏，大小经 `WorkspaceQuotaLedger` 预留账本，
 * 错误无条件 `redactPhysicalRoots()` 脱敏。落点 `exec_datasets` 表。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceContext } from '../types.js';
import { redactPhysicalRoots } from '../fs/redact.js';
import type { WorkspaceFileSystem } from '../fs/workspace-fs.js';
import { sanitizeFilename } from '../attachment/sanitize.js';
import type { ExecDatasetRecord } from '../db/repositories/datasets.js';
import { InMemoryDatasetStore, type ExecDatasetInsert } from '../db/repositories/datasets.js';
import { InMemoryQuotaStore } from '../workspace/quota-store.js';
import { InProcessWorkspaceLock } from '../workspace/lock.js';
import { WorkspaceQuotaLedger } from '../workspace/quota-ledger.js';

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

export interface DatasetCreateRequest {
  readonly workspace: WorkspaceContext;
  readonly name: string;
  readonly content: Uint8Array;
  readonly filename?: string | undefined;
}

export class DatasetService {
  private readonly quotaLedger: WorkspaceQuotaLedger;

  constructor(
    private readonly fsFactory: (workspace: WorkspaceContext) => WorkspaceFileSystem,
    private readonly store: InMemoryDatasetStore = new InMemoryDatasetStore(),
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
    if (err instanceof DatasetError) throw new DatasetError(err.code, redacted, err.status);
    throw new Error(redacted);
  }

  async create(req: DatasetCreateRequest): Promise<ExecDatasetRecord> {
    try {
      return await this.createInner(req);
    } catch (err) {
      this.redact(err, req.workspace);
    }
  }

  private async createInner(req: DatasetCreateRequest): Promise<ExecDatasetRecord> {
    const { workspace, name, content, filename } = req;
    const safeName = sanitizeFilename(filename ?? name);
    if (!safeName) throw new DatasetError('dataset_bad_name', 'dataset name required', 400);
    const datasetId = `ds_${randomUUID().replace(/-/g, '')}`;
    const logicalPath = `datasets/${datasetId}/${safeName}`;

    const reservation = await this.quotaLedger.reserve(
      workspace.workspaceRoot,
      workspace.workspaceId,
      content.byteLength,
    );
    try {
      const fs = this.fsFactory(workspace);
      const target = await fs.resolve(logicalPath);
      await mkdir(path.dirname(target.targetKey), { recursive: true });
      await writeFile(target.targetKey, content);
      await reservation.commit();
    } catch (err) {
      try {
        await reservation.release();
      } catch {}
      throw err;
    }

    const rec: ExecDatasetInsert = {
      datasetId,
      workspaceId: workspace.workspaceId,
      orgId: workspace.orgId,
      userId: workspace.userId,
      name: safeName,
    };
    await this.store.insert(rec);
    const got = await this.store.getById(datasetId);
    if (!got) throw new DatasetError('dataset_not_found', 'dataset insert not visible', 500);
    return got;
  }

  async read(datasetId: string, workspace: WorkspaceContext): Promise<{ record: ExecDatasetRecord; content: Uint8Array }> {
    try {
      const rec = await this.store.getById(datasetId);
      if (!rec) throw new DatasetError('dataset_not_found', `dataset ${datasetId} not found`, 404);
      if (rec.workspaceId !== workspace.workspaceId)
        throw new DatasetError('dataset_not_found', `dataset ${datasetId} not found`, 404);
      const fs = this.fsFactory(workspace);
      const target = await fs.resolve(`datasets/${datasetId}/${rec.name}`);
      const content = await readFile(target.targetKey);
      return { record: rec, content: new Uint8Array(content) };
    } catch (err) {
      this.redact(err, workspace);
    }
  }
}
