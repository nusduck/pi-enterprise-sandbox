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

import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { ExecDbPool as Pool } from '../failover-pool.js';
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
  /** 交付可见性（ADR 0016 D1）。owner 公共面只认 `released`。 */
  readonly visibility: ArtifactVisibility;
  /** 审核员上传的修订版指向它替换掉的那一版；原件永不被覆盖。 */
  readonly revisionOf: string | null;
  readonly createdByKind: ArtifactCreatedByKind;
}

/**
 * 产物可见性（design `agent-output-review.md` §3.2、ADR 0016 D1）。
 *
 * - `released`：可交付。存量行与 direct 工作区都是它。
 * - `held`：审核工作区里提交、等待人工审核。owner 公共面一律拿不到。
 * - `withdrawn`：审核驳回、或审核通过后被修订版替换掉的历史版本。
 *   同样对 owner 不可见，但**审核员仍可读**（审计要能复现过程）。
 *
 * 状态只能从 `held` 单向变为 `released` / `withdrawn`，终态不可再变。
 */
export type ArtifactVisibility = 'released' | 'held' | 'withdrawn';

/** 谁提交了这一版：模型工具，还是审核员的修订上传。 */
export type ArtifactCreatedByKind = 'agent' | 'reviewer';

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
  readonly visibility?: ArtifactVisibility;
  readonly revisionOf?: string | null;
  readonly createdByKind?: ArtifactCreatedByKind;
}

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
  visibility: string | null;
  revision_of: string | null;
  created_by_kind: string | null;
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

function mapVisibility(raw: string | null): ArtifactVisibility {
  // 未知取值一律当成 `held`：库内出现看不懂的值只可能是更新的写入方，
  // 把它降级成 `released` 就是让审核静默失效。fail-closed。
  return raw === 'released' || raw === 'withdrawn' ? raw : 'held';
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
    visibility: mapVisibility(r.visibility),
    revisionOf: r.revision_of,
    createdByKind: r.created_by_kind === 'reviewer' ? 'reviewer' : 'agent',
  };
}

/** 归属查询条件：org + user 必须同时匹配，跨租户一律当作不存在。 */
export interface OwnerScope {
  readonly orgId: string;
  readonly userId: string;
}

/** Library kinds, by MIME type. Anything else only shows under "all". */
export type ArtifactKind = 'image' | 'document' | 'data';

export const ARTIFACT_KIND_MIME: Readonly<Record<ArtifactKind, readonly string[]>> = Object.freeze({
  image: ['image/%'],
  document: [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml%',
    'application/vnd.openxmlformats-officedocument.presentationml%',
    'application/vnd.ms-powerpoint',
    'text/markdown',
    'text/plain',
    'text/html',
  ],
  data: [
    'text/csv',
    'application/json',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml%',
    'application/x-parquet',
    'application/vnd.apache.parquet',
  ],
});

/** SQL-LIKE match used by the in-memory store so both stores agree. */
export function mimeMatchesKind(mime: string, kind: ArtifactKind): boolean {
  const m = mime.toLowerCase();
  return ARTIFACT_KIND_MIME[kind].some((p) => (p.endsWith('%') ? m.startsWith(p.slice(0, -1)) : m === p));
}

export interface OwnerListQuery {
  /** Case-insensitive substring of the display name or source path. */
  readonly query?: string | null;
  readonly kind?: ArtifactKind | null;
  /** Keyset cursor: artifact ids are ULIDs, so id order is creation order. */
  readonly beforeArtifactId?: string | null;
  readonly limit: number;
}

export interface ArtifactStore {
  insert(rec: ExecArtifactInsert): Promise<void>;
  /**
   * Every artifact of one owner across sessions, newest first.
   *
   * `visibility` **必填、无默认值**：owner 公共面传 `['released']`，内部/审计面
   * 才传别的。给一个默认值就等于给「忘了传」留一条静默放行待审产物的路。
   */
  listByOwner(
    scope: OwnerScope,
    q: OwnerListQuery,
    visibility: readonly ArtifactVisibility[],
  ): Promise<ExecArtifactRecord[]>;
  getOwned(artifactId: string, scope: OwnerScope): Promise<ExecArtifactRecord | null>;
  listBySession(sessionId: string, scope: OwnerScope, limit?: number): Promise<ExecArtifactRecord[]>;
  /**
   * 按**工作区**列举。公共面的 `/sessions/:id/artifacts` 用它，不用
   * `listBySession`——`session_id` 列取决于是谁写的这条记录：
   * `submit_artifact`（内部面）写的是 sandbox session id，MCP facade 写的是
   * workspace id（facade 够不到 session 概念）。用 `session_id` 过滤会让
   * facade 提交的产物在列表里彻底消失。`workspace_id` 两个写入方都是同一个值。
   *
   * `visibility` 同样必填，理由见 `listByOwner`。
   */
  listByWorkspace(
    workspaceId: string,
    scope: OwnerScope,
    visibility: readonly ArtifactVisibility[],
    limit?: number,
  ): Promise<ExecArtifactRecord[]>;
  /**
   * 按 **org** 取单件产物，**不看可见性**。
   *
   * 只给审核面用：审核员不是发起人，拿不到 owner 作用域；而「这件产物属于本
   * 任务」由 agent 的审核账本判定。所以这里是 org 作用域而不是 owner。
   */
  getInOrg(artifactId: string, orgId: string): Promise<ExecArtifactRecord | null>;
  /**
   * 一组产物的**状态变更**，单事务、幂等。
   *
   * 只允许 `held → released | withdrawn`：终态不可再变，重复投递（outbox 是
   * 至少一次）不会把已放行的产物再撤回。返回实际发生变化的行数。
   */
  applyVisibilities(
    orgId: string,
    updates: readonly ArtifactVisibilityUpdate[],
  ): Promise<number>;
}

export interface ArtifactVisibilityUpdate {
  readonly artifactId: string;
  readonly visibility: Extract<ArtifactVisibility, 'released' | 'withdrawn'>;
}

export class MySqlArtifactStore implements ArtifactStore {
  constructor(
    private readonly pool: Pool,
    private readonly table: string = 'tbl_agsvc_exec_artifacts',
  ) {}

  async insert(rec: ExecArtifactInsert): Promise<void> {
    await this.pool.execute<ResultSetHeader>(
      `INSERT INTO ${this.table}
         (artifact_id, session_id, workspace_id, org_id, user_id, name,
          source_path, mime_type, sha256, size_bytes, identity,
          visibility, revision_of, created_by_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        rec.visibility ?? 'released',
        rec.revisionOf ?? null,
        rec.createdByKind ?? 'agent',
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

  async getInOrg(artifactId: string, orgId: string): Promise<ExecArtifactRecord | null> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table} WHERE artifact_id = ? AND org_id = ?`,
      [artifactId, orgId],
    );
    return rows[0] ? mapRow(rows[0] as Row) : null;
  }

  async applyVisibilities(
    orgId: string,
    updates: readonly ArtifactVisibilityUpdate[],
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      let changed = 0;
      for (const update of updates) {
        // `WHERE visibility = 'held'` 就是单向性与幂等性：终态行不被再次改动，
        // outbox 的重复投递因此是无害的。
        const [result] = await conn.execute<ResultSetHeader>(
          `UPDATE ${this.table} SET visibility = ?
            WHERE artifact_id = ? AND org_id = ? AND visibility = 'held'`,
          [update.visibility, update.artifactId, orgId],
        );
        changed += Number(result.affectedRows ?? 0);
      }
      await conn.commit();
      return changed;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
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

  async listByOwner(
    scope: OwnerScope,
    q: OwnerListQuery,
    visibility: readonly ArtifactVisibility[],
  ): Promise<ExecArtifactRecord[]> {
    const where = ['org_id = ?', 'user_id = ?'];
    const args: Array<string | number> = [scope.orgId, scope.userId];
    where.push(`visibility IN (${visibility.map(() => '?').join(', ')})`);
    args.push(...visibility);
    if (q.query) {
      const like = `%${q.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push('(name LIKE ? OR source_path LIKE ?)');
      args.push(like, like);
    }
    if (q.kind) {
      const patterns = ARTIFACT_KIND_MIME[q.kind];
      where.push(`(${patterns.map(() => 'LOWER(mime_type) LIKE ?').join(' OR ')})`);
      args.push(...patterns);
    }
    if (q.beforeArtifactId) {
      where.push('artifact_id < ?');
      args.push(q.beforeArtifactId);
    }
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table}
        WHERE ${where.join(' AND ')}
        ORDER BY artifact_id DESC LIMIT ${sqlLimit(q.limit)}`,
      args,
    );
    return (rows as Row[]).map(mapRow);
  }

  async listByWorkspace(
    workspaceId: string,
    scope: OwnerScope,
    visibility: readonly ArtifactVisibility[],
    limit = 100,
  ): Promise<ExecArtifactRecord[]> {
    const [rows] = await this.pool.execute<Row[]>(
      `SELECT * FROM ${this.table}
        WHERE workspace_id = ? AND org_id = ? AND user_id = ?
          AND visibility IN (${visibility.map(() => '?').join(', ')})
        ORDER BY created_at DESC LIMIT ${sqlLimit(limit)}`,
      [workspaceId, scope.orgId, scope.userId, ...visibility],
    );
    return (rows as Row[]).map(mapRow);
  }
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly map = new Map<string, ExecArtifactRecord>();

  async insert(rec: ExecArtifactInsert): Promise<void> {
    this.map.set(rec.artifactId, {
      ...rec,
      visibility: rec.visibility ?? 'released',
      revisionOf: rec.revisionOf ?? null,
      createdByKind: rec.createdByKind ?? 'agent',
      createdAt: new Date(),
    });
  }

  async getOwned(artifactId: string, scope: OwnerScope): Promise<ExecArtifactRecord | null> {
    const rec = this.map.get(artifactId);
    if (!rec) return null;
    // 归属不符一律当作不存在——与 MySQL 版的 WHERE 条件同义，不要在这里
    // 退化成"找到了但拒绝"，那会泄漏存在性。
    if (rec.orgId !== scope.orgId || rec.userId !== scope.userId) return null;
    return rec;
  }

  async getInOrg(artifactId: string, orgId: string): Promise<ExecArtifactRecord | null> {
    const rec = this.map.get(artifactId);
    if (!rec || rec.orgId !== orgId) return null;
    return rec;
  }

  async applyVisibilities(
    orgId: string,
    updates: readonly ArtifactVisibilityUpdate[],
  ): Promise<number> {
    let changed = 0;
    for (const update of updates) {
      const rec = this.map.get(update.artifactId);
      // 与 MySQL 版的 `WHERE visibility = 'held'` 同义：只有 held 能被改动。
      if (!rec || rec.orgId !== orgId || rec.visibility !== 'held') continue;
      this.map.set(update.artifactId, { ...rec, visibility: update.visibility });
      changed += 1;
    }
    return changed;
  }

  async listBySession(
    sessionId: string,
    scope: OwnerScope,
    limit = 100,
  ): Promise<ExecArtifactRecord[]> {
    return this.#list((r) => r.sessionId === sessionId, scope, limit);
  }

  async listByWorkspace(
    workspaceId: string,
    scope: OwnerScope,
    visibility: readonly ArtifactVisibility[],
    limit = 100,
  ): Promise<ExecArtifactRecord[]> {
    return this.#list(
      (r) => r.workspaceId === workspaceId && visibility.includes(r.visibility),
      scope,
      limit,
    );
  }

  async listByOwner(
    scope: OwnerScope,
    q: OwnerListQuery,
    visibility: readonly ArtifactVisibility[],
  ): Promise<ExecArtifactRecord[]> {
    const needle = q.query ? q.query.toLowerCase() : null;
    return [...this.map.values()]
      .filter((r) => r.orgId === scope.orgId && r.userId === scope.userId)
      .filter((r) => visibility.includes(r.visibility))
      .filter((r) => !needle || r.name.toLowerCase().includes(needle) || r.sourcePath.toLowerCase().includes(needle))
      .filter((r) => !q.kind || mimeMatchesKind(r.mimeType, q.kind))
      .filter((r) => !q.beforeArtifactId || r.artifactId < q.beforeArtifactId)
      .sort((a, b) => (a.artifactId < b.artifactId ? 1 : -1))
      .slice(0, q.limit);
  }

  #list(
    match: (rec: ExecArtifactRecord) => boolean,
    scope: OwnerScope,
    limit: number,
  ): ExecArtifactRecord[] {
    return [...this.map.values()]
      .filter((r) => match(r) && r.orgId === scope.orgId && r.userId === scope.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}
