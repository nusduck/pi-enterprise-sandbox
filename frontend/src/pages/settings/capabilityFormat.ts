/**
 * Status rules for the capabilities tables (pure, so they can be tested).
 */
import type { McpServerItem, ToolRegistryItem } from '../../shared/api/capabilities';
import type { SkillUsageEntry } from '../../shared/api/adminRuns';

/**
 * The server's canonical `status` wins; `connection_status` is only the
 * transport view and must not override it (a connected server can still be
 * disabled or misconfigured).
 */
export function mcpStatus(item: Pick<McpServerItem, 'status' | 'enabled' | 'connection_status'>): string {
  return item.status || (item.enabled === false ? 'disabled' : item.connection_status || 'configured');
}

export function toolStatus(item: Pick<ToolRegistryItem, 'status' | 'enabled'>): string {
  return item.status || (item.enabled === false ? 'disabled' : 'configured');
}

/**
 * 近 7 天调用列的 tooltip（ADR 0015 §7.4 的 `scope` 维度）。
 *
 * 只列出**出现过**的层：把 0 也写出来会让「这个系统 Skill 有没有人用」这个问题的
 * 答案被三个数字埋掉。没有数据时只给基础说明，不编一个「分层：无」。
 */
export function usageTitle(entry: SkillUsageEntry | undefined): string {
  const base = '全组织近 7 天 skill 工具的调用次数；直接读取 Skill 文件不计入';
  if (!entry) return base;
  const parts: string[] = [];
  if (entry.byScope.system > 0) parts.push(`系统 ${entry.byScope.system}`);
  if (entry.byScope.org > 0) parts.push(`组织 ${entry.byScope.org}`);
  if (entry.byScope.user > 0) parts.push(`用户 ${entry.byScope.user}`);
  return parts.length > 0 ? `${base}\n分层：${parts.join('、')}` : base;
}
