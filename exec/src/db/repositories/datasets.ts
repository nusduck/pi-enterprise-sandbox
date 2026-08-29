/**
 * exec_datasets 仓储——W3-B 数据集面底座。
 *
 * 对应 Python 版 `dataset_repository.py` 的 `datasets`，同样归到 exec
 * 自有表 `exec_datasets`，与 agent 侧逻辑隔离。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ExecDatasetRecord {
  readonly datasetId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface ExecDatasetInsert {
  readonly datasetId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

export const EXEC_DATASETS_DDL = `
CREATE TABLE exec_datasets (
  dataset_id   VARCHAR(64)       NOT NULL,
  workspace_id VARCHAR(191)      NOT NULL,
  org_id       CHAR(26)          NOT NULL,
  user_id      CHAR(26)          NOT NULL,
  name         VARCHAR(1024)     NOT NULL,
  created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (dataset_id),
  KEY idx_exec_datasets_workspace (workspace_id),
  KEY idx_exec_datasets_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  dataset_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

function mapRow(r: Row): ExecDatasetRecord {
  return {
    datasetId: r.dataset_id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    name: r.name,
    createdAt: r.created_at,
  };
}

export class MySqlDatasetStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_datasets',
  ) {}

  async insert(rec: ExecDatasetInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (dataset_id, workspace_id, org_id, user_id, name)
       VALUES (?, ?, ?, ?, ?)`,
      [rec.datasetId, rec.workspaceId, rec.orgId, rec.userId, rec.name],
    );
  }

  async getById(datasetId: string): Promise<ExecDatasetRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE dataset_id = ?`,
      [datasetId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }
}

export class InMemoryDatasetStore {
  private readonly map = new Map<string, ExecDatasetRecord>();

  async insert(rec: ExecDatasetInsert): Promise<void> {
    this.map.set(rec.datasetId, { ...rec, createdAt: new Date() });
  }

  async getById(datasetId: string): Promise<ExecDatasetRecord | null> {
    return this.map.get(datasetId) ?? null;
  }
}
