/**
 * 系统层 Skill 目录（ADR 0015 D1/D4，design §3、§4.2）。
 *
 * 「系统层」= 部署 release 交付的只读包（compose 里是 `./skills`），逻辑根
 * `<SYSTEM_SKILL_ROOT>/<name>`。本模块只回答一个问题：**当前 release 里有哪些系统包**，
 * 以及给配置面展示用的 `name` + `description`。
 *
 * ## 为什么存在于 Agent 侧
 *
 * `skillPolicy.system` 是**按名选择、不钉摘要**（ADR 0015 D4）：内容由平台 release 担保。
 * 所以保存配置时必须能回答「这个名字在当前 release 里吗」（`SKILL_SYSTEM_UNKNOWN`），
 * 起 Run 时也要与同一个集合求交、对已消失的名字写诊断。两处必须用**同一份**目录，
 * 否则会出现「保存时认得、起 Run 时不认得」。
 *
 * ## 读失败 ≠ 空目录
 *
 * 目录不存在（开发机上没挂载系统根）是**空集**；但读目录时抛出的 I/O 错误不能降级成
 * 「release 里没有系统包」——那会让配置面把合法名字判成未知、让 Run 把绑定悄悄清空。
 * 前者返回空列表，后者上抛。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { parseSkillFrontmatter } from './frontmatter.js';
import { SYSTEM_SKILL_ROOT } from './paths.js';

/** 配置面展示用的一个系统包。 */
export interface SystemSkillEntry {
  readonly name: string;
  readonly description: string;
}

/** 目录默认缓存时长：配置面每次请求都会问一次，但不该每次都扫盘。 */
export const SYSTEM_SKILL_CACHE_MS = 5_000;

/** `name` 目录与 SKILL.md 都缺失/不可读时，这个包不进目录。 */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export class SystemSkillCatalog {
  readonly root: string;
  private readonly cacheMs: number;
  private cached: readonly SystemSkillEntry[] | null = null;
  private cachedAt = 0;

  constructor(opts: { root?: string; cacheMs?: number } = {}) {
    this.root = opts.root ?? SYSTEM_SKILL_ROOT;
    this.cacheMs = opts.cacheMs ?? SYSTEM_SKILL_CACHE_MS;
  }

  /**
   * 当前 release 的系统包，按名字排序。
   *
   * 单个包坏掉（缺 SKILL.md、frontmatter 不可解析、name 非法）只是**不进目录**，
   * 不会让整份目录报错——一个坏包不该让配置面全部不可用。名字取目录名：与 DSH
   * loader 的发现规则一致（`<root>/<name>/SKILL.md`），frontmatter 的 `name` 只是描述。
   *
   * @param now 注入时钟，便于测试缓存行为
   */
  async list(now: number = Date.now()): Promise<readonly SystemSkillEntry[]> {
    if (this.cached !== null && now - this.cachedAt < this.cacheMs) return this.cached;
    const entries = await this.scan();
    this.cached = entries;
    this.cachedAt = now;
    return entries;
  }

  /** 只要名字集合（Run 解析求交用），不重复实现一遍扫描。 */
  async names(now: number = Date.now()): Promise<readonly string[]> {
    return (await this.list(now)).map((entry) => entry.name);
  }

  /** 丢弃缓存，下一次 `list()` 重新扫盘。 */
  invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  private async scan(): Promise<readonly SystemSkillEntry[]> {
    let dirents;
    try {
      dirents = await fsp.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      // 没挂载系统根（开发机、单测）就是没有系统包；其余 I/O 错误必须上抛。
      if (isAbsent(error)) return Object.freeze([]);
      throw error;
    }
    const out: SystemSkillEntry[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      const name = dirent.name;
      // 隐藏目录（`.v` 之类）不是包。
      if (name.startsWith('.')) continue;
      let content: string;
      try {
        content = await fsp.readFile(path.join(this.root, name, 'SKILL.md'), 'utf8');
      } catch (error) {
        if (isAbsent(error)) continue;
        throw error;
      }
      const parsed = parseSkillFrontmatter(content);
      // 非 strict：frontmatter 坏掉的包降级为「只有目录名」，仍在目录里——
      // 它确实存在于 release，配置面不该报「未知名字」。
      out.push(Object.freeze({
        name,
        description: parsed.description || parsed.name || '',
      }));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return Object.freeze(out);
  }
}
