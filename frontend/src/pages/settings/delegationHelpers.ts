/**
 * 「协作」分类的纯函数：读写 AgentVersion 配置的 `delegation` 键，并把草稿与
 * 候选目录投影成可渲染的行（docs/design/agent-delegation-config-ui.md）。
 *
 * 服务端仍是语义权威：名字是否存在、远端是否登记、运行时目标是否 active 都由
 * agent/ 判定。这里只保证草稿里的每个名字都有一行落点，不被静默丢弃。
 */
import { cloneAgentConfig } from './agentHelpers';

export type DelegationKey = 'agents' | 'remoteAgents';

/** 与 agent/src/domain/agent/delegation-config.ts 的 DELEGATION_MAX_ENTRIES 一致。 */
export const DEFAULT_DELEGATION_MAX = 20;

export type DelegationLists = { agents: string[]; remoteAgents: string[] };

export type DelegationCandidate = {
  /** 写入配置的值：同 org Agent 的 name，或远端登记表的 id。 */
  id: string;
  label: string;
  description: string;
  /** false = 可见但不能新勾选（已勾选的仍可取消）。 */
  selectable: boolean;
  note?: string;
};

export type DelegationRow = DelegationCandidate & {
  checked: boolean;
  /** 草稿中的下标；服务端诊断 path `delegation.<key>[i]` 按它挂载。 */
  draftIndex: number;
  /** 草稿里有、候选里没有：只能移除。 */
  stale: boolean;
};

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function delegationOf(config: Record<string, unknown>): DelegationLists {
  const delegation = plainObject(config.delegation);
  return {
    agents: stringList(delegation?.agents),
    remoteAgents: stringList(delegation?.remoteAgents),
  };
}

/** 结构不对时暂停「协作」分类，让用户去 JSON 修，而不是覆盖掉原值。 */
export function delegationStructureIssues(config: Record<string, unknown>): string[] {
  if (config.delegation == null) return [];
  const delegation = plainObject(config.delegation);
  if (!delegation) return ['delegation must be an object'];
  const issues: string[] = [];
  for (const key of ['agents', 'remoteAgents'] as const) {
    const list = delegation[key];
    if (list != null && (!Array.isArray(list) || list.some((item) => typeof item !== 'string'))) {
      issues.push(`delegation.${key} must be an array of strings`);
    }
  }
  return issues;
}

/**
 * 替换一份名单。空名单删子键；`delegation` 下什么都不剩时删掉整个键。
 * 未知子键原样保留，由服务端报 CONFIG_UNKNOWN_FIELD。
 */
export function setDelegationList(
  config: Record<string, unknown>,
  key: DelegationKey,
  list: readonly string[],
): Record<string, unknown> {
  if (delegationStructureIssues(config).length) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const delegation = { ...(plainObject(next.delegation) ?? {}) };
  if (list.length) delegation[key] = [...list];
  else delete delegation[key];
  if (Object.keys(delegation).length) next.delegation = delegation;
  else delete next.delegation;
  return next;
}

/** 勾选追加到末尾、取消保持其余顺序——顺序会进系统提示，不做无意义的重排。 */
export function toggleDelegation(list: readonly string[], id: string, checked: boolean): string[] {
  if (checked) return list.includes(id) ? [...list] : [...list, id];
  return list.filter((item) => item !== id);
}

/**
 * 候选按候选顺序在前（勾选不改变行的位置，避免行在光标下跳动），草稿里有、候选里
 * 没有的条目按草稿顺序排在最后。写入配置的顺序由 `toggleDelegation` 决定，与行序无关。
 */
export function delegationRows(
  selected: readonly string[],
  candidates: readonly DelegationCandidate[],
): DelegationRow[] {
  const known = new Set(candidates.map((candidate) => candidate.id));
  const rows: DelegationRow[] = candidates.map((candidate) => {
    const draftIndex = selected.indexOf(candidate.id);
    return { ...candidate, checked: draftIndex >= 0, draftIndex, stale: false };
  });
  selected.forEach((id, draftIndex) => {
    if (!known.has(id)) rows.push({ id, label: id, description: '', selectable: false, checked: true, draftIndex, stale: true });
  });
  return rows;
}

/** 同 org 候选：排除当前 Agent 自身，按名字排序；非 active 可见不可选。 */
export function localDelegationCandidates(
  agents: ReadonlyArray<{ name: string; description?: string | null; status: string }>,
  selfName: string,
): DelegationCandidate[] {
  const self = selfName.trim();
  return agents
    .filter((agent) => agent.name && agent.name !== self)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((agent) => {
      const active = agent.status === 'active';
      return {
        id: agent.name,
        label: agent.name,
        description: String(agent.description ?? '').trim(),
        selectable: active,
        note: active ? undefined : '已停用，运行时会被拒绝',
      };
    });
}

/** 远端候选：config-options 的 platformConstraints.remoteAgents，保持服务端顺序。 */
export function remoteDelegationCandidates(platformConstraints: Record<string, unknown> | undefined): DelegationCandidate[] {
  const raw = platformConstraints?.remoteAgents;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = plainObject(item);
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!id) return [];
    const name = typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    return [{ id, label: name, description, selectable: true }];
  });
}

/** 名单上限读 fieldSupport，读不到时退回服务端默认值。 */
export function delegationMaxItems(fieldSupport: Record<string, unknown> | undefined, key: DelegationKey): number {
  const fields = plainObject(plainObject(fieldSupport?.delegation)?.fields);
  const max = plainObject(fields?.[key])?.maxItems;
  return typeof max === 'number' && Number.isInteger(max) && max > 0 ? max : DEFAULT_DELEGATION_MAX;
}
