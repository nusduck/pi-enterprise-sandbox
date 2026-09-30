/**
 * 已启用 Skill 的清单与版本目录规则（design §3.3 S1；三层见 ADR 0015 D1）。
 *
 * 启用权威在 Agent 的 `user_skill_enablements`。Agent 在 Run 开始时按账本与**绑定**
 * 得到一份有效清单，随每个内部请求交给 exec；exec 只挂载清单点名、且版本目录与侧车
 * 文件核对通过的包——不读 Agent 账本，也不再扫 owner 目录。
 *
 * 清单跟随请求体（POST）或规范化 query（GET）进入 `body_sha256`，与信封一样受 HMAC
 * 覆盖，这就是「由 Agent 鉴权输出的清单」。
 *
 * 发布布局（每个 owner 一个根 `<base>/<orgId>/<userId>`，org 层是 `<orgId>/_org`）：
 *
 *   <name>/.v/<digest>/<name>/SKILL.md   版本目录：内层再套一层包名，
 *                                         使 `.v/<digest>` 本身是只含一个包的发现根
 *   <name>/.v/<digest>.json               侧车：写在版本目录之后，缺它即视为未发布完成
 *
 * 同一包名的不同摘要互不覆盖，运行中的 Run 继续使用它清单里的那一版。
 */

import { ContractError } from './errors.js';

/** 清单里一项的层。缺省 `user`：旧 Agent 发出的清单语义不变（ADR 0015 D1）。 */
export type EnabledSkillScope = 'user' | 'org';

/** 清单中的一项。 */
export interface EnabledSkillRef {
  readonly name: string;
  readonly contentDigest: string;
  /** `org` 走 `<orgId>/_org` owner 根；省略 = `user`。 */
  readonly scope?: EnabledSkillScope;
}

/** 与 agent `SKILL_NAME_RE` 同一条规则：小写开头，不含 `.`，因此 `.v` 不会与包名冲突。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 内容摘要：sha256 hex。 */
export const SKILL_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
/** 单个请求可携带的清单条数上限，防止用超长清单放大 exec 的核对开销。 */
export const ENABLED_SKILLS_MAX = 256;
/** 系统层清单（`systemSkills`）的条数上限。 */
export const SYSTEM_SKILLS_MAX = 256;
/** 版本目录所在的子目录名。 */
export const SKILL_VERSIONS_DIRNAME = '.v';

function invalid(message: string): ContractError {
  return new ContractError('ENVELOPE_INVALID', message);
}

/**
 * 运行时校验清单。缺省（`undefined` / `null`）等价于空清单；其余任何形状错误都抛
 * `ENVELOPE_INVALID`，不做「跳过坏条目」的宽松处理。
 */
export function parseEnabledSkills(value: unknown): readonly EnabledSkillRef[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw invalid('enabledSkills must be an array');
  if (value.length > ENABLED_SKILLS_MAX) {
    throw invalid(`enabledSkills must not exceed ${ENABLED_SKILLS_MAX} entries`);
  }
  const seen = new Set<string>();
  const out: EnabledSkillRef[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalid('enabledSkills entries must be objects');
    }
    const record = item as Record<string, unknown>;
    const name = record['name'];
    const contentDigest = record['contentDigest'];
    const scope = record['scope'];
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
      throw invalid('enabledSkills[].name is invalid');
    }
    if (typeof contentDigest !== 'string' || !SKILL_DIGEST_PATTERN.test(contentDigest)) {
      throw invalid('enabledSkills[].contentDigest must be a sha256 hex digest');
    }
    // 省略 = `user`。未知取值是错误而不是「当作 user」：写错 scope 会让包挂到错的
    // owner 根下，而 exec 只会静默找不到它。
    if (scope !== undefined && scope !== 'user' && scope !== 'org') {
      throw invalid('enabledSkills[].scope must be "user" or "org"');
    }
    if (seen.has(name)) throw invalid('enabledSkills must not repeat a name');
    seen.add(name);
    out.push(Object.freeze(
      scope === 'org'
        ? { name, contentDigest, scope: 'org' as const }
        : { name, contentDigest },
    ));
  }
  return Object.freeze(out);
}

/**
 * 运行时校验系统层清单（`systemSkills`，ADR 0015 D4 / design §6.3、§8）。
 *
 * **滚动升级兼容期**（design §8）：缺省（`undefined` / `null`）返回 `null`，表示
 * 「这是一个还不会发名单的旧 Agent」，exec 按旧行为整树挂载系统根并记告警。
 * 部署顺序是 exec → Worker → API：exec 先升级时，旧 Worker 的 Run 不能因此全部失败。
 * 全部 Worker 升级、告警计数为 0 之后，才把缺省改成 `ENVELOPE_INVALID`（收紧）。
 *
 * **空数组是合法值**，表示「这个 Run 一个系统包都不带」——它与「没带这个字段」
 * 是两件事，调用方必须区分 `null` 与 `[]`。
 *
 * @returns 规范化后的名字数组（可能为空）；字段缺省时为 `null`
 */
export function parseSystemSkills(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw invalid('systemSkills must be an array');
  if (value.length > SYSTEM_SKILLS_MAX) {
    throw invalid(`systemSkills must not exceed ${SYSTEM_SKILLS_MAX} entries`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !SKILL_NAME_PATTERN.test(entry)) {
      throw invalid('systemSkills[] must be a valid skill name');
    }
    if (seen.has(entry)) throw invalid('systemSkills must not repeat a name');
    seen.add(entry);
  }
  return Object.freeze([...value] as string[]);
}

/**
 * 同一名字不能同时出现在 `systemSkills` 与 `enabledSkills` 里。
 *
 * Agent 侧的有效清单已经按 system > org > user 去过重（ADR 0015 D7），所以同时出现
 * 只可能是调用方拼错了请求——不能静默按某个顺序取胜者。
 */
export function assertNoDuplicateSkillScopes(
  systemSkills: readonly string[] | null,
  enabledSkills: readonly EnabledSkillRef[],
): void {
  if (systemSkills === null || systemSkills.length === 0) return;
  const system = new Set(systemSkills);
  for (const entry of enabledSkills) {
    if (system.has(entry.name)) {
      throw invalid(
        `skill "${entry.name}" appears in both systemSkills and enabledSkills`,
      );
    }
  }
}

/**
 * GET 请求参与签名的字节：按键排序的 `key=value`（均 `encodeURIComponent`）以 `&` 连接。
 *
 * GET 没有请求体，此前 `body_sha256` 是空串摘要，query 里的信封与目标都不受签名覆盖。
 * 签发侧与验签侧用同一个函数，参数顺序不影响结果，任一值变化都会改变摘要。
 */
export function canonicalQueryBytes(params: Readonly<Record<string, string>>): Uint8Array {
  const text = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
  return new TextEncoder().encode(text);
}

/** 一个已发布版本的三处路径。 */
export interface SkillVersionPaths {
  /** `.v/<digest>`：只含一个包的发现根。 */
  readonly versionRoot: string;
  /** 真正的包目录，挂载源。 */
  readonly packageDir: string;
  /** 侧车文件。 */
  readonly sidecar: string;
}

/** 按 owner 根、包名与摘要算出版本路径；名字或摘要不合法直接抛，不拼可能穿越的路径。 */
export function skillVersionPaths(
  ownerRoot: string,
  name: string,
  contentDigest: string,
): SkillVersionPaths {
  if (!SKILL_NAME_PATTERN.test(name)) throw invalid('skill name is invalid');
  if (!SKILL_DIGEST_PATTERN.test(contentDigest)) throw invalid('skill digest is invalid');
  const versions = `${ownerRoot.replace(/\/+$/, '')}/${name}/${SKILL_VERSIONS_DIRNAME}`;
  return {
    versionRoot: `${versions}/${contentDigest}`,
    packageDir: `${versions}/${contentDigest}/${name}`,
    sidecar: `${versions}/${contentDigest}.json`,
  };
}

/** 侧车内容。 */
export interface SkillVersionSidecar {
  readonly name: string;
  readonly contentDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** ISO-8601 发布时间，回收宽限期以它为准。 */
  readonly publishedAt: string;
}

/** 解析侧车；任何字段缺失或类型不对都返回 `null`（由调用方按「未发布完成」处理）。 */
export function parseSkillVersionSidecar(text: string): SkillVersionSidecar | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { name, contentDigest, fileCount, totalBytes, publishedAt } = record;
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) return null;
  if (typeof contentDigest !== 'string' || !SKILL_DIGEST_PATTERN.test(contentDigest)) return null;
  if (!Number.isSafeInteger(fileCount) || (fileCount as number) < 0) return null;
  if (!Number.isSafeInteger(totalBytes) || (totalBytes as number) < 0) return null;
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) return null;
  return {
    name,
    contentDigest,
    fileCount: fileCount as number,
    totalBytes: totalBytes as number,
    publishedAt,
  };
}
