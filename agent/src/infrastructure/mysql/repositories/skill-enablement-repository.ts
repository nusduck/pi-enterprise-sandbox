import { requireOwnerScope } from '../ownership.js';
import { toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

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
    await this.db('user_skill_enablements').insert({
      enablement_id: this.opts.generateId(),
      org_id: owner.orgId,
      user_id: owner.userId,
      skill_name: input.name,
      ...mutable,
    }).onConflict(['org_id', 'user_id', 'skill_name']).merge(mutable);
  }

  async remove(name: string, scope: { orgId: string; userId: string }): Promise<void> {
    const owner = requireOwnerScope(scope);
    await this.db('user_skill_enablements').where({
      org_id: owner.orgId,
      user_id: owner.userId,
      skill_name: name,
    }).delete();
  }
}
