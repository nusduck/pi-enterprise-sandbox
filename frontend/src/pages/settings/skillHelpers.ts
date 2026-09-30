/**
 * Skill 分层的纯函数——页面组件只做渲染，分层规则在这里，才测得动。
 *
 * 背景：启用一个草稿是**复制字节**（skills/enablement.ts），草稿留在原地当
 * 可编辑的源，停用时只删已发布的那份副本。所以后端的 `skill_drafts` 在启用
 * 之后依然包含它，Agent 用 `published` 标出来。
 */
import type { SkillItem } from '../../shared/api/capabilities';

/** 用户自己那一层（已启用的副本）。 */
export function isUserSkill(item: SkillItem): boolean {
  return item.source === 'user-skill-root';
}

/** 草稿层——包含已发布过的草稿。 */
export function isDraftSkill(item: SkillItem): boolean {
  return item.source === 'draft-skill-root';
}

/**
 * org 层——本组织管理员共享、由 AgentVersion 绑定的 Skill（ADR 0015 D5）。
 *
 * 与用户层的区别不只是来源标签：它的字节归**组织**，作者之后改自己的草稿或重新启用
 * 都不影响它；用户自己也不能启用停用它（那是管理员的事）。所以页面上要分开列。
 */
export function isOrgSkill(item: SkillItem): boolean {
  return item.source === 'org-skill-root';
}

/**
 * 还等着人按「Enable」的草稿。
 *
 * Drafts 区只放这些：已发布的草稿再列一遍，同一个名字就会在页面上出现两次，
 * 而且草稿那张卡还带着一个按了也没有新效果的 Enable（2026-09-04 截图）。
 * 想重新发布就先在 My Skills 里 Disable，草稿会重新回到 Drafts。
 */
export function isPendingDraft(item: SkillItem): boolean {
  return isDraftSkill(item) && item.published !== true;
}

export interface SkillTierSplit {
  readonly drafts: SkillItem[];
  readonly user: SkillItem[];
  readonly org: SkillItem[];
  readonly system: SkillItem[];
  /** 已发布草稿的包名——My Skills 里那张卡据此显示 "from draft"。 */
  readonly publishedFromDraft: Set<string | undefined>;
}

export function splitSkillTiers(items: SkillItem[]): SkillTierSplit {
  return {
    drafts: items.filter(isPendingDraft),
    user: items.filter(isUserSkill),
    // org 与用户层分开列：来源不同、处置方式也不同（用户不能停用组织共享的包）。
    org: items.filter(isOrgSkill),
    system: items.filter((item) => !isUserSkill(item) && !isOrgSkill(item) && !isDraftSkill(item)),
    publishedFromDraft: new Set(
      items
        .filter((item) => isDraftSkill(item) && item.published === true)
        .map((item) => item.name),
    ),
  };
}

/**
 * 卡片上的来源列。
 *
 * `org-skill-root` 曾经写成 `shared-skill-root`——那是**设计期的旧名**，Agent 从未发过
 * 这个值，所以组织共享的包一直落到兜底分支显示原始字符串。现在按 Agent 实际发的值判。
 */
export function skillSourceLabel(item: SkillItem): string {
  if (item.source === 'user-skill-root') return 'User';
  if (item.source === 'draft-skill-root') return 'Draft';
  if (item.source === 'org-skill-root') return 'Organization';
  if (item.source === 'shared-skill-root') return 'System';
  return item.source || item.path || '\u2014';
}
