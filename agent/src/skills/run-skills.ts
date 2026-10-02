/**
 * 一个 Run 的**有效 Skill 清单**（ADR 0015 D1，design §3 / §6.1）。
 *
 * ## 一份清单，两个消费面
 *
 * Agent 侧发现（prompt 目录）与 exec 只读挂载必须**同构**：模型能看见的、能
 * `ls`/`read`/执行的，恰好是这份清单。所以解析只做一次，结果同时喂给：
 * - runtime-factory 在 agent scope 注册的 provider（`discoverable`）；
 * - exec RPC 的 `systemSkills` / `enabledSkills`（`mountable`）。
 *
 * ## 优先级与诊断
 *
 * 名字在一个 Run 内必须唯一（ADR 0015 D7）。历史数据可能冲突（例如 org 名晚于
 * 用户启用出现），按 **system > org > user** 取胜者；落败项**排除并写诊断**，
 * 不静默覆盖。被排除的原因分得清：`revoked` / `missing` / `mismatch` /
 * `name_conflict` / `policy_denied` / `not_in_release`。
 *
 * ## 读失败 ≠ 空能力集
 *
 * 账本读失败一律抛出（Run 失败），不降级成「这个用户没有 Skill」。单个包的
 * 字节核对失败（版本目录缺失、侧车不符）只排除该包并记诊断——那是**单个坏包**，
 * 不是存储不可读。
 */
import type { SkillPolicy } from '@dsh/contract/skill-policy.js';
import { orgSkillRootFor } from './paths.js';

/** 系统层：release 交付的包，按名选择、不钉摘要（ADR 0015 D4）。 */
export interface SystemSkillRootEntry {
  readonly kind: 'system';
  /** 逻辑挂载根（`/home/sandbox/skill`）。 */
  readonly root: string;
  /**
   * 是否按 `names` 过滤。
   *
   * **`filtered: false` 与「名单为空」是两件事**：前者是旧形状（裸目录字符串，
   * 整个系统树都进发现，滚动升级兼容），后者是 `mode: none`（一个都不挂）。
   * 少了这个标记就会把「旧 Agent 的全部系统 Skill」读成「什么都不给」。
   */
  readonly filtered: boolean;
  /** 本 Run 选中的包名；`filtered: false` 时无意义。 */
  readonly names: readonly string[];
}

/** 已核对的按摘要分版本包（org 层 / user 层）。 */
export interface PublishedSkillRootEntry {
  readonly kind: 'user' | 'org';
  readonly name: string;
  readonly contentDigest: string;
  /** `.v/<digest>`：只含一个包的发现根。 */
  readonly versionRoot: string;
  /** 真正的包目录（exec 挂载源）。 */
  readonly packageDir: string;
}

export type RunSkillPathEntry = SystemSkillRootEntry | PublishedSkillRootEntry;

/** 排除原因。分开写是为了让「配置没生效」与「包坏了」在日志里可辨别。 */
export type SkillResolutionDiagnosticCode =
  /** 绑定的 org 版本已吊销（ADR 0015 D8）。 */
  | 'revoked'
  /** 绑定的 org 版本在本 org 不存在。 */
  | 'missing'
  /** 绑定的 org 版本文本与侧车/字节不符。 */
  | 'mismatch'
  /** 用户启用的版本在发布存储里缺失或损坏。 */
  | 'user_version_unusable'
  /** 系统名单里的名字已不在当前 release（保存后 release 变了）。 */
  | 'not_in_release'
  /** 同名被更高优先级层占据。 */
  | 'name_conflict'
  /** 策略不允许这一层（`user: deny`）。 */
  | 'policy_denied';

export interface SkillResolutionDiagnostic {
  readonly code: SkillResolutionDiagnosticCode;
  readonly name: string;
  readonly scope: 'system' | 'org' | 'user';
  readonly message: string;
}

export interface RunSkills {
  /** 喂给 runtime-factory 的 provider 注册（发现面）。 */
  readonly discoverable: readonly RunSkillPathEntry[];
  /** 喂给 exec 的挂载清单（system 走 `systemSkills`，按摘要的走 `enabledSkills`）。 */
  readonly systemNames: readonly string[];
  readonly systemRoot: string;
  readonly published: readonly PublishedSkillRootEntry[];
  readonly diagnostics: readonly SkillResolutionDiagnostic[];
}

/** `lexists` 级别的可注入依赖——解析本身不碰数据库连接。 */
export interface ResolveRunSkillsDeps {
  /** 用户启用账本（既有 S1）。 */
  listEnabled: (owner: { orgId: string; userId: string }) => Promise<
    ReadonlyArray<{ name: string; contentDigest: string }>
  >;
  /**
   *org 层账本：给出本 Run 绑定的 (name, digest) 的状态。
   * 返回 `undefined` 表示该版本不存在。
   */
  readOrgVersion?: (input: {
    orgId: string;
    name: string;
    contentDigest: string;
  }) => Promise<{ status: 'active' | 'deprecated' | 'revoked' } | undefined>;
  logger?: { warn: (...args: unknown[]) => void };
}

/** 系统根的默认逻辑挂载点，与 exec 的 `AGENT_SYSTEM_SKILL_PATH` 一致。 */
export const SYSTEM_SKILL_LOGICAL_ROOT = '/home/sandbox/skill';
/** org 层的逻辑挂载根，与 exec 的 `AGENT_ORG_SKILL_PATH` 一致（ADR 0015 D5）。 */
export const ORG_SKILL_LOGICAL_ROOT = '/home/sandbox/skill-org';
/** 用户层的逻辑挂载根，与 exec 的 `AGENT_USER_SKILL_PATH` 一致。 */
export const USER_SKILL_LOGICAL_ROOT = '/home/sandbox/skill-user';

function diagnostic(
  code: SkillResolutionDiagnosticCode,
  scope: 'system' | 'org' | 'user',
  name: string,
  message: string,
): SkillResolutionDiagnostic {
  return Object.freeze({ code, scope, name, message });
}

/** `additionalSkillPaths` 里系统层那一项的判定。 */
export function isSystemSkillRootEntry(value: unknown): value is SystemSkillRootEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v['kind'] === 'system' && typeof v['root'] === 'string' && Array.isArray(v['names']);
}

/** `additionalSkillPaths` 里按摘要分版本那一项的判定（org / user）。 */
export function isPublishedSkillRootEntry(value: unknown): value is PublishedSkillRootEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v['kind'] === 'user' || v['kind'] === 'org') &&
    typeof v['name'] === 'string' &&
    typeof v['contentDigest'] === 'string' &&
    typeof v['versionRoot'] === 'string' &&
    typeof v['packageDir'] === 'string'
  );
}

/**
 * 从 `additionalSkillPaths` 拆出系统层与按摘要分版本的两组。
 *
 * `additionalSkillPaths` 历史上是**裸字符串数组**（用户层目录）。现在系统层还要带
 * 名单，所以两种形状并存：裸字符串按旧语义当系统根（名字不限），结构化项按 `kind` 分。
 * 这个函数是唯一的解析点——runtime-factory 注册 provider 与构造 exec 清单都走它，
 * 避免两处各判一次导致「发现的多、挂载的少」。
 */
export function splitRunSkillPaths(values: readonly unknown[]): {
  readonly systemEntries: readonly SystemSkillRootEntry[];
  readonly published: readonly PublishedSkillRootEntry[];
} {
  const systemEntries: SystemSkillRootEntry[] = [];
  const published: PublishedSkillRootEntry[] = [];
  for (const value of values) {
    if (isPublishedSkillRootEntry(value)) {
      published.push(value);
      continue;
    }
    if (isSystemSkillRootEntry(value)) {
      systemEntries.push(value);
      continue;
    }
    // 旧形状：裸目录字符串 = 系统根，名单不限。
    if (typeof value === 'string' && value.trim()) {
      systemEntries.push(Object.freeze({
        kind: 'system',
        root: value.trim(),
        // 旧形状：整棵树都进发现与挂载（滚动升级兼容，ADR 0015 D4）。
        filtered: false,
        names: Object.freeze([] as string[]),
      }));
    }
  }
  return Object.freeze({
    systemEntries: Object.freeze(systemEntries),
    published: Object.freeze(published),
  });
}

/**
 * 算出这个 Run 的有效清单。
 *
 * **物理根与逻辑根是两件事**，这里刻意都显式传：
 * - `*PhysicalBase`：发布存储的实际路径，用于 `readPublishedVersion` 核对字节与侧车；
 * - `discoverable` 里给的是**物理** `versionRoot` / `packageDir`（provider 要从盘上读）；
 * - provider 展示给模型的路径由 `createPublishedSkillsProvider` 改写成逻辑根，
 *   与 exec 的挂载点一致（design §6.2）。
 *
 * @param input.systemRoot 系统包所在的**物理**目录（agent 侧扫它做发现）
 * @param input.allSystemNames 当前 release 的全部系统包名（`mode: all` 展开用）
 * @param input.policy 绑定的 `skillPolicy`；`null` = 省略 = 当前行为
 */
export async function resolveRunSkills(input: {
  orgId: string;
  userId: string;
  /** 用户层发布存储基根（物理），实际 owner 根是 `<base>/<orgId>/<userId>`。 */
  userPhysicalBase: string;
  /** org 层发布存储基根（物理），实际 owner 根是 `<base>/<orgId>/_org`。 */
  orgPhysicalBase: string;
  systemRoot: string;
  allSystemNames: readonly string[];
  policy: SkillPolicy | null;
  deps: ResolveRunSkillsDeps;
}): Promise<RunSkills> {
  const logger = input.deps.logger ?? console;
  const diagnostics: SkillResolutionDiagnostic[] = [];
  const policy: SkillPolicy = input.policy ?? {
    system: { mode: 'all', names: [] },
    org: [],
    user: 'allow',
  };

  // ── system：与 release 求交 ────────────────────────────────────────────────
  const releaseNames = new Set(input.allSystemNames);
  let systemNames: string[] = [];
  if (policy.system.mode === 'none') {
    systemNames = [];
  } else if (policy.system.mode === 'all') {
    systemNames = [...input.allSystemNames];
  } else {
    for (const name of policy.system.names) {
      if (!releaseNames.has(name)) {
        // 配置保存后 release 变了。排除并写诊断——不静默少挂一个包。
        diagnostics.push(diagnostic(
          'not_in_release',
          'system',
          name,
          `system skill "${name}" is no longer in this release`,
        ));
        continue;
      }
      systemNames.push(name);
    }
  }

  // ── 取包（org 优先于 user），按名字去重 ────────────────────────────────────
  const { readPublishedVersion } = await import('./enablement.js');
  const orgRoot = orgSkillRootFor({ orgId: input.orgId }, input.orgPhysicalBase);
  const winners = new Map<string, PublishedSkillRootEntry>();

  for (const binding of policy.org) {
    // 账本读失败 → 抛出（fail-closed），不降级成空清单。
    const status = input.deps.readOrgVersion
      ? await input.deps.readOrgVersion({
        orgId: input.orgId,
        name: binding.name,
        contentDigest: binding.contentDigest,
      })
      : undefined;
    if (status === undefined || status.status === 'revoked') {
      diagnostics.push(diagnostic(
        status === undefined ? 'missing' : 'revoked',
        'org',
        binding.name,
        status === undefined
          ? `org skill "${binding.name}" has no published version ${binding.contentDigest}`
          : `org skill "${binding.name}" version ${binding.contentDigest} is revoked`,
      ));
      continue;
    }
    if (status.status === 'deprecated') {
      // 已钉的版本照常运行（ADR 0015 D8）：deprecated 只挡**新绑定**。
      logger.warn(
        `[skills] org skill "${binding.name}" is deprecated; a pinned AgentVersion keeps running`,
      );
    }
    const check = await readPublishedVersion(orgRoot, binding.name, binding.contentDigest);
    if (!check.ok) {
      diagnostics.push(diagnostic(
        'mismatch',
        'org',
        binding.name,
        `org skill "${binding.name}" bytes do not match digest ${binding.contentDigest}`,
      ));
      continue;
    }
    winners.set(binding.name, {
      kind: 'org',
      name: binding.name,
      contentDigest: binding.contentDigest,
      versionRoot: check.paths.versionRoot,
      packageDir: check.paths.packageDir,
    });
  }

  if (policy.user === 'allow') {
    const userRoot = `${input.userPhysicalBase.replace(/\/+$/, '')}/${input.orgId}/${input.userId}`;
    for (const row of await input.deps.listEnabled({
      orgId: input.orgId,
      userId: input.userId,
    })) {
      // org 层已经占了这个名字：作者本人继续迭代草稿的路径（design §7.3），
      // 但本 Run 里 org 版本优先——所以**先**判重名，省掉一次盘上核对。
      if (winners.has(row.name)) {
        diagnostics.push(diagnostic(
          'name_conflict',
          'user',
          row.name,
          `"${row.name}" is already provided by the org tier; the user copy is excluded from this Run`,
        ));
        continue;
      }
      const check = await readPublishedVersion(userRoot, row.name, row.contentDigest);
      if (!check.ok) {
        const reason = (check as { reason: 'missing' | 'mismatch' }).reason;
        diagnostics.push(diagnostic(
          'user_version_unusable',
          'user',
          row.name,
          `enabled skill "${row.name}" is ${reason} in the published store`,
        ));
        continue;
      }
      winners.set(row.name, {
        kind: 'user',
        name: row.name,
        contentDigest: row.contentDigest,
        versionRoot: check.paths.versionRoot,
        packageDir: check.paths.packageDir,
      });
    }
  } else {
    logger.warn('[skills] skillPolicy.user is "deny"; this Run carries no user-tier skill');
  }

  // 系统层与在跑包重名：system 胜（ADR 0015 D7）。
  const systemSet = new Set(systemNames);
  for (const [name, entry] of [...winners]) {
    if (systemSet.has(name)) {
      diagnostics.push(diagnostic(
        'name_conflict',
        entry.kind,
        name,
        `"${name}" is already provided by the system tier; the ${entry.kind} copy is excluded from this Run`,
      ));
      winners.delete(name);
    }
  }

  const published = [...winners.values()].sort((a, b) => a.name.localeCompare(b.name));
  // 诊断随返回值交给调用方，并写 Worker 日志。`resolveRunSkillPaths` 只取
  // `discoverable`；持久可见的是 `run.started` 事件 payload 的 `skillDiagnostics`
  //（`ExecuteRunService` 在写 `run.started` 之前与这里共用同一份解析再算一次）。
  for (const entry of diagnostics) {
    logger.warn(
      `[skills] excluded ${entry.scope} skill "${entry.name}" (${entry.code}): ${entry.message}`,
    );
  }
  const systemEntry: SystemSkillRootEntry = Object.freeze({
    kind: 'system',
    root: input.systemRoot,
    // 新清单一律按名过滤；`filtered: false` 只出现在旧形状的裸字符串上。
    filtered: true,
    names: Object.freeze([...systemNames]),
  });
  return Object.freeze({
    discoverable: Object.freeze([systemEntry, ...published]),
    systemNames: Object.freeze([...systemNames]),
    systemRoot: input.systemRoot,
    published: Object.freeze(published),
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * 从拆分结果里挑出**生效的系统层**与它的扫描根。
 *
 * 结构化项（`filtered: true`）优先——它是新清单，带了绑定选中的名单。裸字符串是旧
 * 形状，只作为回退。返回 `names: null` 表示「不按名过滤」（旧语义），
 * `names: []` 表示「一个都不挂」（`mode: none`，或全部名字都不在 release 里）。
 */
export function effectiveSystemSkills(values: readonly unknown[]): {
  readonly root: string | null;
  readonly names: readonly string[] | null;
} {
  const { systemEntries } = splitRunSkillPaths(values);
  const filtered = systemEntries.find((entry) => entry.filtered);
  if (filtered) return Object.freeze({ root: filtered.root, names: filtered.names });
  const unfiltered = systemEntries[0];
  if (unfiltered) return Object.freeze({ root: unfiltered.root, names: null });
  return Object.freeze({ root: null, names: null });
}
