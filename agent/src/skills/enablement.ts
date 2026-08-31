/**
 * 用户侧 Skill 的**启用闸门**（ADR 0009 D7 / 计划 H6.4–H6.6）。
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
 * 如果已启用的包和草稿是**同一份字节**，那条绕过就还在——批准的是 A，
 * 运行的是模型随后改成的 B。
 *
 * 复制之后两者是两份字节：模型改草稿动不了已启用的副本。于是
 * **不需要每 Run 重算摘要**，也不需要「摘要变了自动落回未启用」这类常驻校验。
 * 停用 / 重新启用就是删掉或替换那份副本。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateSkillPackage } from './validator.js';
import { atomicReplaceDir, ensureTraversableUserSkillRoot } from './install.js';

/** 一个已启用副本的上限。与上传的 zip 同量级，防止一次启用吃光磁盘。 */
export const SKILL_ENABLE_MAX_BYTES = 50 * 1024 * 1024;
export const SKILL_ENABLE_MAX_FILES = 512;

export interface EnabledSkillRecord {
  readonly name: string;
  /** 内容摘要：对（相对路径, 字节）有序求和，与文件系统时间戳无关。 */
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** 已发布副本的物理路径。 */
  readonly publishedPath: string;
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

/**
 * 启用：校验草稿 → **把字节复制成一份只读的已发布副本** → 返回可入库的记录。
 *
 * 复制先落到一个同父目录下的临时目录，再 `atomicReplaceDir` 换上去——
 * 半个包被挂进 `ro_bind` 比没有包更糟。
 */
export async function enableDraftPackage(input: {
  draftPackageDir: string;
  publishedRoot: string;
  expectedName?: string;
  /** 平台背书的系统 skill 名；与之同名的包不得启用。 */
  systemSkillNames?: Iterable<string>;
}): Promise<EnabledSkillRecord> {
  const inspected = await inspectDraftPackage(
    input.draftPackageDir,
    input.expectedName,
    input.systemSkillNames ?? [],
  );

  await ensureTraversableUserSkillRoot(input.publishedRoot);
  const destination = path.join(input.publishedRoot, inspected.name);
  const staging = path.join(
    input.publishedRoot,
    `.staging-${inspected.name}-${process.pid}-${Date.now()}`,
  );

  try {
    for (const file of inspected.files) {
      const target = path.join(staging, file.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(file.absolute, target);
      // 已发布副本是只读的：模型改草稿动不了它，而它自己也不该在容器里被改。
      // 真正的只读由 `ro_bind` 保证（ADR 0008 D4），这里的权限位是第二道。
      await fsp.chmod(target, 0o444);
    }
    await atomicReplaceDir(staging, destination);
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    name: inspected.name,
    contentDigest: inspected.contentDigest,
    fileCount: inspected.files.length,
    totalBytes: inspected.totalBytes,
    publishedPath: destination,
  };
}

/**
 * 停用：删掉那份已发布副本。
 *
 * 草稿**不动**——停用不是删除用户的工作成果，只是把它从模型的上下文里拿走。
 */
export async function disableSkillPackage(input: {
  publishedRoot: string;
  name: string;
}): Promise<{ removed: boolean }> {
  const destination = path.join(input.publishedRoot, input.name);
  if (!fs.existsSync(destination)) return { removed: false };
  await fsp.rm(destination, { recursive: true, force: true });
  return { removed: true };
}
