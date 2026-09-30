/**
 * org 层共享 Skill 的账本读写（ADR 0015 D5/D6/D8，design §5.2/§5.3）。
 *
 * 三张表各管一件事，这个仓储把它们收成三个用途：
 * - **读**：`getVersion` 给 Run 解析用（它必须在 O(1) 内回答「这个 (name, digest)
 *   存在吗、是什么状态」）；`listForOrg` 给配置面与管理员列表用。
 * - **写**：`publishVersion` 在**一个事务里**占位/锁名、插版本、可选改 current 指针。
 * - **状态**：`setStatus` 是弃用/吊销，带留痕（谁、何时、为什么）。
 *
 * ## 为什么锁的是 `org_skills` 的那一行
 *
 * design §5.3：同 org 同名串行，不同名不互锁。行锁对象必须是「名字」而不是「版本」——
 * 两个管理员同时给同一个名字发版本时，要串行的是**名字**这一层。
 * 首次发布时那一行还不存在，所以先 `INSERT … ON DUPLICATE KEY UPDATE` 占位再 `FOR UPDATE`：
 * 少了占位，两个并发首发布会同时走到「不存在」分支，各自插入，唯一键其中之一报错而不是排队。
 *
 * ## 为什么 `revoked` 不能复活
 *
 * design §7.1：撤销过的摘要不允许再次发布（防止原样回流）。判定放在 `publishVersion`
 * 里、锁内进行，所以它与并发发布互斥。
 */
import { physicalTableName } from '../schema-tables.js';
import { formatDateTime, toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

const VERSIONS = physicalTableName('org_skill_versions');
const SKILLS = physicalTableName('org_skills');
const REQUESTS = physicalTableName('skill_share_requests');

/**
 * org 层是 **org 作用域**，没有 `userId` 维度——所以不能用 `requireOwnerScope`
 * （它要求两个都非空）。空 orgId 一律拒绝，避免 `where({ org_id: '' })` 静默命中
 * 零行并被当成「这个 org 没有 org 层」。
 */
function requireOrgId(input: { orgId?: unknown }): string {
  const orgId = input?.orgId != null ? String(input.orgId).trim() : '';
  if (!orgId) throw new Error('OrgSkillRepository requires a non-empty orgId');
  return orgId;
}

/** 一个 org 版本的完整状态。 */
export interface OrgSkillVersionRow {
  readonly versionId: string;
  readonly orgId: string;
  readonly name: string;
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly description: string;
  readonly originKind: 'share_request' | 'admin_upload';
  readonly originUserId: string;
  readonly originRequestId: string;
  readonly status: 'active' | 'deprecated' | 'revoked';
  readonly publishedByUserId: string;
  readonly publishedAt: string;
}

/** 配置面/管理员列表要的形状：每名一行，带版本与 current 指针。 */
export interface OrgSkillNameRow {
  readonly name: string;
  readonly currentDigest: string;
  readonly versions: readonly OrgSkillVersionRow[];
}

function mapVersion(row: Loose): OrgSkillVersionRow {
  return {
    versionId: String(row.version_id),
    orgId: String(row.org_id),
    name: String(row.skill_name),
    contentDigest: String(row.content_digest),
    fileCount: Number(row.file_count),
    totalBytes: Number(row.total_bytes),
    description: String(row.description ?? ''),
    originKind: String(row.origin_kind) === 'share_request' ? 'share_request' : 'admin_upload',
    originUserId: String(row.origin_user_id ?? ''),
    originRequestId: String(row.origin_request_id ?? ''),
    status: String(row.status) === 'revoked'
      ? 'revoked'
      : String(row.status) === 'deprecated'
        ? 'deprecated'
        : 'active',
    publishedByUserId: String(row.published_by_user_id ?? ''),
    // 连接开了 dateStrings，读回的是无时区的 UTC 串；统一转成带 Z 的 ISO，否则浏览器按本地时间解析。
    publishedAt: formatDateTime(row.published_at) ?? '',
  };
}

/** 发布/状态流转里可预期的失败。`code` 直接给到 HTTP 层。 */
export class OrgSkillError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OrgSkillError';
    this.code = code;
  }
}

export class OrgSkillRepository {
  constructor(
    private readonly db: Loose,
    private readonly opts: { now?: () => Date; generateId?: () => string } = {},
  ) {
    if (!db) throw new Error('OrgSkillRepository requires a knex executor');
  }

  private now(): Date {
    return (this.opts.now ?? (() => new Date()))();
  }

  private id(): string {
    if (typeof this.opts.generateId !== 'function') {
      throw new Error('OrgSkillRepository requires generateId');
    }
    return this.opts.generateId();
  }

  /**
   * 一个 (org, name, digest) 的状态。Run 解析只关心这个。
   *
   * 不存在返回 `null` —— 调用方据此写 `missing` 诊断，**不能**当成 active。
   */
  async getVersion(input: {
    orgId: string;
    name: string;
    contentDigest: string;
  }): Promise<OrgSkillVersionRow | null> {
    const orgId = requireOrgId(input);
    const row = await this.db(VERSIONS).where({
      org_id: orgId,
      skill_name: input.name,
      content_digest: input.contentDigest,
    }).first();
    return row ? mapVersion(row) : null;
  }

  /**
   * 本 org **可被新绑定**的版本（`active` / `deprecated`），按名字排序。
   *
   * 与 `listForOrg` 分开是因为用途不同：配置面校验要的是「哪些能被钉」，而
   * `revoked` 在配置面等于不存在（ADR 0015 D8）。在 SQL 里过滤掉它，比取回全量
   * 再在调用方筛更省内存，也让意图写在唯一一处。
   */
  async listBindableVersions(input: { orgId: string }): Promise<OrgSkillVersionRow[]> {
    const orgId = requireOrgId(input);
    const rows: Loose[] = await this.db(VERSIONS)
      .where({ org_id: orgId })
      .whereIn('status', ['active', 'deprecated'])
      .orderBy([{ column: 'skill_name', order: 'asc' }, { column: 'published_at', order: 'desc' }]);
    return rows.map(mapVersion);
  }

  /**
   * 本 org 被 org 层**占用**的名字（ADR 0015 D7 的用户启用约束）。
   *
   * `excludeAuthorUserId` 是作者豁免：被提升过的 Skill 的**原作者**要能继续启用自己
   * 的草稿新版本，否则他没法迭代（design §7.3）。豁免只给原作者——别人仍然被挡。
   *
   * 只算**非 `revoked`** 的版本：一个名字的所有版本都被撤销之后，它不再是保留名。
   */
  async reservedNamesForOrg(input: {
    orgId: string;
    excludeAuthorUserId?: string;
  }): Promise<Set<string>> {
    const orgId = requireOrgId(input);
    const rows: Loose[] = await this.db(VERSIONS)
      .where({ org_id: orgId })
      // `whereNotIn` 而不是 `whereNot`：两者语义等价（都是「status 不等于 revoked」），
      // 而这是测试替身支持的写法——替身缺的方法会让这条查询在单测里直接崩。
      .whereNotIn('status', ['revoked'])
      .select('skill_name', 'origin_user_id');
    const reserved = new Set<string>();
    for (const row of rows) {
      const name = String(row.skill_name);
      if (input.excludeAuthorUserId !== undefined
        && String(row.origin_user_id ?? '') === String(input.excludeAuthorUserId)) {
        continue;
      }
      reserved.add(name);
    }
    return reserved;
  }

  /** 本 org 的全部 org 层名字与版本（管理员列表）。 */
  async listForOrg(input: { orgId: string }): Promise<OrgSkillNameRow[]> {
    const orgId = requireOrgId(input);
    const versions: Loose[] = await this.db(VERSIONS)
      .where({ org_id: orgId })
      .orderBy([{ column: 'skill_name', order: 'asc' }, { column: 'published_at', order: 'desc' }]);
    const pointers: Loose[] = await this.db(SKILLS).where({ org_id: orgId });
    const current = new Map<string, string>(
      pointers.map((row: Loose) => [String(row.skill_name), String(row.current_digest ?? '')]),
    );
    const byName = new Map<string, OrgSkillVersionRow[]>();
    for (const row of versions.map(mapVersion)) {
      const list = byName.get(row.name) ?? [];
      list.push(row);
      byName.set(row.name, list);
    }
    return [...byName.entries()]
      .map(([name, list]) => ({
        name,
        currentDigest: current.get(name) ?? '',
        versions: list,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * 发布一个新版本（字节已经落盘，这里只写账本）。
   *
   * `setCurrent` 为真时同时把「当前推荐版本」指到它。**已钉住的 AgentVersion 不受影响**
   * ——那是 ADR 0015 D3 的全部意义。
   */
  async publishVersion(input: {
    orgId: string;
    name: string;
    contentDigest: string;
    fileCount: number;
    totalBytes: number;
    description: string;
    originKind: 'share_request' | 'admin_upload';
    originUserId: string;
    originRequestId?: string;
    publishedByUserId: string;
    setCurrent?: boolean;
  }): Promise<OrgSkillVersionRow> {
    const orgId = requireOrgId(input);
    return this.db.transaction(async (trx: Loose) => {
      await this.lockName(trx, orgId, input.name);
      const existing: Loose = await trx(VERSIONS).where({
        org_id: orgId,
        skill_name: input.name,
        content_digest: input.contentDigest,
      }).first();
      if (existing) {
        const row = mapVersion(existing);
        if (row.status === 'revoked') {
          // 撤销过的摘要不允许再次发布：原样回流等于把一次安全动作作废。
          throw new OrgSkillError(
            `version ${input.contentDigest} of "${input.name}" was revoked and cannot be republished`,
            'SKILL_ORG_VERSION_REVOKED',
          );
        }
        if (input.setCurrent) await this.setCurrentIn(trx, orgId, input.name, input.contentDigest, input.publishedByUserId);
        return row;
      }
      const now = toMysqlDateTime(this.now());
      const row = {
        version_id: this.id(),
        org_id: orgId,
        skill_name: input.name,
        content_digest: input.contentDigest,
        file_count: input.fileCount,
        total_bytes: input.totalBytes,
        description: input.description,
        origin_kind: input.originKind,
        origin_user_id: input.originUserId,
        origin_request_id: input.originRequestId ?? '',
        status: 'active',
        published_by_user_id: input.publishedByUserId,
        published_at: now,
        status_changed_by_user_id: '',
        status_changed_at: null,
        status_reason: '',
        updated_at: now,
      };
      await trx(VERSIONS).insert(row);
      // 首次发布时指针默认指向这一版；已经有 current 就不动（升级是显式动作）。
      const pointer: Loose = await trx(SKILLS).where({
        org_id: orgId,
        skill_name: input.name,
      }).first();
      if (input.setCurrent || !pointer || !String(pointer.current_digest ?? '')) {
        await this.setCurrentIn(trx, orgId, input.name, input.contentDigest, input.publishedByUserId);
      }
      return mapVersion(row);
    });
  }

  /** 改「当前推荐版本」。不影响任何已钉住的 AgentVersion。 */
  async setCurrent(input: {
    orgId: string;
    name: string;
    contentDigest: string;
    updatedByUserId: string;
  }): Promise<void> {
    const orgId = requireOrgId(input);
    await this.db.transaction(async (trx: Loose) => {
      await this.lockName(trx, orgId, input.name);
      await this.setCurrentIn(trx, orgId, input.name, input.contentDigest, input.updatedByUserId);
    });
  }

  /**
   * 弃用 / 吊销，带留痕。
   *
   * `revoked` 不可恢复（ADR 0015 D8）：已钉住的 Run 不被中途撤挂载，但**新 Run 的解析**
   * 立刻排除它，所以这是安全动作而不是展示开关。
   */
  async setStatus(input: {
    orgId: string;
    name: string;
    contentDigest: string;
    status: 'active' | 'deprecated' | 'revoked';
    reason: string;
    changedByUserId: string;
  }): Promise<OrgSkillVersionRow> {
    const orgId = requireOrgId(input);
    return this.db.transaction(async (trx: Loose) => {
      const existing: Loose = await trx(VERSIONS).where({
        org_id: orgId,
        skill_name: input.name,
        content_digest: input.contentDigest,
      }).first();
      if (!existing) {
        throw new OrgSkillError(
          `org skill "${input.name}" has no version ${input.contentDigest}`,
          'SKILL_ORG_VERSION_UNKNOWN',
        );
      }
      const current = mapVersion(existing);
      if (current.status === 'revoked' && input.status !== 'revoked') {
        // revoked 是终态：允许它「复活」会让吊销变成可逆的展示开关。
        throw new OrgSkillError(
          `version ${input.contentDigest} of "${input.name}" is revoked and cannot be reactivated`,
          'SKILL_ORG_VERSION_REVOKED',
        );
      }
      const now = toMysqlDateTime(this.now());
      await trx(VERSIONS).where({ version_id: current.versionId }).update({
        status: input.status,
        status_changed_by_user_id: input.changedByUserId,
        status_changed_at: now,
        status_reason: input.reason,
        updated_at: now,
      });
      return mapVersion({
        ...existing,
        status: input.status,
      });
    });
  }

  /**
   * 占位并锁住 `(org, name)` 那一行。
   *
   * 首次发布时行还不存在，先 `INSERT … ON DUPLICATE KEY UPDATE` 造一个空指针再锁——
   * 少了占位，两个并发首发布会各自走「不存在」分支，靠唯一键其中一个报错而不是排队。
   */
  private async lockName(trx: Loose, orgId: string, name: string): Promise<void> {
    await trx(SKILLS).insert({
      org_skill_id: this.id(),
      org_id: orgId,
      skill_name: name,
      current_digest: '',
      updated_by_user_id: '',
      updated_at: toMysqlDateTime(this.now()),
    }).onConflict(['org_id', 'skill_name']).merge({ org_id: orgId, skill_name: name });
    await trx(SKILLS).where({ org_id: orgId, skill_name: name }).forUpdate().first();
  }

  private async setCurrentIn(
    trx: Loose,
    orgId: string,
    name: string,
    contentDigest: string,
    updatedByUserId: string,
  ): Promise<void> {
    await trx(SKILLS).where({ org_id: orgId, skill_name: name }).update({
      current_digest: contentDigest,
      updated_by_user_id: updatedByUserId,
      updated_at: toMysqlDateTime(this.now()),
    });
  }
}
