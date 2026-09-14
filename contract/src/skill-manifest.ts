/**
 * 已启用用户 Skill 的清单与版本目录规则（design §3.3 S1）。
 *
 * 启用权威在 Agent 的 `user_skill_enablements`。Agent 在 Run 开始时按账本得到
 * `[{ name, contentDigest }]`，随每个内部请求交给 exec；exec 只挂载清单点名、且版本
 * 目录与侧车文件核对通过的包——不读 Agent 账本，也不再扫 owner 目录。
 *
 * 清单跟随请求体（POST）或规范化 query（GET）进入 `body_sha256`，与信封一样受 HMAC
 * 覆盖，这就是「由 Agent 鉴权输出的清单」。
 *
 * 发布布局（每个 owner 一个根 `<base>/<orgId>/<userId>`）：
 *
 *   <name>/.v/<digest>/<name>/SKILL.md   版本目录：内层再套一层包名，
 *                                         使 `.v/<digest>` 本身是只含一个包的发现根
 *   <name>/.v/<digest>.json               侧车：写在版本目录之后，缺它即视为未发布完成
 *
 * 同一包名的不同摘要互不覆盖，运行中的 Run 继续使用它清单里的那一版。
 */

import { ContractError } from './errors.js';

/** 清单中的一项。 */
export interface EnabledSkillRef {
  readonly name: string;
  readonly contentDigest: string;
}

/** 与 agent `SKILL_NAME_RE` 同一条规则：小写开头，不含 `.`，因此 `.v` 不会与包名冲突。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** 内容摘要：sha256 hex。 */
export const SKILL_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
/** 单个请求可携带的清单条数上限，防止用超长清单放大 exec 的核对开销。 */
export const ENABLED_SKILLS_MAX = 256;
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
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
      throw invalid('enabledSkills[].name is invalid');
    }
    if (typeof contentDigest !== 'string' || !SKILL_DIGEST_PATTERN.test(contentDigest)) {
      throw invalid('enabledSkills[].contentDigest must be a sha256 hex digest');
    }
    if (seen.has(name)) throw invalid('enabledSkills must not repeat a name');
    seen.add(name);
    out.push(Object.freeze({ name, contentDigest }));
  }
  return Object.freeze(out);
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
