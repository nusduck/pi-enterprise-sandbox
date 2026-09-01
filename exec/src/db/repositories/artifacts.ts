/**
 * exec_artifacts 仓储——产物面（submit/list/download）底座。
 *
 * 对应 Python 版 `artifact_repository.py` 的 `artifacts`，归到 exec 自有表
 * `exec_artifacts`，与 agent 侧 `artifacts` 逻辑隔离（§6"exec 侧只写自己的表"）。
 *
 * **2026-08-29 扩列**：`sha256` / `mime_type` / `source_path` / `identity` /
 * `session_id`。前两个是公共面 `ArtifactResponse` 的必需字段（之前表里没有，
 * 所以路由只能编一个 `'0'.repeat(64)` 出来）；`identity` 存快照的
 * dev/ino/size/mtime，下载时据此发现快照被替换；`session_id` 让
 * `list_by_session` 与跨租户 404 有依据，不必拿 workspaceId 凑。
 */

import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { FileIdentity } from '../../artifact/control-plane-storage.js';
import { sqlLimit } from '../client.js';

export interface ExecArtifactRecord {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  /** 用户可见的显示名（可能是没有扩展名的标题）。 */
  readonly name: string;
  /** 提交时的工作区逻辑源路径；下载时借它补扩展名。 */
  readonly sourcePath: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly identity: FileIdentity | null;
  readonly createdAt: Date;
}

export interface ExecArtifactInsert {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly identity: FileIdentity | null;
}

export const EXEC_ARTIFACTS_DDL = `
CREATE TABLE exec_artifacts (
  artifact_id  VARCHAR(64)       NOT NULL,
  session_id   VARCHAR(191)      NOT NULL,
  workspace_id VARCHAR(191)      NOT NULL,
  org_id       CHAR(26)          NOT NULL,
  user_id      CHAR(26)          NOT NULL,
  name         VARCHAR(1024)     NOT NULL,
  source_path  VARCHAR(4096)     NOT NULL,
  mime_type    VARCHAR(255)      NOT NULL DEFAULT 'application/octet-stream',
  sha256       CHAR(64)          NOT NULL,
  size_bytes   BIGINT UNSIGNED   NOT NULL,
  identity     JSON              NULL,
  created_at   DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (artifact_id),
  KEY idx_exec_artifacts_session (session_id),
  KEY idx_exec_artifacts_workspace (workspace_id),
  KEY idx_exec_artifacts_owner (org_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`.trim();

interface Row extends RowDataPacket {
  artifact_id: string;
  session_id: string;
  workspace_id: string;
  org_id: string;
  user_id: string;
  name: string;
  source_path: string;
  mime_type: string;
  sha256: string;
  size_bytes: number | string;
  identity: string | object | null;
  created_at: Date;
}

function parseIdentity(raw: string | object | null): FileIdentity | null {
  if (raw === null) return null;
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (value === null || typeof value !== 'object') return null;
  return value as FileIdentity;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapRow(r: Row): ExecArtifactRecord {
  return {
    artifactId: r.artifact_id,
    sessionId: r.session_id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    name: r.name,
    sourcePath: r.source_path,
    mimeType: r.mime_type,
    sha256: r.sha256,
    sizeBytes: Number(r.size_bytes),
    identity: parseIdentity(r.identity),
    createdAt: r.created_at,
  };
}

/** 归属查询条件：org + user 必须同时匹配，跨租户一律当作不存在。 */
export interface OwnerScope {
  readonly orgId: string;
  readonly userId: string;
}

export interface ArtifactStore {
  insert(rec: ExecArtifactInsert): Promise<void>;
  getOwned(artifactId: string, scope: OwnerScope): Promise<ExecArtifactRecord | null>;
  listBySession(sessionId: string, scope: OwnerScope, limit?: number): Promise<ExecArtifactRecord[]>;
}

export class MySqlArtifactStore implements ArtifactStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'exec_artifacts',
  ) {}

  async insert(rec: ExecArtifactInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table}
         (artifact_id, session_id, workspace_id, org_id, user_id, name,
          source_path, mime_type, sha256, size_bytes, identity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.artifactId,
        rec.sessionId,
        rec.workspaceId,
        rec.orgId,
        rec.userId,
        rec.name,
        rec.sourcePath,
        rec.mimeType,
        rec.sha256,
        rec.sizeBytes,
        rec.identity === null ? null : JSON.stringify(rec.identity),
      ],
    );
  }

  async getOwned(artifactId: string, scope: OwnerScope): Promise<ExecArtifactRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE artifact_id = ? AND org_id = ? AND user_id = ?`,
      [artifactId, scope.orgId, scope.userId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async listBySession(
    sessionId: string,
    scope: OwnerScope,
    limit = 100,
  ): Promise<ExecArtifactRecord[]> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table}
        WHERE session_id = ? AND org_id = ? AND user_id = ?
        ORDER BY created_at DESC LIMIT ${sqlLimit(limit)}`,
      [sessionId, scope.orgId, scope.userId],
    );
    return (rows as Row[]).map(mapRow);
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly map = new Map<string, ExecArtifactRecord>();

  async insert(rec: ExecArtifactInsert): Promise<void> {
    this.map.set(rec.artifactId, { ...rec, createdAt: new Date() });
  }

  async getOwned(artifactId: string, scope: OwnerScope): Promise<ExecArtifactRecord | null> {
    const rec = this.map.get(artifactId);
    if (!rec) return null;
    // 归属不符一律当作不存在——与 MySQL 版的 WHERE 条件同义，不要在这里
    // 退化成"找到了但拒绝"，那会泄漏存在性。
    if (rec.orgId !== scope.orgId || rec.userId !== scope.userId) return null;
    return rec;
  }

  async listBySession(
    sessionId: string,
    scope: OwnerScope,
    limit = 100,
  ): Promise<ExecArtifactRecord[]> {
    return [...this.map.values()]
      .filter(
        (r) => r.sessionId === sessionId && r.orgId === scope.orgId && r.userId === scope.userId,
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
