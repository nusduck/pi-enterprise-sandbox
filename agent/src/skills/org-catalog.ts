/**
 * org 层对**能力页**的投影（ADR 0015 D5 / design §7.2）。
 *
 * 能力页回答的是「这个组织的共享层里有什么」，不是「这个调用者的某个 AgentVersion
 * 绑了什么」。两者的差别不是措辞：
 *
 * - 绑定清单（`resolveRunSkills` 的 `policy.org`）是**每 Run** 算的，只含被某个
 *   版本钉住的条目，且带调用者身份；
 * - 能力页列的是**本 org 已发布的 active 版本**，与任何 AgentVersion 无关——
 *   否则一个还没被绑定的共享 Skill 在页面上完全不存在，管理员发布完看不到它。
 *
 * 与运行层同一条纪律：`revoked` 等于不存在（ADR 0015 D8），`deprecated` 仍在
 * 字节里、已钉版本照常运行，所以能力页照样列出来；`current_digest` 只是「推荐
 * 版本」指针，不是可用性判据——指针指着的版本被吊销时回退到 newest active。
 */

import { skillVersionPaths } from '@dsh/contract/skill-manifest.js';

import { orgSkillRootFor } from './paths.js';

/** 能力页需要的账本读法：**只读**，不涉及发布/状态变更。 */
export interface OrgSkillCatalogSource {
  /** 每名一行 + 该名的全部版本（`OrgSkillRepository.listForOrg` 的形状）。 */
  listForOrg(input: { orgId: string }): Promise<ReadonlyArray<{
    readonly name: string;
    readonly currentDigest: string;
    readonly versions: ReadonlyArray<{
      readonly contentDigest: string;
      readonly status: string;
      readonly publishedAt?: string;
    }>;
  }>>;
}

export interface OrgSkillCatalogEntry {
  readonly name: string;
  /** 版本目录里真正的包目录（`validateSkillPackage` 的入参）。 */
  readonly packageDir: string;
  readonly contentDigest: string;
}

/**
 * 本 org 每个 org 层名字的**一个 active 版本**，按名字排序。
 *
 * 一个名字只出一行：能力页是「有什么」，不是「历史上有过哪些版本」——版本清单由
 * 管理员页回答。挑版本的顺序是 `current_digest` 优先、否则 newest active
 * （`listForOrg` 已按 `published_at` 倒序）。
 */
export async function listActiveOrgSkillPackages(input: {
  orgId: string;
  /** 发布存储基根（物理）：`<base>/<orgId>/_org/...`。 */
  publishedBase: string;
  orgSkills: OrgSkillCatalogSource;
}): Promise<readonly OrgSkillCatalogEntry[]> {
  const names = await input.orgSkills.listForOrg({ orgId: input.orgId });
  const ownerRoot = orgSkillRootFor({ orgId: input.orgId }, input.publishedBase);
  const out: OrgSkillCatalogEntry[] = [];
  for (const entry of names) {
    const active = entry.versions.filter((version) => version.status === 'active');
    const chosen = active.find((version) => version.contentDigest === entry.currentDigest) ?? active[0];
    if (chosen === undefined) continue;
    out.push({
      name: entry.name,
      contentDigest: chosen.contentDigest,
      packageDir: skillVersionPaths(ownerRoot, entry.name, chosen.contentDigest).packageDir,
    });
  }
  return Object.freeze(out.sort((a, b) => a.name.localeCompare(b.name)));
}
