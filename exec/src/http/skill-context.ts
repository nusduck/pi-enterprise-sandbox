/**
 * 内部面请求 → 本次执行的 Skill 包集合（ADR 0015 D4/D5）。
 *
 * fs、shell、artifact 三个内部入口都从请求里的 `enabledSkills` / `systemSkills` 拼出
 * 同一组字段。只在这里拼一次：三处各写一份，迟早有一处漏掉 `kind` 分根或兼容分支，
 * 于是同一个 Run 的 `read` 与 `bash` 看到的 Skill 不一样。
 */
import type { EnabledSkillRef } from '@dsh/contract/skill-manifest.js';
import type {
  EnabledSkillPackagesResolver,
  SystemSkillPackagesResolver,
  WorkspaceContext,
} from '../types.js';

/** 兼容期告警的汇总窗口：每个窗口最多一行日志，带累计次数。 */
const LEGACY_LOG_WINDOW_MS = 60_000;
let legacyCount = 0;
let legacyLoggedAt = 0;

/**
 * 记录一次「内部面请求没带 `systemSkills`」。
 *
 * design §8：这是滚动升级兼容期的旧 Agent。收紧（缺省即 `ENVELOPE_INVALID`）的
 * 前提是这条告警在全部 exec 上归零，所以它必须可数、不能被静默吞掉。
 */
function noteLegacySystemManifest(): void {
  legacyCount += 1;
  const now = Date.now();
  if (now - legacyLoggedAt < LEGACY_LOG_WINDOW_MS) return;
  legacyLoggedAt = now;
  console.warn(
    `[skills] ${legacyCount} internal request(s) without systemSkills since start; `
      + 'mounting the whole system skill tree for them (legacy agent, design §8 rollout window)',
  );
}

/**
 * @param systemSkills 请求里的系统名单；`null` = 请求没带（兼容期旧 Agent）
 */
export function skillPackagesForRequest(
  deps: {
    readonly enabledSkillPackagesFor: EnabledSkillPackagesResolver;
    readonly systemSkillPackagesFor: SystemSkillPackagesResolver;
  },
  owner: { readonly orgId: string; readonly userId: string },
  enabledSkills: readonly EnabledSkillRef[],
  systemSkills: readonly string[] | null,
): Pick<WorkspaceContext, 'enabledSkillPackages' | 'orgSkillPackages' | 'systemSkillPackages'> {
  const published = deps.enabledSkillPackagesFor(owner.orgId, owner.userId, enabledSkills);
  if (systemSkills === null) noteLegacySystemManifest();
  return {
    // org 层与用户层挂到不同逻辑根（ADR 0015 D5）。
    enabledSkillPackages: published.filter((pkg) => pkg.kind !== 'org'),
    orgSkillPackages: published.filter((pkg) => pkg.kind === 'org'),
    ...(systemSkills === null ? {} : { systemSkillPackages: deps.systemSkillPackagesFor(systemSkills) }),
  };
}
