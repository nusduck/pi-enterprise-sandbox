/**
 * 启用集感知的 Skill 提供方。
 *
 * 这是什么：在 `@deepseek-ai/dsh-skill` 的 registry 之上叠一层多租户与
 * ADR 0006 审批闸门的过滤——只有“已启用”的包才对模型与用户可见。
 * 执行面的挂载（`exec/src/isolation`）走同一事实源：未启用的包根本不在
 * bwrap 绑定里（见 exec 侧 `skill-mounts` 的说明），因此这里的过滤与那边的
 * 挂载同构，避免“同一件事两处各算一遍”与启用后仍能绕过执行的缺陷。
 *
 * 为什么策略与存储解耦：决定“某个 org/user 的 skill 是否可见”是一个纯函数
 * `isSkillEnabled`，而“启用集长什么样”落在存储接口 `EnabledSkillStore`。
 * 前者可在 macOS 无 MySQL 时单测；后者换 MySQL/内存实现不改可见性判定。
 */

import type { SkillProvider, SkillCandidate, SkillProviderObservation, SkillDefinition, SkillLookupOptions } from '@deepseek-ai/dsh-skill';

// ── 存储窄接口 ───────────────────────────────────────────────

export interface EnabledSkillStore {
  /** 该租户已启用的 skill 名集合；未启用或无记录时返回空集。 */
  listEnabled(orgId: string, userId: string): Promise<Set<string>>;
}

// ── 内存替身 ─────────────────────────────────────────────────

export class InMemoryEnabledSkillStore implements EnabledSkillStore {
  private readonly map = new Map<string, Set<string>>();
  private key(orgId: string, userId: string): string {
    return `${orgId}::${userId}`;
  }
  async listEnabled(orgId: string, userId: string): Promise<Set<string>> {
    return new Set(this.map.get(this.key(orgId, userId)) ?? []);
  }
  /** 测试/本地用：显式设置启用集。 */
  setEnabled(orgId: string, userId: string, names: Iterable<string>): void {
    this.map.set(this.key(orgId, userId), new Set(names));
  }
}

// ── 纯函数：可见性判定 ───────────────────────────────────────

/** 未启用即不可见——这是 ADR 0006 P1 的唯一闸门。 */
export function isSkillVisible(name: string, enabled: ReadonlySet<string>): boolean {
  return enabled.has(name);
}

/** 对一批候选做启用集过滤（不改 rank/provider，仅过滤）。 */
export function filterCandidatesByEnabled(candidates: readonly SkillCandidate[], enabled: ReadonlySet<string>): SkillCandidate[] {
  return candidates.filter((c) => isSkillVisible(c.name, enabled));
}

// ── Provider 工厂 ────────────────────────────────────────────

/**
 * 创建启用集过滤的 SkillProvider。
 * `inner` 是底层真实来源（如 filesystem 扫描），`resolveTenant` 从 lookup 上下文中提取租户。
 * `tenantOf` 失败或无 tenant 时退化为“空启用集”，即对外不可见（fail-closed）。
 */
export function createEnabledSkillsProvider(opts: {
  name?: string;
  inner: SkillProvider;
  store: EnabledSkillStore;
  tenantOf?: (lookup: SkillLookupOptions) => { orgId: string; userId: string } | null;
}): SkillProvider {
  const name = opts.name ?? 'enabled-skills';

  // tenant 解析：默认从环境或 lookup 额外字段取；测试可注入
  const tenantOf = opts.tenantOf ?? (() => null);

  return {
    name,
    async list(lookup: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
      const raw = await opts.inner.list(lookup);
      const isArray = Array.isArray(raw);
      const candidates: readonly SkillCandidate[] = isArray ? raw : (raw as SkillProviderObservation).candidates;
      const complete = isArray ? true : (raw as SkillProviderObservation).complete;

      const tenant = tenantOf(lookup);
      const enabled = tenant ? await opts.store.listEnabled(tenant.orgId, tenant.userId) : new Set<string>();
      const filtered = filterCandidatesByEnabled(candidates, enabled);

      // 保持与 inner 相同的返回形态：数组 vs Observation
      if (Array.isArray(raw)) return filtered;
      return { candidates: filtered, complete };
    },
    async get(candidate: SkillCandidate, lookup: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      // 二次校验：即使调用方绕过 list 直接 get，也必须启用才可加载
      const tenant = tenantOf(lookup);
      const enabled = tenant ? await opts.store.listEnabled(tenant.orgId, tenant.userId) : new Set<string>();
      if (!isSkillVisible(candidate.name, enabled)) return undefined;
      return opts.inner.get(candidate, lookup);
    },
  };
}
