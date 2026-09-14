/**
 * 用户侧 Skill 的**启用闸门**（ADR 0009 D7 / 计划 H6.4–H6.6）与发布存储（design §3.3 S1）。
 *
 * ## 闸门只剩这一处
 *
 * D7 取消了 `skill_install` / `skill_create` / `skill_edit` / `skill_uninstall`
 * 整套工具。模型改用 `write` / `bash` 在**草稿根**里直接造包——和它在 workspace
 * 里干活是同一组工具、同一套围栏。**「写」不再经任何审批**，这是相对
 * ADR 0006 的实质放松，写在这里以免日后当成疏忽。
 *
 * 被挡住的是 ADR 0006 真正在意的另外两件事，它们都只发生在**启用之后**：
 * 1. 包进入之后每一轮的 system prompt；
 * 2. 包进入只读挂载、被当作既有能力执行。
 *
 * 所以闸门就是这里：人在 UI 上按下「启用」的那一下。
 *
 * ## 为什么是「复制字节」而不是「挂草稿目录」
 *
 * ADR 0006 P1 (B) 点名的绕过是：模型在包被批准之后再改它的内容。
 * 复制之后两者是两份字节：模型改草稿动不了已启用的副本。
 *
 * ## 按摘要分版本（design §3.3 S1）
 *
 * 发布布局见 `@pi/contract/skill-manifest.js`：`<name>/.v/<digest>/<name>/` 加侧车
 * `<name>/.v/<digest>.json`。启用不再原地替换：新摘要写进新目录，旧版本留给仍在
 * 运行、清单里点着它的 Run，过了宽限期、且账本不再引用时才回收。
 *
 * 摘要**按复制出来的暂存字节计算**，不按草稿计算：草稿根模型可写，校验与复制之间
 * 草稿可能被改，按草稿算出的摘要就会和发布出去的字节对不上。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseSkillVersionSidecar,
  skillVersionPaths,
  SKILL_DIGEST_PATTERN,
  SKILL_VERSIONS_DIRNAME,
  type SkillVersionPaths,
  type SkillVersionSidecar,
} from '@pi/contract/skill-manifest.js';
import { validateSkillPackage } from './validator.js';
import { ensureTraversableUserSkillRoot } from './install.js';

/** 一个已启用副本的上限。与上传的 zip 同量级，防止一次启用吃光磁盘。 */
export const SKILL_ENABLE_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_ENABLE_MAX_FILES = 512;

export interface EnabledSkillRecord {
  readonly name: string;
  /** 内容摘要：对（相对路径, 字节）有序求和，与文件系统时间戳无关。 */
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 已发布版本的包目录（挂载源）。 */
  readonly publishedPath: string;
  /** 同一摘要此前已发布且完整，本次未重写字节。 */
  readonly reused: boolean;
}

interface ScannedFile {
  readonly relative: string;
  readonly absolute: string;
  readonly size: number;
}

/**
 * 递归收集一个草稿包里的文件。
 *
 * **不跟随符号链接**：草稿根是模型可写的，一条指向 `/etc` 的链接会把宿主文件
 * 复制进已启用副本。`lstat` + 跳过非普通文件是这里唯一正确的做法。
 */
async function scanPackage(dir: string): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Skill package contains a symlink (${relative}); a link out of the draft ` +
            'root would copy host files into the published package',
        );
      }
      if (stat.isDirectory()) {
        if (entry.name === '.git') {
          throw new Error(`Skill package contains VCS metadata (${relative})`);
        }
        await walk(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Skill package contains a non-regular file (${relative})`);
      }
      out.push({ relative, absolute, size: stat.size });
    }
  };
  await walk(dir, '');
  return out;
}

/**
 * 校验一个草稿包并算出它的内容摘要。**不写任何东西**——这一半是纯读，
 * 好让 UI 能先"预检"再让人决定要不要启用。
 */
export async function inspectDraftPackage(
  draftPackageDir: string,
  expectedName?: string,
  systemSkillNames: Iterable<string> = [],
) {
  // 结构校验复用既有实现：输入从「解包后的 zip 目录」换成「草稿目录」，
  // 两者本来就是同一种东西（ADR 0009 D7 / 计划 H6.4）。
  const meta = validateSkillPackage(
    draftPackageDir,
    expectedName !== undefined ? { expectedName } : {},
  );

  // **不得遮蔽系统 skill**（ADR 0009 D7 引的原话：「an installed skill must never
  // be able to shadow or overwrite one the platform vouches for」）。
  //
  // 检查必须在**启用**这一刻做，不是在写草稿时做：草稿叫什么名字无所谓，
  // 它不进任何人的上下文；真正危险的是一个同名包被挂进 `skill-user/` 之后，
  // 发现顺序让它盖住平台背书的那一个。
  const reserved = new Set([...systemSkillNames]);
  if (reserved.has(meta.name)) {
    throw new Error(
      `Skill "${meta.name}" collides with a bundled system Skill and cannot be enabled`,
    );
  }

  const files = await scanPackage(draftPackageDir);
  if (files.length === 0) throw new Error('Skill package is empty');
  if (files.length > SKILL_ENABLE_MAX_FILES) {
    throw new Error(
      `Skill package has ${files.length} files; maximum is ${SKILL_ENABLE_MAX_FILES}`,
    );
  }
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  if (totalBytes > SKILL_ENABLE_MAX_BYTES) {
    throw new Error(
      `Skill package is ${totalBytes} bytes; maximum is ${SKILL_ENABLE_MAX_BYTES}`,
    );
  }

  // 摘要绑的是**内容**，不是时间戳/inode：同样的字节在任何机器上算出同一个值，
  // 所以它能用来回答「审批中心里显示的那一版，和现在挂着的这一版，是同一份吗」。
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.relative, 'utf8');
    hash.update('\0');
    hash.update(await fsp.readFile(file.absolute));
    hash.update('\0');
  }

  return { name: meta.name, description: meta.description, files, totalBytes, contentDigest: hash.digest('hex') };
}

/** 一个已发布版本的核对结果。 */
export type PublishedVersionCheck =
  | { readonly ok: true; readonly paths: SkillVersionPaths; readonly sidecar: SkillVersionSidecar }
  | { readonly ok: false; readonly paths: SkillVersionPaths; readonly reason: 'missing' | 'mismatch' };

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 核对 owner 根下某个名字 + 摘要是否是完整的已发布版本：包目录是普通目录、含普通文件
 * SKILL.md、侧车存在且与名字/摘要一致。缺失类返回 `ok: false`；权限、I/O 等其它错误
 * 原样抛出——存储不可读不能被当成「没有这个包」。
 */
export async function readPublishedVersion(
  publishedRoot: string,
  name: string,
  contentDigest: string,
): Promise<PublishedVersionCheck> {
  const paths = skillVersionPaths(publishedRoot, name, contentDigest);
  let sidecarText: string;
  try {
    const pkg = await fsp.lstat(paths.packageDir);
    const skillMd = await fsp.lstat(path.join(paths.packageDir, 'SKILL.md'));
    if (!pkg.isDirectory() || !skillMd.isFile()) return { ok: false, paths, reason: 'mismatch' };
    sidecarText = await fsp.readFile(paths.sidecar, 'utf8');
  } catch (err) {
    if (isMissing(err)) return { ok: false, paths, reason: 'missing' };
    throw err;
  }
  const sidecar = parseSkillVersionSidecar(sidecarText);
  if (sidecar === null || sidecar.name !== name || sidecar.contentDigest !== contentDigest) {
    return { ok: false, paths, reason: 'mismatch' };
  }
  return { ok: true, paths, sidecar };
}

/**
 * 启用：校验草稿 → 复制到暂存目录 → **按暂存字节算摘要** → 改名为 `.v/<digest>` →
 * 最后写侧车。侧车在版本目录之后写，所以任何中断都只会留下「无侧车」的目录，
 * 不会被核对为已发布；同一摘要已完整发布时直接复用。
 *
 * 并发由调用方的 owner 行锁串行化（`skill-enablement-service.ts`），这里不再加锁。
 */
export async function publishDraftVersion(input: {
  draftPackageDir: string;
  /** owner 根 `<base>/<orgId>/<userId>`。 */
  publishedRoot: string;
  expectedName?: string;
  /** 平台背书的系统 skill 名；与之同名的包不得启用。 */
  systemSkillNames?: Iterable<string>;
  now?: () => Date;
}): Promise<EnabledSkillRecord> {
  const systemNames = [...(input.systemSkillNames ?? [])];
  const draft = await inspectDraftPackage(input.draftPackageDir, input.expectedName, systemNames);

  await ensureTraversableUserSkillRoot(input.publishedRoot);
  const versionsDir = path.join(input.publishedRoot, draft.name, SKILL_VERSIONS_DIRNAME);
  await fsp.mkdir(versionsDir, { recursive: true, mode: 0o755 });
  const staging = path.join(versionsDir, `.staging-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const stagedPackage = path.join(staging, draft.name);

  try {
    for (const file of draft.files) {
      const target = path.join(stagedPackage, file.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file.absolute, target);
      // 已发布副本是只读的：模型改草稿动不了它，而它自己也不该在容器里被改。
      // 真正的只读由 `ro_bind` 保证（ADR 0008 D4），这里的权限位是第二道。
      await fsp.chmod(target, 0o444);
    }
    // 摘要以暂存字节为准，并重新套用结构、大小与系统名校验。
    const staged = await inspectDraftPackage(stagedPackage, draft.name, systemNames);
    const existing = await readPublishedVersion(input.publishedRoot, staged.name, staged.contentDigest);
    if (existing.ok) {
      await fsp.rm(staging, { recursive: true, force: true });
      return {
        name: staged.name,
        contentDigest: staged.contentDigest,
        fileCount: staged.files.length,
        totalBytes: staged.totalBytes,
        publishedPath: existing.paths.packageDir,
        reused: true,
      };
    }
    const paths = existing.paths;
    // 无侧车或侧车不符的同名目录是中断的发布：整个替换掉。
    await fsp.rm(paths.sidecar, { force: true });
    await fsp.rm(paths.versionRoot, { recursive: true, force: true });
    await fsp.rename(staging, paths.versionRoot);
    const sidecar: SkillVersionSidecar = {
      name: staged.name,
      contentDigest: staged.contentDigest,
      fileCount: staged.files.length,
      totalBytes: staged.totalBytes,
      publishedAt: (input.now ?? (() => new Date()))().toISOString(),
    };
    const tmp = `${paths.sidecar}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmp, JSON.stringify(sidecar), { mode: 0o444 });
    await fsp.rename(tmp, paths.sidecar);
    return {
      name: staged.name,
      contentDigest: staged.contentDigest,
      fileCount: staged.files.length,
      totalBytes: staged.totalBytes,
      publishedPath: paths.packageDir,
      reused: false,
    };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function entryTime(file: string, sidecarFile?: string): Promise<number> {
  if (sidecarFile !== undefined) {
    try {
      const sidecar = parseSkillVersionSidecar(await fsp.readFile(sidecarFile, 'utf8'));
      if (sidecar !== null) return Date.parse(sidecar.publishedAt);
    } catch {
      // 侧车缺失或不可读：退回目录时间。
    }
  }
  return (await fsp.lstat(file)).mtimeMs;
}

/**
 * 回收一个包名下不再需要的版本（design §3.3 第 5 条）。
 *
 * 只删除**不在保留集合里且早于宽限期**的版本目录（连同侧车）、过期的暂存目录与孤立侧车。
 * 保留集合由调用方在 owner 行锁内给出：至少包含事务前账本引用的摘要与本次写入的摘要，
 * 这样即使事务随后回滚，账本也不会指向已被删掉的字节。不新增后台定时器。
 */
export async function collectStaleSkillVersions(input: {
  publishedRoot: string;
  name: string;
  keepDigests: Iterable<string>;
  graceMs: number;
  now?: () => Date;
}): Promise<string[]> {
  const versionsDir = path.join(input.publishedRoot, input.name, SKILL_VERSIONS_DIRNAME);
  let entries;
  try {
    entries = await fsp.readdir(versionsDir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
  const keep = new Set(input.keepDigests);
  const cutoff = (input.now ?? (() => new Date()))().getTime() - Math.max(0, input.graceMs);
  const versionDirs = new Set(
    entries.filter((e) => e.isDirectory() && SKILL_DIGEST_PATTERN.test(e.name)).map((e) => e.name),
  );
  const removed: string[] = [];
  for (const entry of entries) {
    const full = path.join(versionsDir, entry.name);
    if (entry.isDirectory() && SKILL_DIGEST_PATTERN.test(entry.name)) {
      if (keep.has(entry.name)) continue;
      const sidecar = path.join(versionsDir, `${entry.name}.json`);
      if ((await entryTime(full, sidecar)) > cutoff) continue;
      await fsp.rm(sidecar, { force: true });
      await fsp.rm(full, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }
    if (entry.isDirectory() && entry.name.startsWith('.staging-')) {
      if ((await entryTime(full)) <= cutoff) await fsp.rm(full, { recursive: true, force: true });
      continue;
    }
    const digest = entry.name.endsWith('.json') ? entry.name.slice(0, -'.json'.length) : '';
    if (entry.isFile() && SKILL_DIGEST_PATTERN.test(digest) && !versionDirs.has(digest) && !keep.has(digest)) {
      if ((await entryTime(full)) <= cutoff) await fsp.rm(full, { force: true });
    }
  }
  return removed;
}
