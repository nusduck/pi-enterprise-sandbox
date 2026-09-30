/**
 * `skillPolicy` 的**语义校验**与**配置面投影**（ADR 0015 D2/D5，design §4.1/§4.2）。
 *
 * 从 `agent-config-validator.ts` 拆出来有两个理由：
 * 1. 那个文件已经贴着 1000 行棘轮上限（`tests/test_repository_layout.py`），
 *    加字段不该把一个热点推过线；
 * 2. 这里的两件事是**独立职责**，且各有第二个调用方——
 *    - `validateSkillPolicySemantics()` 同时被配置面 `validate()` 和落库前的
 *      `AgentCatalogService.#validateConfig()` 调用（只在一处判就会把「保存成功但起
 *      Run 必失败」的配置写进库）；
 *    - `skillPlatformConstraints()` 只服务 `platformConstraints.skills` 投影。
 *
 * 形状校验不在这里，在 `@dsh/contract/skill-policy.js`——两侧（agent / exec）共用，
 * 且不依赖任何目录或账本。
 */
import {
  skillPolicyTooLarge,
  type SkillPolicy,
} from '@dsh/contract/skill-policy.js';
import { SYSTEM_SKILL_ROOT } from '../skills/paths.js';
import type { SystemSkillEntry } from '../skills/system-catalog.js';

/** 配置面诊断（与 `agent-config-validator.ts` 的 `AgentConfigDiagnostic` 同形）。 */
export interface SkillConfigDiagnostic {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/**
 * 本 org 的一个 org 层 Skill 版本（ADR 0015 D5，P2 起由账本提供）。
 *
 * `status` 决定能不能被**新绑定**：`active` 可以，`deprecated` 报错（不能新钉），
 * `revoked` 视为不存在。
 */
export interface OrgSkillEntry {
  readonly name: string;
  readonly contentDigest: string;
  readonly status: 'active' | 'deprecated' | 'revoked';
  readonly description?: string;
  /** 该名的「当前推荐版本」摘要，配置面默认选中它（不影响已钉版本）。 */
  readonly currentDigest?: string;
  readonly publishedAt?: string;
}

/**
 * 系统层 Skill 根：与 Run 解析同一套环境变量优先级。compose 里 `./skills` 挂到
 * `/home/sandbox/skill`；开发机上可能没挂，`SystemSkillCatalog` 把「目录不存在」当空集。
 */
export function resolveSystemSkillRoot(env: Record<string, string | undefined>): string {
  return String(env['SKILLS_ROOT'] || env['AGENT_SKILLS_ROOT'] || SYSTEM_SKILL_ROOT).trim();
}

function diagnostic(path: string, code: string, message: string): SkillConfigDiagnostic {
  return Object.freeze({ path, code, message });
}

/**
 * `skillPolicy` 的语义校验（ADR 0015 D2，design §4.1）。
 *
 * 形状校验在 contract（两侧共用，无 I/O）；这里回答形状答不了的两个问题：
 * 名字在不在**当前 release**、org 条目在不在**本 org** 且未被吊销/弃用。
 *
 * @param skillPolicy 解析后的策略；形状非法时调用方已经报了错，传 `null` 即跳过
 * @param systemSkills 当前 release 的系统包
 * @param orgSkills 本 org 的 org 层版本
 * @returns 诊断（可空）与展开后的有效清单
 */
export function validateSkillPolicySemantics(
  skillPolicy: SkillPolicy | null,
  systemSkills: readonly SystemSkillEntry[],
  orgSkills: readonly OrgSkillEntry[],
): {
  readonly errors: readonly SkillConfigDiagnostic[];
  readonly effective: {
    readonly system: readonly string[];
    readonly org: readonly { readonly name: string; readonly contentDigest: string }[];
  };
} {
  if (!skillPolicy) {
    return Object.freeze({
      errors: Object.freeze([]),
      effective: Object.freeze({ system: Object.freeze([]), org: Object.freeze([]) }),
    });
  }
  const errors: SkillConfigDiagnostic[] = [];
  const systemNames = new Set(systemSkills.map((entry) => entry.name));
  const orgByKey = new Map(orgSkills.map((entry) => [`${entry.name}@${entry.contentDigest}`, entry]));
  let system: string[] = [];
  const org: Array<{ name: string; contentDigest: string }> = [];

  if (skillPolicy.system.mode === 'none') {
    system = [];
  } else if (skillPolicy.system.mode === 'all') {
    system = systemSkills.map((entry) => entry.name);
  } else {
    skillPolicy.system.names.forEach((name, index) => {
      if (!systemNames.has(name)) {
        errors.push(diagnostic(
          `skillPolicy.system.names[${index}]`,
          'SKILL_SYSTEM_UNKNOWN',
          `System skill "${name}" is not in the current release`,
        ));
        return;
      }
      system.push(name);
    });
  }

  skillPolicy.org.forEach((entry, index) => {
    const found = orgByKey.get(`${entry.name}@${entry.contentDigest}`);
    if (!found || found.status === 'revoked') {
      errors.push(diagnostic(
        `skillPolicy.org[${index}].contentDigest`,
        'SKILL_ORG_VERSION_UNKNOWN',
        `Org skill "${entry.name}" has no published version ${entry.contentDigest} in this organization`,
      ));
      return;
    }
    if (found.status === 'deprecated') {
      // 弃用是错误而不是警告：不能**新绑定**（ADR 0015 D8）。
      errors.push(diagnostic(
        `skillPolicy.org[${index}].contentDigest`,
        'SKILL_ORG_VERSION_DEPRECATED',
        `Org skill "${entry.name}" version ${entry.contentDigest} is deprecated and cannot be bound by a new AgentVersion`,
      ));
      return;
    }
    org.push({ name: entry.name, contentDigest: entry.contentDigest });
  });

  // 展开后的总量判定（形状阶段算不出，见 contract `skillPolicyTooLarge`）。
  const tooLarge = skillPolicyTooLarge({ system: system.length, org: org.length });
  if (tooLarge) errors.push(tooLarge);

  return Object.freeze({
    errors: Object.freeze(errors),
    effective: Object.freeze({
      system: Object.freeze([...system]),
      org: Object.freeze(org.map((entry) => Object.freeze({ ...entry }))),
    }),
  });
}

/** 按名字归组的 org 层版本（`revoked` 不进配置面：不能新绑定）。 */
export function orgSkillGroups(orgSkills: readonly OrgSkillEntry[]): Array<{
  name: string;
  description: string;
  currentDigest: string;
  versions: Array<{ contentDigest: string; status: string; publishedAt: string }>;
}> {
  const groups = new Map<string, {
    name: string;
    description: string;
    currentDigest: string;
    versions: Array<{ contentDigest: string; status: string; publishedAt: string }>;
  }>();
  for (const entry of orgSkills) {
    let group = groups.get(entry.name);
    if (!group) {
      group = { name: entry.name, description: '', currentDigest: '', versions: [] };
      groups.set(entry.name, group);
    }
    if (!group.description && entry.description) group.description = entry.description;
    if (entry.currentDigest) group.currentDigest = entry.currentDigest;
    // revoked 不展示：它在配置面等于不存在（ADR 0015 D8）。
    if (entry.status === 'revoked') continue;
    group.versions.push({
      contentDigest: entry.contentDigest,
      status: entry.status,
      publishedAt: entry.publishedAt ?? '',
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `platformConstraints.skills` 投影：系统层（名字 + 描述）与本 org org 层
 * （每名的版本与状态）。
 *
 * **不返回**任何用户的个人 Skill、物理路径或文件内容（design §4.2）。
 */
export function skillPlatformConstraints(
  systemSkills: readonly SystemSkillEntry[],
  orgSkills: readonly OrgSkillEntry[],
): Record<string, unknown> {
  return {
    system: systemSkills.map((entry) => ({
      name: entry.name,
      description: entry.description,
    })),
    org: orgSkillGroups(orgSkills).map((group) => ({
      name: group.name,
      description: group.description,
      currentDigest: group.currentDigest,
      versions: group.versions.map((version) => ({
        contentDigest: version.contentDigest,
        status: version.status,
        publishedAt: version.publishedAt,
      })),
    })),
  };
}
