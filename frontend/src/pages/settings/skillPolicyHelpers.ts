/**
 * 「技能」分类的纯函数：读写 AgentVersion 配置的 `skillPolicy` 键
 * （ADR 0015 D2 / design §4.1），并把 config-options 的
 * `platformConstraints.skills` 投影成候选。
 *
 * 服务端是语义权威：名字在不在当前 release、org 版本是否可绑，都由 agent/ 判定并在
 * 保存时拒绝。这里只保证：
 * - 结构不对时**暂停这一分类**（去 JSON 修），而不是覆盖掉用户写的值；
 * - 未动过的键**不写回**——省略 `skillPolicy` 等于「全部系统 + 用户启用」，
 *   写回一个等价对象会改变既有版本的 `config_hash`。
 */
import { cloneAgentConfig } from './agentHelpers';

/** 与 contract/src/skill-policy.ts 的 SKILL_POLICY_LAYER_MAX 一致。 */
export const DEFAULT_SKILL_LAYER_MAX = 64;

/** 系统层选法。 */
export type SkillSystemMode = 'all' | 'allowlist' | 'none';

/** 页面上的 skillPolicy 视图。`allowlist` 之外的模式下 `names` 无意义。 */
export interface SkillPolicyView {
  readonly systemMode: SkillSystemMode;
  readonly systemNames: readonly string[];
  readonly org: ReadonlyArray<{ readonly name: string; readonly contentDigest: string }>;
  readonly user: 'allow' | 'deny';
}

/** 一个系统层候选（`platformConstraints.skills.system`）。 */
export interface SkillCandidate {
  readonly name: string;
  readonly description: string;
}

/** 一个 org 层候选：一个名字带若干已发布版本（`platformConstraints.skills.org`）。 */
export interface OrgSkillCandidate {
  readonly name: string;
  readonly description: string;
  readonly currentDigest: string;
  readonly versions: ReadonlyArray<{
    readonly contentDigest: string;
    readonly status: string;
    readonly publishedAt: string;
  }>;
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

const MODES: readonly string[] = ['all', 'allowlist', 'none'];

/**
 * 读草稿里的 `skillPolicy`。
 *
 * **配置里没有这个键时不返回默认值**——调用方要能区分「用户没设过」与「用户设成
 * 了 all」。缺省语义由服务端保证（省略 = 当前行为），页面照实显示「未设置」。
 */
export function skillPolicyOf(config: Record<string, unknown>): SkillPolicyView | null {
  const policy = plainObject(config.skillPolicy);
  if (!policy) return null;
  const system = plainObject(policy.system);
  const rawMode = system?.mode;
  const systemMode: SkillSystemMode =
    typeof rawMode === 'string' && MODES.includes(rawMode) ? (rawMode as SkillSystemMode) : 'all';
  const org = Array.isArray(policy.org)
    ? policy.org.flatMap((entry) => {
      const record = plainObject(entry);
      const name = record?.name;
      const contentDigest = record?.contentDigest;
      return typeof name === 'string' && typeof contentDigest === 'string'
        ? [{ name, contentDigest }]
        : [];
    })
    : [];
  return {
    systemMode,
    systemNames: stringList(system?.names),
    org,
    user: policy.user === 'deny' ? 'deny' : 'allow',
  };
}

/** 结构不对时暂停这一分类，让用户去 JSON 修，而不是覆盖掉原值。 */
export function skillPolicyStructureIssues(config: Record<string, unknown>): string[] {
  if (config.skillPolicy == null) return [];
  const policy = plainObject(config.skillPolicy);
  if (!policy) return ['skillPolicy must be an object'];
  const issues: string[] = [];
  const system = policy.system;
  if (system != null) {
    const record = plainObject(system);
    if (!record) {
      issues.push('skillPolicy.system must be an object');
    } else {
      if (record.mode != null && (typeof record.mode !== 'string' || !MODES.includes(record.mode))) {
        issues.push('skillPolicy.system.mode must be all | allowlist | none');
      }
      if (record.names != null && stringList(record.names).length !== (record.names as unknown[]).length) {
        issues.push('skillPolicy.system.names must be a list of strings');
      }
    }
  }
  if (policy.org != null) {
    if (!Array.isArray(policy.org)) {
      issues.push('skillPolicy.org must be an array');
    } else if (policy.org.some((entry) => {
      const record = plainObject(entry);
      return typeof record?.name !== 'string' || typeof record?.contentDigest !== 'string';
    })) {
      issues.push('skillPolicy.org entries must be { name, contentDigest }');
    }
  }
  if (policy.user != null && policy.user !== 'allow' && policy.user !== 'deny') {
    issues.push('skillPolicy.user must be allow | deny');
  }
  return issues;
}

/**
 * 写回 `skillPolicy`。
 *
 * 三个刻意的行为：
 * - **`allowlist` 之外不写 `names`**：服务端对「all/none 带 names」报错（不许静默
 *   忽略），留着会让保存直接失败；
 * - `org` 为空时仍然写空数组（它是绑定的一部分，不是可选装饰）；
 * - 结果与「缺省等价对象」完全一致时**删掉整个键**，避免给没设过策略的版本
 *   平白加上一个会让 `config_hash` 变化的键。
 */
export function setSkillPolicy(
  config: Record<string, unknown>,
  view: SkillPolicyView,
): Record<string, unknown> {
  if (skillPolicyStructureIssues(config).length) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  const policy: Record<string, unknown> = {
    system: {
      mode: view.systemMode,
      ...(view.systemMode === 'allowlist' ? { names: [...view.systemNames] } : {}),
    },
    org: view.org.map((entry) => ({ name: entry.name, contentDigest: entry.contentDigest })),
    user: view.user,
  };
  if (isDefaultPolicy(policy)) delete next.skillPolicy;
  else next.skillPolicy = policy;
  return next;
}

/** 与「省略 skillPolicy」等价的形状。 */
function isDefaultPolicy(policy: Record<string, unknown>): boolean {
  const system = plainObject(policy.system);
  const user = policy.user;
  const org = policy.org;
  return (
    system?.mode === 'all'
    && (system.names === undefined || (Array.isArray(system.names) && system.names.length === 0))
    && Array.isArray(org)
    && org.length === 0
    && user === 'allow'
  );
}

/** 系统层候选：`platformConstraints.skills.system`。 */
export function skillCandidates(
  platformConstraints: Record<string, unknown> | undefined,
): SkillCandidate[] {
  const raw = plainObject(platformConstraints?.skills)?.system;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = plainObject(item);
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name) return [];
    const description = typeof entry?.description === 'string' ? entry.description.trim() : '';
    return [{ name, description }];
  });
}

/** org 层候选：`platformConstraints.skills.org`（本 org 的版本与状态）。 */
export function orgSkillCandidates(
  platformConstraints: Record<string, unknown> | undefined,
): OrgSkillCandidate[] {
  const raw = plainObject(platformConstraints?.skills)?.org;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = plainObject(item);
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name) return [];
    const versions = Array.isArray(entry?.versions)
      ? entry.versions.flatMap((version) => {
        const record = plainObject(version);
        const contentDigest = record?.contentDigest;
        if (typeof contentDigest !== 'string' || !contentDigest) return [];
        return [{
          contentDigest,
          status: typeof record?.status === 'string' ? record.status : '',
          publishedAt: typeof record?.publishedAt === 'string' ? record.publishedAt : '',
        }];
      })
      : [];
    return [{
      name,
      description: typeof entry?.description === 'string' ? entry.description.trim() : '',
      currentDigest: typeof entry?.currentDigest === 'string' ? entry.currentDigest : '',
      versions,
    }];
  });
}

/**
 * 计数：绑定里明确点到的能力数。
 *
 * `mode: all` 时系统层是「整个 release」，个数由服务端展开——这里返回**名单长度**
 * （0），不要拿候选总数冒充：标签上的数字要能被页面上看到的东西解释。
 */
export function skillPolicyCount(config: Record<string, unknown>): number {
  const view = skillPolicyOf(config);
  if (!view) return 0;
  const systemCount = view.systemMode === 'allowlist' ? view.systemNames.length : 0;
  return systemCount + view.org.length;
}

/** 每层清单上限读 fieldSupport，读不到时退回服务端默认值。 */
export function skillLayerMaxItems(fieldSupport: Record<string, unknown> | undefined): number {
  const max = plainObject(plainObject(fieldSupport?.skillPolicy)?.fields)?.org;
  const value = plainObject(max)?.maxItems;
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_SKILL_LAYER_MAX;
}
