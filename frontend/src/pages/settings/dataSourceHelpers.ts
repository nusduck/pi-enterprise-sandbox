/**
 * 「数据源」分类的纯函数：读写 AgentVersion 配置的 `dataSources` 键（`[{ id }]`），
 * 并把 config-options 的 `platformConstraints.dataSources` 投影成候选
 * （docs/design/sandbox-data-sources.md §5）。
 *
 * 服务端是语义权威：id 是否在平台目录里由 agent/ 判定并在保存时拒绝。这里只保证
 * 草稿里的每个 id 都有一行落点（复用「协作」分类的行投影），不被静默丢弃。
 */
import { cloneAgentConfig } from './agentHelpers';
import type { DelegationCandidate } from './delegationHelpers';

/** 与 contract/src/data-sources.ts 的 ENABLED_DATA_SOURCES_MAX 一致。 */
export const DEFAULT_DATA_SOURCES_MAX = 16;

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function dataSourcesOf(config: Record<string, unknown>): string[] {
  if (!Array.isArray(config.dataSources)) return [];
  return config.dataSources.flatMap((entry) => {
    const id = plainObject(entry)?.id;
    return typeof id === 'string' ? [id] : [];
  });
}

/** 结构不对时暂停「数据源」分类，让用户去 JSON 修，而不是覆盖掉原值。 */
export function dataSourceStructureIssues(config: Record<string, unknown>): string[] {
  if (config.dataSources == null) return [];
  if (!Array.isArray(config.dataSources)) return ['dataSources must be an array of { id }'];
  return config.dataSources.some((entry) => typeof plainObject(entry)?.id !== 'string')
    ? ['dataSources entries must be objects with a string id']
    : [];
}

/**
 * 按勾选结果重写清单。已有条目的其他字段原样保留（由服务端报 CONFIG_UNKNOWN_FIELD），
 * 清空时删掉整个键。
 */
export function setDataSources(config: Record<string, unknown>, ids: readonly string[]): Record<string, unknown> {
  if (dataSourceStructureIssues(config).length) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const existing = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(next.dataSources) ? next.dataSources : []) {
    const record = plainObject(entry);
    if (record && typeof record.id === 'string') existing.set(record.id, record);
  }
  if (ids.length) next.dataSources = ids.map((id) => existing.get(id) ?? { id });
  else delete next.dataSources;
  return next;
}

/** 候选：config-options 的 platformConstraints.dataSources，保持服务端顺序。 */
export function dataSourceCandidates(platformConstraints: Record<string, unknown> | undefined): DelegationCandidate[] {
  const raw = platformConstraints?.dataSources;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = plainObject(item);
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id) return [];
    const label = typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim() : id;
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    const engine = typeof entry?.engine === 'string' ? entry.engine : '';
    return [{ id, label, description, selectable: true, ...(engine ? { note: engine.toUpperCase() } : {}) }];
  });
}

/** 清单上限读 fieldSupport，读不到时退回服务端默认值。 */
export function dataSourcesMaxItems(fieldSupport: Record<string, unknown> | undefined): number {
  const max = plainObject(fieldSupport?.dataSources)?.maxItems;
  return typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : DEFAULT_DATA_SOURCES_MAX;
}
