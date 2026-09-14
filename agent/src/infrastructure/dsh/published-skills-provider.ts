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

type Loose = any;

/** exec 挂载已启用包的逻辑根（exec `AGENT_USER_SKILL_PATH`）。 */
export const USER_SKILL_LOGICAL_ROOT = '/home/sandbox/skill-user';

/** 一个已核对的已发布版本。 */
export interface PublishedSkillVersion {
  readonly name: string;
  readonly contentDigest: string;
  /** `.v/<digest>`，发现根。 */
  readonly versionRoot: string;
  /** `.v/<digest>/<name>`，包目录。 */
  readonly packageDir: string;
}

export function isPublishedSkillVersion(value: unknown): value is PublishedSkillVersion {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string' &&
    typeof v['contentDigest'] === 'string' &&
    typeof v['versionRoot'] === 'string' &&
    typeof v['packageDir'] === 'string'
  );
}

function logicalDirectory(name: string): string {
  return `${USER_SKILL_LOGICAL_ROOT}/${name}`;
}

function withLogicalPaths<T extends object>(item: T, name: string, providerName: string): T {
  const dir = logicalDirectory(name);
  return {
    ...item,
    provider: providerName,
    resourceBase: { kind: 'directory', path: dir },
    path: `${dir}/SKILL.md`,
  } as T;
}

export function createPublishedSkillsProvider(
  ctx: Loose,
  control: Loose,
  versions: readonly PublishedSkillVersion[],
  opts: { providerName?: string } = {},
): Loose {
  const providerName = opts.providerName ?? 'run-published';
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
  const originals = new Map<string, Loose>();

  return {
    name: providerName,
    async list(options: Loose) {
      const raw = await inner.list(options);
      const candidates: readonly Loose[] = Array.isArray(raw) ? raw : raw.candidates;
      const listed: Loose[] = [];
      originals.clear();
      for (const candidate of candidates) {
        const version = byName.get(candidate?.name);
        const directory = candidate?.locator?.directory;
        if (version === undefined || typeof directory !== 'string') continue;
        if (path.resolve(directory) !== path.resolve(version.packageDir)) continue;
        originals.set(version.name, candidate);
        listed.push(withLogicalPaths(candidate, version.name, providerName));
      }
      return Array.isArray(raw) ? listed : { candidates: listed, complete: raw.complete };
    },
    async get(candidate: Loose, options: Loose) {
      const version = byName.get(candidate?.name);
      const original = originals.get(candidate?.name);
      if (version === undefined || original === undefined) return undefined;
      const loaded = await inner.get(original, options);
      return loaded ? withLogicalPaths(loaded, version.name, providerName) : undefined;
    },
    dispose() {
      return inner.dispose();
    },
  };
}
