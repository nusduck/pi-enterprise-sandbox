/**
 * AgentVersion → Skill 引用账本（ADR 0015 D5，design §5.2/§5.4）。
 *
 * 两个消费方，都是**安全相关**的：
 * - **吊销影响面**：`listVersionsForSkill` 回答「哪些 AgentVersion 的下一个 Run 会
 *   因为这次吊销而丢挂载」。运维要能立刻看到，所以按 `(org, scope, name, digest)` 索引反查。
 * - **GC 判定**：`isReferenced` 回答「这个 org 版本还有人在用吗」。回收判定建立在这上面
 *   ——靠扫 `config_json` 判「还有人用吗」，漏一个就会删掉在跑的 Run 要挂载的字节。
 *
 * 只增不改：AgentVersion 不可变，它的引用集合在创建那一刻就冻结了。
 */
import { physicalTableName } from '../schema-tables.js';
import { toMysqlDateTime } from '../row-mappers.js';

type Loose = any;

const REFS = physicalTableName('agent_version_skill_refs');

/** 被引用的层。**没有 `user`**：用户层随调用者变化，不随 AgentVersion 固定。 */
export type SkillRefScope = 'system' | 'org';

export interface AgentVersionSkillRef {
  readonly agentVersionId: string;
  readonly orgId: string;
  readonly scope: SkillRefScope;
  readonly name: string;
  readonly contentDigest: string;
}

export class AgentVersionSkillRefRepository {
  constructor(
    private readonly db: Loose,
    private readonly opts: { now?: () => Date } = {},
  ) {
    if (!db) throw new Error('AgentVersionSkillRefRepository requires a knex executor');
  }

  /**
   * 登记一个 AgentVersion 的全部 Skill 引用。
   *
   * **必须在创建 AgentVersion 的同一个事务里调用**（design §5.3）：分开写会留下
   * 「版本存在但引用缺失」的中间态，而那个状态下 GC 会认为某个 org 版本没人引用、
   * 把它回收掉——正在用它的 Run 下一个 Run 就挂载失败。
   *
   * 空数组是合法输入（`skillPolicy.system.mode: none` + 无 org 条目），此时不写任何行。
   */
  async insertForVersion(input: {
    agentVersionId: string;
    orgId: string;
    refs: readonly {
      readonly scope: SkillRefScope;
      readonly name: string;
      readonly contentDigest?: string;
    }[];
  }): Promise<void> {
    if (input.refs.length === 0) return;
    const createdAt = toMysqlDateTime((this.opts.now ?? (() => new Date()))());
    // 去重：同一 (version, scope, name) 是主键，重复插入会撞主键而不是「后写覆盖」。
    // 调用方本不该给出重复项，但这里不该因此让整个版本创建失败——静默取第一个，
    // 因为重复项在任何解释下都指向同一个引用。
    const seen = new Set<string>();
    const rows: Loose[] = [];
    for (const ref of input.refs) {
      const key = `${ref.scope}\u0000${ref.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        agent_version_id: input.agentVersionId,
        org_id: input.orgId,
        scope: ref.scope,
        skill_name: ref.name,
        // system 层按名选择、不钉摘要（ADR 0015 D4），所以是空串。
        content_digest: ref.scope === 'org' ? (ref.contentDigest ?? '') : '',
        created_at: createdAt,
      });
    }
    if (rows.length === 0) return;
    await this.db(REFS).insert(rows);
  }

  /**
   * 引用了某个 org 版本文本的 AgentVersion（吊销影响面）。
   *
   * 只查 `scope: 'org'`：系统层不按 Agent 吊销（它随 release 交付）。
   */
  async listVersionsForSkill(input: {
    orgId: string;
    name: string;
    contentDigest: string;
    limit?: number;
  }): Promise<string[]> {
    let q: Loose = this.db(REFS)
      .where({
        org_id: String(input.orgId),
        scope: 'org',
        skill_name: input.name,
        content_digest: input.contentDigest,
      })
      .orderBy('agent_version_id', 'asc');
    if (input.limit !== undefined) {
      q = q.limit(Math.max(1, Math.min(Number(input.limit) || 100, 500)));
    }
    const rows: Loose[] = await q;
    return rows.map((row) => String(row.agent_version_id));
  }

  /**
   * 本 org 被任何 AgentVersion 引用的 org 版本摘要，按 `name` 归组。
   *
   * GC 用一次查询拿到保留集合的**引用部分**，而不是对每个候选版本各问一次
   * （`isReferenced`）——后者在版本多的 org 上是 N+1。
   */
  async listReferencedDigests(input: { orgId: string }): Promise<Map<string, Set<string>>> {
    const rows: Loose[] = await this.db(REFS)
      .where({ org_id: String(input.orgId), scope: 'org' })
      .select('skill_name', 'content_digest');
    const out = new Map<string, Set<string>>();
    for (const row of rows) {
      const name = String(row.skill_name);
      const digest = String(row.content_digest ?? '');
      if (!digest) continue;
      const set = out.get(name) ?? new Set<string>();
      set.add(digest);
      out.set(name, set);
    }
    return out;
  }

  /** 这个 org 版本还有 AgentVersion 引用吗（GC 判定）。 */
  async isReferenced(input: {
    orgId: string;
    name: string;
    contentDigest: string;
  }): Promise<boolean> {
    const row = await this.db(REFS)
      .where({
        org_id: String(input.orgId),
        scope: 'org',
        skill_name: input.name,
        content_digest: input.contentDigest,
      })
      .first();
    return Boolean(row);
  }

  /** 一个 AgentVersion 的全部引用（审计与测试）。 */
  async listForVersion(agentVersionId: string): Promise<AgentVersionSkillRef[]> {
    const rows: Loose[] = await this.db(REFS)
      .where({ agent_version_id: String(agentVersionId) })
      .orderBy([{ column: 'scope', order: 'asc' }, { column: 'skill_name', order: 'asc' }]);
    return rows.map((row) => ({
      agentVersionId: String(row.agent_version_id),
      orgId: String(row.org_id),
      scope: String(row.scope) === 'org' ? 'org' : 'system',
      name: String(row.skill_name),
      contentDigest: String(row.content_digest ?? ''),
    }));
  }
}
