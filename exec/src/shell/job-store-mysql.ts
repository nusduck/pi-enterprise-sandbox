/**
 * `JobStore` 的 MySQL 实现。ADR 0008 D7 要求"Worker 重启后仍能查到进程"，
 * 这个文件是唯一让作业记录真正跨进程重启存活的地方——`job-registry.ts`
 * 的其余部分完全不知道底下是 MySQL 还是别的什么。
 *
 * 表结构：**本任务不写迁移**（迁移权威在 `agent/`，见任务说明）。这里假定
 * 一张新表 `exec_jobs`（默认表名，可通过构造参数覆盖），列定义、索引、
 * 建表理由写在交付报告里给 W3-D。**没有做"复用 `process_executions`"**，
 * 原因是那张表的 `sandbox_session_id`/`run_id`/`execution_id` 三列都是
 * `NOT NULL` 且外键指向 `sandbox_sessions`/`runs`——那是 Agent 侧会话概念，
 * `exec/` 内部信封（`contract/src/envelope.ts`）只到 `workspaceId` 这一层，
 * 没有 `sandbox_session_id`。把两者塞进同一张表要么破坏现有 NOT NULL 约束，
 * 要么让 exec 反过来依赖 agent 的会话表，两条都不如开一张 exec 自己的表
 * （ADR 0008 §6 明确允许："exec 侧用同一个 MySQL，只写自己的表（workspace、
 * execution、process、dataset、artifact、audit）"——`process` 就在其中）。
 *
 * 每个方法都是一条参数化 SQL，不拼接调用方输入到语句文本里。
 */
import type { Pool, RowDataPacket } from 'mysql2/promise';
import { sqlLimit } from '../db/client.js';
import type {
  JobOwnerScope,
  JobRecord,
  JobRecordInsert,
  JobRecordStatusPatch,
  JobStatus,
  JobStore,
} from './job-types.js';

/** 默认表名——见文件头关于为什么不是 `process_executions` 的说明。 */
export const DEFAULT_JOBS_TABLE = 'exec_jobs';

interface JobRow extends RowDataPacket {
  process_id: string;
  kind: string;
  label: string;
  org_id: string;
  user_id: string;
  workspace_id: string;
  run_id: string | null;
  status: string;
  detail: string | null;
  output_limit_bytes: number | null;
  pid: number | null;
  pgid: number | null;
  start_identity: string | null;
  exit_code: number | null;
  reported: number;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
}

function mapRow(row: JobRow): JobRecord {
  return {
    id: row.process_id,
    kind: 'bash',
    label: row.label,
    orgId: row.org_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    status: row.status as JobStatus,
    detail: row.detail,
    outputLimitBytes: row.output_limit_bytes,
    pid: row.pid,
    pgid: row.pgid,
    startIdentity: row.start_identity,
    exitCode: row.exit_code,
    reported: row.reported !== 0,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export class MySqlJobStore implements JobStore {
  private readonly table: string;

  constructor(
    private readonly pool: Pool,
    table: string = DEFAULT_JOBS_TABLE,
  ) {
    this.table = table;
  }

  async insert(record: JobRecordInsert): Promise<void> {
    await this.pool.execute(
      `INSERT INTO ${this.table} (
        process_id, kind, label, org_id, user_id, workspace_id, run_id,
        status, detail, output_limit_bytes, pid, pgid, start_identity,
        exit_code, reported, started_at, finished_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, NULL, 0, ?, NULL, ?)`,
      [
        record.id,
        record.kind,
        record.label,
        record.orgId,
        record.userId,
        record.workspaceId,
        record.runId,
        record.outputLimitBytes,
        record.pid,
        record.pgid,
        record.startIdentity,
        record.createdAt,
        record.createdAt,
      ],
    );
  }

  async updateStatus(id: string, owner: JobOwnerScope, patch: JobRecordStatusPatch): Promise<void> {
    // COALESCE 语义：只覆盖传入的字段，未传的保留原值——对齐现有
    // `process_repository.py` 的 `update_status` 写法。`status`/`detail`
    // 允许被显式写成合法值；`detail` 需要"允许清空成 NULL"，所以用
    // 一个哨兵参数区分"未传"和"传了 null"。
    const hasDetail = patch.detail !== undefined;
    await this.pool.execute(
      `UPDATE ${this.table}
       SET status = ?,
           detail = CASE WHEN ? THEN ? ELSE detail END,
           pid = COALESCE(?, pid),
           pgid = COALESCE(?, pgid),
           start_identity = COALESCE(?, start_identity),
           exit_code = COALESCE(?, exit_code),
           reported = COALESCE(?, reported),
           started_at = COALESCE(?, started_at),
           finished_at = COALESCE(?, finished_at)
       WHERE process_id = ? AND org_id = ? AND user_id = ? AND workspace_id = ?`,
      [
        patch.status,
        hasDetail,
        hasDetail ? patch.detail : null,
        patch.pid ?? null,
        patch.pgid ?? null,
        patch.startIdentity ?? null,
        patch.exitCode ?? null,
        patch.reported === undefined ? null : patch.reported ? 1 : 0,
        patch.startedAt ?? null,
        patch.finishedAt ?? null,
        id,
        owner.orgId,
        owner.userId,
        owner.workspaceId,
      ],
    );
    // 行不存在（或不是这个 owner 的）时 MySQL 报告 affectedRows=0 而不是抛错；
    // 用一次 owner-scoped 读做权威存在性检查（对齐 Python 版
    // `ProcessRepository.update_status` 同一条注释的取舍）。
    const after = await this.getById(id, owner);
    if (after === null) {
      throw new Error(`job ${id} not found`);
    }
  }

  async getById(id: string, owner: JobOwnerScope): Promise<JobRecord | null> {
    const [rows] = await this.pool.execute<JobRow[]>(
      `SELECT * FROM ${this.table}
       WHERE process_id = ? AND org_id = ? AND user_id = ? AND workspace_id = ?`,
      [id, owner.orgId, owner.userId, owner.workspaceId],
    );
    const row = rows[0];
    return row !== undefined ? mapRow(row) : null;
  }

  async listByOwner(owner: JobOwnerScope, limit = 100): Promise<JobRecord[]> {
    const [rows] = await this.pool.execute<JobRow[]>(
      `SELECT * FROM ${this.table}
       WHERE org_id = ? AND user_id = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ${sqlLimit(limit)}`,
      [owner.orgId, owner.userId, owner.workspaceId],
    );
    return rows.map(mapRow);
  }

  async listByRun(runId: string, owner: JobOwnerScope, limit = 100): Promise<JobRecord[]> {
    const [rows] = await this.pool.execute<JobRow[]>(
      `SELECT * FROM ${this.table}
       WHERE run_id = ? AND org_id = ? AND user_id = ? AND workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ${sqlLimit(limit)}`,
      [runId, owner.orgId, owner.userId, owner.workspaceId],
    );
    return rows.map(mapRow);
  }

  async countActiveForOwner(owner: JobOwnerScope): Promise<number> {
    const [rows] = await this.pool.execute<(RowDataPacket & { n: number })[]>(
      `SELECT COUNT(*) AS n FROM ${this.table}
       WHERE org_id = ? AND user_id = ? AND workspace_id = ?
         AND status IN ('running', 'stopping')`,
      [owner.orgId, owner.userId, owner.workspaceId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 系统级、无租户过滤——只允许在服务启动、挂载用户路由之前调用。
   * 对齐 `process_repository.py` 的 `list_active_for_recovery` 同一条注释。
   */
  async listActiveForRecovery(limit = 1000): Promise<JobRecord[]> {
    const [rows] = await this.pool.execute<JobRow[]>(
      `SELECT * FROM ${this.table}
       WHERE status IN ('running', 'stopping')
       ORDER BY created_at ASC
       LIMIT ${sqlLimit(limit)}`,
      [],
    );
    return rows.map(mapRow);
  }
}
