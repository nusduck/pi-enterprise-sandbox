/**
 * exec_workspaces 仓储——W3-A 要用的 workspace 持久化底座。
 *
 * 这是什么：`exec/` 自有表，存"工作区是否存在、属谁、物理根在哪"。与
 * `agent_sessions.sandbox_session_id`/`workspace_id` 是逻辑 1:1，但
 * **不在 exec 侧建 FK**——避免 agent/ exec 建表顺序的循环依赖（同
 * `20260718000001_core_platform_schema.js` 里 `agent_sessions` 与
 * `sandbox_sessions` 互为逻辑引用、不建 FK 的同一取舍）。
 *
 * 为什么现在就要：W3-A 的 `internal-session.ts ensure` 与 W3-C 的公共面
 * `upload` 都要先确保工作区存在，再做后续操作；没有这张表，HTTP 层只能
 * 依赖本机目录是否存在的"隐式存在"，重启后丢。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export interface ExecWorkspaceRecord {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExecWorkspaceInsert {
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly workspaceRoot: string;
  readonly tempRoot: string;
}

export const EXEC_WORKSPACES_DDL = `
CREATE TABLE exec_workspaces (
  workspace_id   VARCHAR(191)      NOT NULL,
  org_id         CHAR(26)          NOT NULL,
  user_id        CHAR(26)          NOT NULL,
  workspace_root VARCHAR(1024)     NOT NULL,
  temp_root      VARCHAR(1024)     NOT NULL,
  created_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                   ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (workspace_id),
  UNIQUE KEY uk_exec_workspaces_root (workspace_root),
  KEY idx_exec_workspaces_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface WorkspaceRow extends RowDataPacket {
  workspace_id: string;
  org_id: string;
  user_id: string;
  workspace_root: string;
  temp_root: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(row: WorkspaceRow): ExecWorkspaceRecord {
  return {
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    userId: row.user_id,
    workspaceRoot: row.workspace_root,
    tempRoot: row.temp_root,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MySqlWorkspaceStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_workspaces',
  ) {}

  async ensure(insert: ExecWorkspaceInsert): Promise<ExecWorkspaceRecord> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (workspace_id, org_id, user_id, workspace_root, temp_root)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = updated_at`,
      [insert.workspaceId, insert.orgId, insert.userId, insert.workspaceRoot, insert.tempRoot],
    );
    const found = await this.getById(insert.workspaceId);
    if (!found) throw new Error(`workspace ${insert.workspaceId} not found after ensure`);
    return found;
  }

  async getById(workspaceId: string): Promise<ExecWorkspaceRecord | null> {
    const [rows] = await this.pool.execute<WorkspaceRow[]>(
      `SELECT * FROM ${this.table} WHERE workspace_id = ?`,
      [workspaceId],
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async deleteById(workspaceId: string): Promise<void> {
    await this.pool.execute(`DELETE FROM ${this.table} WHERE workspace_id = ?`, [workspaceId]);
  }
}

export class InMemoryWorkspaceStore {
  private readonly map = new Map<string, ExecWorkspaceRecord>();

  async ensure(insert: ExecWorkspaceInsert): Promise<ExecWorkspaceRecord> {
    const existing = this.map.get(insert.workspaceId);
    if (existing) return existing;
    const now = new Date();
    const rec: ExecWorkspaceRecord = {
      workspaceId: insert.workspaceId,
      orgId: insert.orgId,
      userId: insert.userId,
      workspaceRoot: insert.workspaceRoot,
      tempRoot: insert.tempRoot,
      createdAt: now,
      updatedAt: now,
    };
    this.map.set(insert.workspaceId, rec);
    return rec;
  }

  async getById(workspaceId: string): Promise<ExecWorkspaceRecord | null> {
    return this.map.get(workspaceId) ?? null;
  }

  async deleteById(workspaceId: string): Promise<void> {
    this.map.delete(workspaceId);
  }
}
