/**
 * exec_artifacts 仓储——W3-B 产物面（submit/download）底座。
 *
 * 对应 Python 版 `artifact_repository.py` 的 `artifacts`，列与
 * `sandbox/app/persistence/repositories/artifact_repository.py:TABLE`
 * 对齐，但归到 exec 自有表 `exec_artifacts`，与 agent 侧 `artifacts`
 * 逻辑隔离（同 §6“exec 侧只写自己的表”）。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ExecArtifactRecord {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export interface ExecArtifactInsert {
  readonly artifactId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export const EXEC_ARTIFACTS_DDL = `
CREATE TABLE exec_artifacts (
  artifact_id  VARCHAR(64)       NOT NULL,
  workspace_id VARCHAR(191)      NOT NULL,
  org_id       CHAR(26)          NOT NULL,
  user_id      CHAR(26)          NOT NULL,
  filename     VARCHAR(1024)     NOT NULL,
  size_bytes   BIGINT UNSIGNED   NOT NULL,
  created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (artifact_id),
  KEY idx_exec_artifacts_workspace (workspace_id),
  KEY idx_exec_artifacts_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  artifact_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  filename: string;
  size_bytes: number | string;
  created_at: Date;
}

function mapRow(r: Row): ExecArtifactRecord {
  return {
    artifactId: r.artifact_id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    filename: r.filename,
    sizeBytes: Number(r.size_bytes),
    createdAt: r.created_at,
  };
}

export class MySqlArtifactStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_artifacts',
  ) {}

  async insert(rec: ExecArtifactInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (artifact_id, workspace_id, org_id, user_id, filename, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [rec.artifactId, rec.workspaceId, rec.orgId, rec.userId, rec.filename, rec.sizeBytes],
    );
  }

  async getById(artifactId: string): Promise<ExecArtifactRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE artifact_id = ?`,
      [artifactId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async listByWorkspace(workspaceId: string, limit = 100): Promise<ExecArtifactRecord[]> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?`,
      [workspaceId, limit],
    );
    return (rows as Row[]).map(mapRow);
  }
}

export class InMemoryArtifactStore {
  private readonly map = new Map<string, ExecArtifactRecord>();

  async insert(rec: ExecArtifactInsert): Promise<void> {
    this.map.set(rec.artifactId, { ...rec, createdAt: new Date() });
  }

  async getById(artifactId: string): Promise<ExecArtifactRecord | null> {
    return this.map.get(artifactId) ?? null;
  }

  async listByWorkspace(workspaceId: string, limit = 100): Promise<ExecArtifactRecord[]> {
    return [...this.map.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
