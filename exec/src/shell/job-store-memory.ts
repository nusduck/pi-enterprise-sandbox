/**
 * `JobStore` 的内存实现——只供测试使用（约束 #7："测试不能依赖真的...
 * 依赖 MySQL 在跑"）。行为上是 `job-store-mysql.ts` 的忠实简化版：同样的
 * owner 过滤、同样的"不是你的"和"不存在"返回同一个 `null`。
 *
 * 不做任何持久化——进程退出即丢，这正是它只能用于测试、不能用于生产的
 * 原因（生产要满足"Worker 重启后仍能查到进程"，见 ADR 0008 D7）。
 */
import type {
  JobOwnerScope,
  JobRecord,
  JobRecordInsert,
  JobRecordStatusPatch,
  JobStore,
} from './job-types.js';

function ownedBy(record: JobRecord, owner: JobOwnerScope): boolean {
  return (
    record.orgId === owner.orgId &&
    record.userId === owner.userId &&
    record.workspaceId === owner.workspaceId
  );
}

export class InMemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRecord>();

  async insert(record: JobRecordInsert): Promise<void> {
    if (this.rows.has(record.id)) {
      throw new Error(`job ${record.id} already exists`);
    }
    this.rows.set(record.id, {
      ...record,
      status: 'running',
      detail: null,
      exitCode: null,
      reported: false,
      startedAt: record.createdAt,
      finishedAt: null,
    });
  }

  async updateStatus(id: string, owner: JobOwnerScope, patch: JobRecordStatusPatch): Promise<void> {
    const existing = this.rows.get(id);
    if (existing === undefined || !ownedBy(existing, owner)) {
      throw new Error(`job ${id} not found`);
    }
    const next: JobRecord = {
      ...existing,
      status: patch.status,
      detail: patch.detail !== undefined ? patch.detail : existing.detail,
      pid: patch.pid !== undefined ? patch.pid : existing.pid,
      pgid: patch.pgid !== undefined ? patch.pgid : existing.pgid,
      startIdentity: patch.startIdentity !== undefined ? patch.startIdentity : existing.startIdentity,
      exitCode: patch.exitCode !== undefined ? patch.exitCode : existing.exitCode,
      reported: patch.reported !== undefined ? patch.reported : existing.reported,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : existing.startedAt,
      finishedAt: patch.finishedAt !== undefined ? patch.finishedAt : existing.finishedAt,
    };
    this.rows.set(id, next);
  }

  async getById(id: string, owner: JobOwnerScope): Promise<JobRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || !ownedBy(row, owner)) return null;
    return { ...row };
  }

  async listByOwner(owner: JobOwnerScope, limit = 100): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    for (const row of this.rows.values()) {
      if (ownedBy(row, owner)) out.push({ ...row });
    }
    out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return out.slice(0, Math.max(0, limit));
  }

  async listByRun(runId: string, owner: JobOwnerScope, limit = 100): Promise<JobRecord[]> {
    const out = (await this.listByOwner(owner, Number.MAX_SAFE_INTEGER)).filter(
      (row) => row.runId === runId,
    );
    return out.slice(0, Math.max(0, limit));
  }

  async countActiveForOwner(owner: JobOwnerScope): Promise<number> {
    let n = 0;
    for (const row of this.rows.values()) {
      if (!ownedBy(row, owner)) continue;
      if (row.status === 'running' || row.status === 'stopping') n += 1;
    }
    return n;
  }

  async listActiveForRecovery(limit = 1000): Promise<JobRecord[]> {
    const out: JobRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.status === 'running' || row.status === 'stopping') {
        out.push({ ...row });
      }
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out.slice(0, Math.max(0, limit));
  }

  /** 测试专用：直接读全部行（不做 owner 过滤），断言用。 */
  debugAllRows(): JobRecord[] {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
