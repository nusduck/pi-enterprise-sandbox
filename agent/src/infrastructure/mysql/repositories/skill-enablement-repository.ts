import { applyOwnerScope, requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

export interface SkillEnablementRow {
  readonly name: string;
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly enabledByUserId: string;
}

function mapRow(row: Loose): SkillEnablementRow {
  return {
    name: String(row.skill_name),
    contentDigest: String(row.content_digest),
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes),
    enabledByUserId: String(row.enabled_by_user_id),
  };
}

export class SkillEnablementRepository {
  constructor(
    private readonly db: Loose,
    private readonly opts: { now?: () => Date; generateId?: () => string } = {},
  ) {
    if (!db) throw new Error('SkillEnablementRepository requires a knex executor');
  }

  async upsert(input: {
    orgId: string;
    userId: string;
    name: string;
    contentDigest: string;
    fileCount: number;
    totalBytes: number;
    enabledByUserId: string;
  }): Promise<void> {
    if (typeof this.opts.generateId !== 'function') {
      throw new Error('SkillEnablementRepository.upsert requires generateId');
    }
    const owner = requireOwnerScope(input);
    const now = toMysqlDateTime((this.opts.now ?? (() => new Date()))());
    const mutable = {
      content_digest: input.contentDigest,
      file_count: input.fileCount,
      total_bytes: input.totalBytes,
      enabled_by_user_id: input.enabledByUserId,
      enabled_at: now,
      updated_at: now,
    };
    await this.db('tbl_agsvc_user_skill_enablements').insert({
      enablement_id: this.opts.generateId(),
      org_id: owner.orgId,
      user_id: owner.userId,
      skill_name: input.name,
      ...mutable,
    }).onConflict(['org_id', 'user_id', 'skill_name']).merge(mutable);
  }

  /**
   * 在当前事务里锁住 owner 的 membership 行（design §3.3 第 4 条）：同一 org/user 的
   * 启用 / 停用串行，不同 owner 互不阻塞。首次启用也有行可锁（启用行此时还不存在）。
   * 行不存在时返回 `false`，由调用方 fail-closed。
   */
  async lockOwner(scope: { orgId: string; userId: string }): Promise<boolean> {
    const owner = requireOwnerScope(scope);
    const row = await applyOwnerScope(this.db('tbl_agsvc_organization_memberships'), owner)
      .forUpdate()
      .first();
    return Boolean(row);
  }

  async get(name: string, scope: { orgId: string; userId: string }): Promise<SkillEnablementRow | null> {
    const owner = requireOwnerScope(scope);
    const row = await this.db('tbl_agsvc_user_skill_enablements')
      .where({ org_id: owner.orgId, user_id: owner.userId, skill_name: name })
      .first();
    return row ? mapRow(row) : null;
  }

  /** 发现的唯一依据：这个 owner 的全部启用行。 */
  async listForOwner(scope: { orgId: string; userId: string }): Promise<SkillEnablementRow[]> {
    const owner = requireOwnerScope(scope);
    const rows = await this.db('tbl_agsvc_user_skill_enablements')
      .where({ org_id: owner.orgId, user_id: owner.userId })
      .orderBy('skill_name', 'asc');
    return rows.map(mapRow);
  }

  async remove(name: string, scope: { orgId: string; userId: string }): Promise<void> {
    const owner = requireOwnerScope(scope);
    await this.db('tbl_agsvc_user_skill_enablements').where({
      org_id: owner.orgId,
      user_id: owner.userId,
      skill_name: name,
    }).delete();
  }
}
