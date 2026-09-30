/**
 * org 层版本的**回收**（ADR 0015 D8，design §5.4）。
 *
 * ## 回收规则（四条同时满足才删）
 *
 * 1. **不被任何 AgentVersion 引用**——靠 `tbl_agsvc_agent_version_skill_refs` 判定。
 *    这是「不要删掉在跑的 Run 要挂载的字节」那条纪律的落点；
 * 2. **不是 `current_digest`**——它是配置面默认选中的版本，删了就选不到；
 * 3. **账本状态不是 `active`**——`active` 版本随时可被新 AgentVersion 绑定，
 *    「可绑定」必须蕴含「字节在盘上」。否则配置面列出它、保存成功，之后每个 Run
 *    都以 mismatch 静默排除（2026-09-30 复审发现）。要回收一个旧版本，先弃用它；
 *    没有账本行的目录（写账本失败留下的孤儿）照常回收；
 * 4. **超过宽限期**——沿用用户的 `SKILL_VERSION_GC_GRACE_MS`，给刚落地的发布留缓冲。
 *
 * ## `revoked` 的字节为什么不立刻删
 *
 * 吊销是**加载许可**的撤销，不是「这份字节不存在了」：`revoked` 版本的字节保留到满足上面
 * 三条才回收，便于事后审计（「当时到底发布的是什么」）。是否可被加载只由账本状态决定，
 * 与字节在不在盘上无关——这也是 Run 解析先读账本、再核对字节的原因。
 *
 * ## 为什么删完要复验
 *
 * 「先算保留集合、再删盘」这两步之间没有锁。算完 keep 集合之后、真正删之前，可能有管理员
 * 把 `current` 指到某个候选版本上。那种情况下的删除是**不可逆的**（字节没了，而账本还指着
 * 它），所以删除后复验一次：任何被删掉的摘要如果现在是 referenced 或 current，就是出现了
 * 这个竞态，必须报出来而不是静默留下一个指向空目录的账本行。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { collectStaleSkillVersions } from './enablement.js';
import { physicalTableName } from '../infrastructure/mysql/schema-tables.js';
import { AgentVersionSkillRefRepository } from '../infrastructure/mysql/repositories/agent-version-skill-ref-repository.js';
import { resolveSkillVersionGcGraceMs } from '../application/skill-enablement-service.js';

const SKILLS = physicalTableName('org_skills');
const VERSIONS = physicalTableName('org_skill_versions');

type Loose = any;

// 宽限期**不在这里再定义一份**：用户层已有解析器（`skill-enablement-service.ts` 的
// `resolveSkillVersionGcGraceMs`），org 层读同一个环境变量、同一个默认值。两份常量
// 迟早会漂成两层行为不一致。
export { DEFAULT_SKILL_VERSION_GC_GRACE_MS } from '../application/skill-enablement-service.js';

export interface OrgSkillGcDeps {
  /** 当前的 knex 执行器（事务内调用就传 trx）。 */
  readonly db: Loose;
  /** org 层发布存储基根；实际 owner 根是 `<base>/<orgId>/_org`。 */
  readonly publishedBase: string;
  readonly graceMs?: number;
  readonly now?: () => Date;
}

/** 一个包名的回收结果。 */
export interface OrgSkillGcNameResult {
  readonly name: string;
  /** 被删掉的版本摘要。 */
  readonly removed: readonly string[];
  /**
   * 删除之后复验发现「现在是 referenced 或 current」的摘要。
   *
   * **非空即为竞态**：那个版本的字节已经删了，而账本还想用它。调用方必须把它当作错误
   * 处理（至少告警 + 让下一次发布重建字节），不能当成正常回收。
   */
  readonly racedDigests: readonly string[];
}

export interface OrgSkillGcResult {
  readonly names: readonly OrgSkillGcNameResult[];
  readonly removedCount: number;
}

/**
 * 回收本 org 里所有满足条件的 org 层版本。
 *
 * 逐名处理：`collectStaleSkillVersions` 是「一个包名下」的回收器，与用户层共用同一份
 * 实现——两层的字节布局相同，回收规则也该相同，没有理由写第二份。
 */
export async function collectStaleOrgSkillVersions(
  deps: OrgSkillGcDeps,
  input: { orgId: string },
): Promise<OrgSkillGcResult> {
  const orgId = String(input.orgId ?? '').trim();
  if (!orgId) throw new Error('collectStaleOrgSkillVersions requires a non-empty orgId');
  const now = deps.now ?? (() => new Date());
  const graceMs = deps.graceMs ?? resolveSkillVersionGcGraceMs(process.env);
  const orgRoot = path.join(path.resolve(deps.publishedBase), orgId, '_org');

  // 保留集合的**引用部分**：一次查询，避免对每个候选问一次。
  const referenced = await referencedDigestsByName(deps.db, orgId);
  // 指针部分：当前推荐版本不能删。
  const pointers: Loose[] = await deps.db(SKILLS).where({ org_id: orgId });
  const currentByName = new Map<string, string>(
    pointers.map((row: Loose) => [String(row.skill_name), String(row.current_digest ?? '')]),
  );
  // 可被新绑定的版本（规则 3）：字节必须留在盘上。
  const activeRows: Loose[] = await deps.db(VERSIONS).where({ org_id: orgId, status: 'active' });
  const activeDigestsOf = (name: string): string[] => activeRows
    .filter((row: Loose) => String(row.skill_name) === name)
    .map((row: Loose) => String(row.content_digest));

  let dirents;
  try {
    dirents = await fsp.readdir(orgRoot, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return { names: [], removedCount: 0 };
    throw err;
  }

  const results: OrgSkillGcNameResult[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const name = dirent.name;
    const keep = new Set<string>([
      ...(referenced.get(name) ?? []),
      ...activeDigestsOf(name),
    ]);
    const current = currentByName.get(name);
    if (current) keep.add(current);

    const removed = await collectStaleSkillVersions({
      publishedRoot: orgRoot,
      name,
      keepDigests: keep,
      graceMs,
      now,
    });
    if (removed.length === 0) continue;

    // 复验：删掉的摘要里任何一个「现在」是 referenced 或 current 就是竞态。
    const racedDigests = await racedAfterDeletion(deps.db, { orgId, name, removed });
    results.push({ name, removed, racedDigests });
  }

  return {
    names: results,
    removedCount: results.reduce((n, r) => n + r.removed.length, 0),
  };
}

/** 复验：被删的摘要里，有没有哪个现在是 referenced 或 current。 */
async function racedAfterDeletion(
  db: Loose,
  input: {
    orgId: string;
    name: string;
    removed: readonly string[];
  },
): Promise<string[]> {
  if (input.removed.length === 0) return [];
  const raced: string[] = [];
  const fresh: Loose = await db(SKILLS)
    .where({ org_id: input.orgId, skill_name: input.name })
    .first();
  const currentNow = String(fresh?.current_digest ?? '');
  const rows: Loose[] = await db(physicalTableName('agent_version_skill_refs'))
    .where({ org_id: input.orgId, scope: 'org', skill_name: input.name })
    .select('content_digest');
  const referencedNow = new Set(rows.map((row: Loose) => String(row.content_digest ?? '')));
  for (const digest of input.removed) {
    if (referencedNow.has(digest) || (currentNow !== '' && currentNow === digest)) {
      raced.push(digest);
    }
  }
  return raced;
}

/**
 * 本 org 被引用的摘要，按名字归组。
 *
 * 走仓储而不是在这里拼 SQL：查询的语义（「引用」= `scope: 'org'` 的精确摘要匹配）
 * 属于那一层，两处各写一份迟早会漂。
 */
async function referencedDigestsByName(
  db: Loose,
  orgId: string,
): Promise<Map<string, Set<string>>> {
  return new AgentVersionSkillRefRepository(db).listReferencedDigests({ orgId });
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
