/**
 * 按启用账本构造、按 Run 注册的用户 Skill provider（design §3.3 第 6 条）。
 *
 * 为什么不直接把 owner 目录交给 `FileSystemSkillProvider`：
 * - 发现要以账本为准，而不是「目录里有什么」；
 * - 那个 provider 给模型的是 Agent 本地物理路径 `<base>/<org>/<user>/<name>`，而 exec
 *   把包挂在 `/home/sandbox/skill-user/<name>`。2026-09-14 真实链路复现：模型按基础目录
 *   `read` 资源文件得到 `FS_SANDBOX_DENIED: skill package not enabled: <orgId>`。
 *
 * 这里复用出厂 provider 做解析（frontmatter、调用策略都不重写），扫描根是每个版本的
 * `.v/<digest>`——它只含一个包目录。对外只做两件事：
 * 1. 只保留本 Run 清单里、且确实来自该版本包目录的候选（frontmatter 改名冒充不了别的包）；
 * 2. `path` / `resourceBase` 改写成与 exec 挂载一致的逻辑路径；加载时按名字找回原始候选，
 *    物理路径不出这个对象。
 */
import path from 'node:path';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import type { Context } from '@deepseek-ai/cordis';
import type {
  SkillCandidate,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderControl,
} from '@deepseek-ai/dsh-skill';
import type { PublishedSkillRootEntry } from '../../skills/run-skills.js';

/** filesystem provider 的 locator 实际形状（仅 directory/path 两个字符串字段）：此处只读 directory 做归属校验。 */
type FilesystemSkillLocator = { directory?: unknown; path?: unknown };

/** exec 挂载已启用包的逻辑根（exec `AGENT_USER_SKILL_PATH`）。 */
export const USER_SKILL_LOGICAL_ROOT = '/home/sandbox/skill-user';

function logicalDirectory(name: string, logicalRoot: string): string {
  return `${logicalRoot}/${name}`;
}

function withLogicalPaths<T extends object>(
  item: T,
  name: string,
  providerName: string,
  logicalRoot: string,
): T {
  const dir = logicalDirectory(name, logicalRoot);
  return {
    ...item,
    provider: providerName,
    resourceBase: { kind: 'directory', path: dir },
    path: `${dir}/SKILL.md`,
  } as T;
}

export function createPublishedSkillsProvider(
  ctx: Context,
  control: SkillProviderControl,
  versions: readonly PublishedSkillRootEntry[],
  opts: { providerName?: string; logicalRoot?: string } = {},
): SkillProvider & { dispose: () => Promise<void> } {
  const providerName = opts.providerName ?? 'run-published';
  // org 层挂在 `/home/sandbox/skill-org/<name>`（ADR 0015 D5），必须与 exec 的
  // `AGENT_ORG_SKILL_PATH` 一致；否则模型按 resourceBase 去 `read` 会被围栏拒。
  const logicalRoot = opts.logicalRoot ?? USER_SKILL_LOGICAL_ROOT;
  const byName = new Map(versions.map((version) => [version.name, version]));
  const inner = new FileSystemSkillProvider(ctx, control, {
    providerName,
    includeDefaultRoots: false,
    customSkillDirs: versions.map((version) => version.versionRoot),
    dshHome: '/home/sandbox',
    agentsHome: '/home/sandbox',
    watch: false,
  });
  /** 最近一次 list 的原始候选：get 只能加载这里面的名字。 */
  const originals = new Map<string, SkillCandidate>();

  return {
    name: providerName,
    async list(options: SkillLookupOptions) {
      const raw = await inner.list(options);
      const candidates: readonly SkillCandidate[] = Array.isArray(raw) ? raw : raw.candidates;
      const listed: SkillCandidate[] = [];
      originals.clear();
      for (const candidate of candidates) {
        const version = byName.get(candidate?.name);
        const directory = (candidate?.locator as FilesystemSkillLocator | undefined)?.directory; // 原因：locator 是 provider 私有句柄，此处仅读 directory 做归属校验
        if (version === undefined || typeof directory !== 'string') continue;
        if (path.resolve(directory) !== path.resolve(version.packageDir)) continue;
        originals.set(version.name, candidate);
        listed.push(withLogicalPaths(candidate, version.name, providerName, logicalRoot));
      }
      return Array.isArray(raw) ? listed : { candidates: listed, complete: raw.complete };
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions) {
      const version = byName.get(candidate?.name);
      const original = originals.get(candidate?.name);
      if (version === undefined || original === undefined) return undefined;
      const loaded = await inner.get(original, options);
      return loaded ? withLogicalPaths(loaded, version.name, providerName, logicalRoot) : undefined;
    },
    dispose() {
      return inner.dispose();
    },
  };
}

/**
 * 系统层 provider：扫系统根，但**只暴露本 Run 名单里的包**（ADR 0015 D4）。
 *
 * 为什么必须过滤两侧（list 与 get）：只过滤 `list` 的话，模型仍能用
 * `get`/`read` 直接点名未绑定的包——而「发现与挂载同构」要求模型能看见、能
 * `ls`/`read`/执行的恰好是有效清单。包名以**目录名**为准（与 DSH loader 的发现
 * 规则一致：`<root>/<name>/SKILL.md`），frontmatter 里改个名字冒充不了别的包。
 *
 * `names` 为 `null` 表示不过滤（旧形状的滚动升级兼容，由 runtime-factory 决定；
 * 那种情况根本不注册这个包装，直接给裸 provider）。
 */
export function createFilteredSystemSkillsProvider(
  ctx: Context,
  control: SkillProviderControl,
  input: { root: string; names: readonly string[]; providerName?: string },
): SkillProvider & { dispose: () => Promise<void> } {
  const providerName = input.providerName ?? 'run-filesystem';
  const allowed = new Set(input.names);
  const inner = new FileSystemSkillProvider(ctx, control, {
    providerName,
    includeDefaultRoots: false,
    customSkillDirs: [input.root],
    dshHome: '/home/sandbox',
    agentsHome: '/home/sandbox',
    watch: false,
  });
  /** 最近一次 list 通过名单的候选：get 只能加载这里面的名字。 */
  const originals = new Map<string, SkillCandidate>();

  /** 候选的目录名是不是本 Run 名单里的包。 */
  function allowedCandidate(candidate: SkillCandidate): boolean {
    const directory = (candidate?.locator as FilesystemSkillLocator | undefined)?.directory; // 原因：locator 是 provider 私有句柄，此处仅读 directory 做名单校验
    if (typeof directory !== 'string') return false;
    return allowed.has(path.basename(directory));
  }

  return {
    name: providerName,
    async list(options: SkillLookupOptions) {
      const raw = await inner.list(options);
      const candidates: readonly SkillCandidate[] = Array.isArray(raw) ? raw : raw.candidates;
      const listed: SkillCandidate[] = [];
      originals.clear();
      for (const candidate of candidates) {
        if (!allowedCandidate(candidate)) continue;
        const directory = (candidate.locator as FilesystemSkillLocator).directory as string; // 原因：allowedCandidate 刚校验过 directory 为字符串，此处仅补类型
        const name = path.basename(directory);
        originals.set(name, candidate);
        listed.push(candidate);
      }
      return Array.isArray(raw) ? listed : { candidates: listed, complete: raw.complete };
    },
    async get(candidate: SkillCandidate, options: SkillLookupOptions) {
      const name = typeof candidate?.name === 'string' ? candidate.name : '';
      const original = originals.get(name);
      if (original === undefined) return undefined;
      return inner.get(original, options);
    },
    dispose() {
      return inner.dispose();
    },
  };
}
