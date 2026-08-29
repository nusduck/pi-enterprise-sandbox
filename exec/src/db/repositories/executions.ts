/**
 * exec_executions 仓储——W3-A/B 要用的执行记录底座。
 *
 * 对应 Python 版 `sandbox/app/persistence/repositories/execution_repository.py`
 * 的 `sandbox_executions`，但在 exec 侧重命名为 `exec_executions`，避免
 * 与 `agent` 侧的 `runs`/`run_events` 重名，且同样**不建 FK** 到
 * `exec_workspaces`（逻辑引用，见 `workspaces.ts` 同一取舍）。
 *
 * 每个执行（execution）是对一次 `job-registry.start()` / `executor.run()`
 * 的持久化镜像，供 W3-A 的 `internal-shell` 读状态、W3-C 的公共面做
 * 审计回溯用。`command` 存原文 `label`，`status` 与 `JobStatus` 同步。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';

export type ExecExecutionStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface ExecExecutionRecord {
  readonly executionId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly command: string;
  readonly status: ExecExecutionStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExecExecutionInsert {
  readonly executionId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly command: string;
}

export const EXEC_EXECUTIONS_DDL = `
CREATE TABLE exec_executions (
  execution_id VARCHAR(64)       NOT NULL,
  workspace_id VARCHAR(191)      NOT NULL,
  org_id       CHAR(26)          NOT NULL,
  user_id      CHAR(26)          NOT NULL,
  command      TEXT              NOT NULL,
  status       VARCHAR(32)       NOT NULL DEFAULT 'running',
  created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (execution_id),
  KEY idx_exec_executions_workspace (workspace_id),
  KEY idx_exec_executions_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  execution_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  command: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

function mapRow(r: Row): ExecExecutionRecord {
  return {
    executionId: r.execution_id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    command: r.command,
    status: r.status as ExecExecutionStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class MySqlExecutionStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_executions',
  ) {}

  async insert(rec: ExecExecutionInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table} (execution_id, workspace_id, org_id, user_id, command)
       VALUES (?, ?, ?, ?, ?)`,
      [rec.executionId, rec.workspaceId, rec.orgId, rec.userId, rec.command],
    );
  }

  async getById(executionId: string): Promise<ExecExecutionRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE execution_id = ?`,
      [executionId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async updateStatus(executionId: string, status: ExecExecutionStatus): Promise<void> {
    await this.pool.execute(`UPDATE ${this.table} SET status = ? WHERE execution_id = ?`, [
      status,
      executionId,
    ]);
  }
}

export class InMemoryExecutionStore {
  private readonly map = new Map<string, ExecExecutionRecord>();

  async insert(rec: ExecExecutionInsert): Promise<void> {
    const now = new Date();
    this.map.set(rec.executionId, {
      executionId: rec.executionId,
      workspaceId: rec.workspaceId,
      orgId: rec.orgId,
      userId: rec.userId,
      command: rec.command,
      status: 'running',
      createdAt: now,
      updatedAt: now,
    });
  }

  async getById(executionId: string): Promise<ExecExecutionRecord | null> {
    return this.map.get(executionId) ?? null;
  }

  async updateStatus(executionId: string, status: ExecExecutionStatus): Promise<void> {
    const rec = this.map.get(executionId);
    if (rec) this.map.set(executionId, { ...rec, status, updatedAt: new Date() });
  }
}
