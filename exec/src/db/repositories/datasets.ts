/**
 * exec_datasets 仓储——数据集面底座。
 *
 * 对应 Python 版 `dataset_repository.py` 的 `datasets`，归到 exec 自有表
 * `exec_datasets`，与 agent 侧逻辑隔离。
 *
 * **2026-08-29 扩列**：`session_id` / `conversation_id` / `original_filename` /
 * `stored_relative_path` / `mime_type` / `sha256` / `size_bytes` / `status` /
 * `idempotency_key` / `completed_at`。之前表里只有 `name`，撑不起公共面的
 * `DatasetResponse`，也没有幂等键的落点——路由要求 `Idempotency-Key` 头却
 * 无处存它。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

/** 与 Python `DATASET_STATUS_*` 一致。 */
export type DatasetStatus = 'uploading' | 'ready' | 'failed';

export interface ExecDatasetRecord {
  readonly datasetId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly originalFilename: string;
  /** 工作区内的逻辑路径 `datasets/{id}/{safeName}`；未 ready 时对外为空串。 */
  readonly storedRelativePath: string;
  readonly mimeType: string;
  readonly sha256: string | null;
  readonly sizeBytes: number;
  readonly status: DatasetStatus;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface ExecDatasetInsert {
  readonly datasetId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly originalFilename: string;
  readonly storedRelativePath: string;
  readonly mimeType: string;
  readonly sha256: string | null;
  readonly sizeBytes: number;
  readonly status: DatasetStatus;
  readonly idempotencyKey: string | null;
  readonly completedAt: Date | null;
}

export const EXEC_DATASETS_DDL = `
CREATE TABLE exec_datasets (
  dataset_id            VARCHAR(64)     NOT NULL,
  session_id            VARCHAR(191)    NOT NULL,
  conversation_id       VARCHAR(191)    NOT NULL,
  workspace_id          VARCHAR(191)    NOT NULL,
  org_id                CHAR(26)        NOT NULL,
  user_id               CHAR(26)        NOT NULL,
  original_filename     VARCHAR(1024)   NOT NULL,
  stored_relative_path  VARCHAR(4096)   NOT NULL,
  mime_type             VARCHAR(255)    NOT NULL DEFAULT 'application/octet-stream',
  sha256                CHAR(64)        NULL,
  size_bytes            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status                VARCHAR(16)     NOT NULL DEFAULT 'uploading',
  idempotency_key       VARCHAR(255)    NULL,
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at          DATETIME(3)     NULL,
  PRIMARY KEY (dataset_id),
  UNIQUE KEY uniq_exec_datasets_idem (org_id, user_id, session_id, idempotency_key),
  KEY idx_exec_datasets_session (session_id),
  KEY idx_exec_datasets_workspace (workspace_id),
  KEY idx_exec_datasets_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  dataset_id: string;
  session_id: string;
  conversation_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  original_filename: string;
  stored_relative_path: string;
  mime_type: string;
  sha256: string | null;
  size_bytes: number | string;
  status: string;
  idempotency_key: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function mapRow(r: Row): ExecDatasetRecord {
  return {
    datasetId: r.dataset_id,
    sessionId: r.session_id,
    conversationId: r.conversation_id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    originalFilename: r.original_filename,
    storedRelativePath: r.stored_relative_path,
    mimeType: r.mime_type,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    status: r.status as DatasetStatus,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export interface DatasetOwnerScope {
  readonly orgId: string;
  readonly userId: string;
}

export interface DatasetStore {
  insert(rec: ExecDatasetInsert): Promise<void>;
  complete(
    datasetId: string,
    patch: { sha256: string; sizeBytes: number; status: DatasetStatus; completedAt: Date },
  ): Promise<void>;
  markFailed(datasetId: string): Promise<void>;
  getOwned(datasetId: string, scope: DatasetOwnerScope): Promise<ExecDatasetRecord | null>;
  findByIdempotencyKey(
    sessionId: string,
    scope: DatasetOwnerScope,
    key: string,
  ): Promise<ExecDatasetRecord | null>;
  listBySession(
    sessionId: string,
    scope: DatasetOwnerScope,
    limit?: number,
  ): Promise<ExecDatasetRecord[]>;
}

const COLUMNS =
  'dataset_id, session_id, conversation_id, workspace_id, org_id, user_id, ' +
  'original_filename, stored_relative_path, mime_type, sha256, size_bytes, ' +
  'status, idempotency_key, completed_at';

export class MySqlDatasetStore implements DatasetStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_datasets',
  ) {}

  async insert(rec: ExecDatasetInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.datasetId,
        rec.sessionId,
        rec.conversationId,
        rec.workspaceId,
        rec.orgId,
        rec.userId,
        rec.originalFilename,
        rec.storedRelativePath,
        rec.mimeType,
        rec.sha256,
        rec.sizeBytes,
        rec.status,
        rec.idempotencyKey,
        rec.completedAt,
      ],
    );
  }

  async complete(
    datasetId: string,
    patch: { sha256: string; sizeBytes: number; status: DatasetStatus; completedAt: Date },
  ): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE ${this.table}
          SET sha256 = ?, size_bytes = ?, status = ?, completed_at = ?
        WHERE dataset_id = ?`,
      [patch.sha256, patch.sizeBytes, patch.status, patch.completedAt, datasetId],
    );
  }

  async markFailed(datasetId: string): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `UPDATE ${this.table} SET status = 'failed' WHERE dataset_id = ?`,
      [datasetId],
    );
  }

  async getOwned(datasetId: string, scope: DatasetOwnerScope): Promise<ExecDatasetRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE dataset_id = ? AND org_id = ? AND user_id = ?`,
      [datasetId, scope.orgId, scope.userId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async findByIdempotencyKey(
    sessionId: string,
    scope: DatasetOwnerScope,
    key: string,
  ): Promise<ExecDatasetRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table}
        WHERE session_id = ? AND org_id = ? AND user_id = ? AND idempotency_key = ?`,
      [sessionId, scope.orgId, scope.userId, key],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async listBySession(
    sessionId: string,
    scope: DatasetOwnerScope,
    limit = 100,
  ): Promise<ExecDatasetRecord[]> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table}
        WHERE session_id = ? AND org_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT ?`,
      [sessionId, scope.orgId, scope.userId, limit],
    );
    return (rows as Row[]).map(mapRow);
  }
}

export class InMemoryDatasetStore implements DatasetStore {
  private readonly map = new Map<string, ExecDatasetRecord>();

  async insert(rec: ExecDatasetInsert): Promise<void> {
    this.map.set(rec.datasetId, { ...rec, createdAt: new Date() });
  }

  async complete(
    datasetId: string,
    patch: { sha256: string; sizeBytes: number; status: DatasetStatus; completedAt: Date },
  ): Promise<void> {
    const rec = this.map.get(datasetId);
    if (rec) this.map.set(datasetId, { ...rec, ...patch });
  }

  async markFailed(datasetId: string): Promise<void> {
    const rec = this.map.get(datasetId);
    if (rec) this.map.set(datasetId, { ...rec, status: 'failed' });
  }

  async getOwned(datasetId: string, scope: DatasetOwnerScope): Promise<ExecDatasetRecord | null> {
    const rec = this.map.get(datasetId);
    if (!rec) return null;
    // 归属不符当作不存在，与 MySQL 的 WHERE 同义——不要退化成"找到了但拒绝"。
    if (rec.orgId !== scope.orgId || rec.userId !== scope.userId) return null;
    return rec;
  }

  async findByIdempotencyKey(
    sessionId: string,
    scope: DatasetOwnerScope,
    key: string,
  ): Promise<ExecDatasetRecord | null> {
    for (const rec of this.map.values()) {
      if (
        rec.sessionId === sessionId &&
        rec.orgId === scope.orgId &&
        rec.userId === scope.userId &&
        rec.idempotencyKey === key
      ) {
        return rec;
      }
    }
    return null;
  }

  async listBySession(
    sessionId: string,
    scope: DatasetOwnerScope,
    limit = 100,
  ): Promise<ExecDatasetRecord[]> {
    return [...this.map.values()]
      .filter(
        (r) => r.sessionId === sessionId && r.orgId === scope.orgId && r.userId === scope.userId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
