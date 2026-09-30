/**
 * `AgentVersion.skillPolicy` 的词汇表与形状校验（ADR 0015 D1/D2，design §4.1）。
 *
 * ## 为什么放在 contract
 *
 * Skill 的「目录」有三层（system / org / user），而真正决定**这份字节挂不挂进
 * 沙箱**的是 exec。两侧必须对同一个字段名、同一组取值、同一条名字正则达成一致——
 * 不一致的形状错误只有在起 Run 时才会炸，而那时错误已经离「谁写坏了配置」很远。
 * 所以词汇表与**纯形状**校验放这里，两侧共用；「名字在不在当前 release / 账本里」
 * 这类**语义**校验在 Agent 侧（需要目录与账本，exec 不读 Agent 账本）。
 *
 * ## 缺省即当前行为
 *
 * 省略 `skillPolicy` 等价于 `{ system: { mode: 'all', names: [] }, org: [], user: 'allow' }`，
 * 也就是 ADR 0015 之前的行为。既有 AgentVersion 不迁移、`config_hash` 不变。
 */

import { ContractError } from './errors.js';
import { ENABLED_SKILLS_MAX, SKILL_DIGEST_PATTERN, SKILL_NAME_PATTERN } from './skill-manifest.js';

/** 系统层选法。 */
export type SkillSystemMode = 'all' | 'allowlist' | 'none';
/** 用户层开关。 */
export type SkillUserMode = 'allow' | 'deny';

export const SKILL_SYSTEM_MODES: readonly SkillSystemMode[] = Object.freeze([
  'all',
  'allowlist',
  'none',
]);
export const SKILL_USER_MODES: readonly SkillUserMode[] = Object.freeze(['allow', 'deny']);

/** 一层清单（system / org）各自的条数上限。 */
export const SKILL_POLICY_LAYER_MAX = 64;
/** 有效清单总条数上限：与清单契约 `ENABLED_SKILLS_MAX` 一致。 */
export const SKILL_POLICY_TOTAL_MAX = ENABLED_SKILLS_MAX;

/** `skillPolicy.system`。`names` 只在 `allowlist` 模式有意义。 */
export interface SkillSystemPolicy {
  readonly mode: SkillSystemMode;
  readonly names: readonly string[];
}

/** `skillPolicy.org[]` 的一项：**钉摘要**，不跟随最新（ADR 0015 D3）。 */
export interface SkillOrgBinding {
  readonly name: string;
  readonly contentDigest: string;
}

/** 解析后的 `skillPolicy`。 */
export interface SkillPolicy {
  readonly system: SkillSystemPolicy;
  readonly org: readonly SkillOrgBinding[];
  readonly user: SkillUserMode;
}

/** shape 校验的诊断。语义类错误码（`SKILL_SYSTEM_UNKNOWN` 等）由 Agent 侧追加。 */
export type SkillPolicyDiagnosticCode =
  | 'CONFIG_TYPE'
  | 'CONFIG_UNKNOWN_FIELD'
  | 'CONFIG_LIMIT'
  | 'SKILL_POLICY_TOO_LARGE';

export interface SkillPolicyDiagnostic {
  readonly path: string;
  readonly code: SkillPolicyDiagnosticCode;
  readonly message: string;
}

/** 形状校验结果：`policy` 为 `null` 表示有错，调用方必须拒绝而不是用部分结果。 */
export interface SkillPolicyParseResult {
  readonly policy: SkillPolicy | null;
  readonly errors: readonly SkillPolicyDiagnostic[];
}

/** 省略 `skillPolicy` 时的默认值（= ADR 0015 之前的行为）。 */
export function defaultSkillPolicy(): SkillPolicy {
  return Object.freeze({
    system: Object.freeze({ mode: 'all' as SkillSystemMode, names: Object.freeze([]) }),
    org: Object.freeze([]),
    user: 'allow' as SkillUserMode,
  });
}

function diag(
  path: string,
  code: SkillPolicyDiagnosticCode,
  message: string,
): SkillPolicyDiagnostic {
  return Object.freeze({ path, code, message });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `skillPolicy.system` 只接收这两个键。 */
const SYSTEM_KEYS: readonly string[] = Object.freeze(['mode', 'names']);
/** org 条目只接收这两个键——不允许内联描述等展示字段。 */
const ORG_ENTRY_KEYS: readonly string[] = Object.freeze(['name', 'contentDigest']);
/** `skillPolicy` 只接收这三个键。 */
const POLICY_KEYS: readonly string[] = Object.freeze(['system', 'org', 'user']);

/**
 * 纯形状校验 `skillPolicy`。**不读目录、不读账本**：
 * - `undefined` / `null` → 默认策略，无错；
 * - 未知键、类型不符、越界、重名 → 收集错误，`policy` 为 `null`；
 * - `SKILL_SYSTEM_UNKNOWN` / `SKILL_ORG_VERSION_UNKNOWN` 等**语义**错误码由调用方追加
 *   （它们需要 release 目录与 org 账本）。
 *
 * @param value 原始 `configJson.skillPolicy`
 */
export function parseSkillPolicy(value: unknown): SkillPolicyParseResult {
  if (value === undefined || value === null) {
    return Object.freeze({ policy: defaultSkillPolicy(), errors: Object.freeze([]) });
  }
  const errors: SkillPolicyDiagnostic[] = [];
  if (!isPlainObject(value)) {
    return Object.freeze({
      policy: null,
      errors: Object.freeze([
        diag('skillPolicy', 'CONFIG_TYPE', 'skillPolicy must be an object'),
      ]),
    });
  }

  for (const key of Object.keys(value)) {
    if (!POLICY_KEYS.includes(key)) {
      errors.push(diag(`skillPolicy.${key}`, 'CONFIG_UNKNOWN_FIELD', `Unknown configuration field "${key}"`));
    }
  }

  // ── system ────────────────────────────────────────────────────────────────
  const rawSystem = value['system'];
  let mode: SkillSystemMode = 'all';
  let names: string[] = [];
  if (rawSystem !== undefined) {
    if (!isPlainObject(rawSystem)) {
      errors.push(diag('skillPolicy.system', 'CONFIG_TYPE', 'skillPolicy.system must be an object'));
    } else {
      for (const key of Object.keys(rawSystem)) {
        if (!SYSTEM_KEYS.includes(key)) {
          errors.push(diag(
            `skillPolicy.system.${key}`,
            'CONFIG_UNKNOWN_FIELD',
            `Unknown configuration field "${key}"`,
          ));
        }
      }
      const rawMode = rawSystem['mode'];
      let modeOk = true;
      if (rawMode === undefined) {
        mode = 'all';
      } else if (typeof rawMode !== 'string' || !SKILL_SYSTEM_MODES.includes(rawMode as SkillSystemMode)) {
        modeOk = false;
        errors.push(diag(
          'skillPolicy.system.mode',
          'CONFIG_TYPE',
          `skillPolicy.system.mode must be one of ${SKILL_SYSTEM_MODES.join(' | ')}`,
        ));
      } else {
        mode = rawMode as SkillSystemMode;
      }
      const rawNames = rawSystem['names'];
      // names 自身已经出过错时不再追加「仅 allowlist 允许 / allowlist 必填」这类连带诊断：
      // 根因只有一个，报告要指向它，而不是把一条错误渲染成三条。
      let namesOk = true;
      if (rawNames === undefined) {
        names = [];
      } else if (!Array.isArray(rawNames)) {
        namesOk = false;
        errors.push(diag('skillPolicy.system.names', 'CONFIG_TYPE', 'skillPolicy.system.names must be an array'));
      } else if (rawNames.length > SKILL_POLICY_LAYER_MAX) {
        namesOk = false;
        errors.push(diag(
          'skillPolicy.system.names',
          'CONFIG_LIMIT',
          `skillPolicy.system.names must not exceed ${SKILL_POLICY_LAYER_MAX} entries`,
        ));
      } else {
        const seen = new Set<string>();
        rawNames.forEach((entry, index) => {
          if (typeof entry !== 'string' || !SKILL_NAME_PATTERN.test(entry)) {
            namesOk = false;
            errors.push(diag(
              `skillPolicy.system.names[${index}]`,
              'CONFIG_TYPE',
              'skillPolicy.system.names[] must be a valid skill name',
            ));
            return;
          }
          if (seen.has(entry)) {
            namesOk = false;
            errors.push(diag(
              `skillPolicy.system.names[${index}]`,
              'CONFIG_TYPE',
              `duplicate skill name "${entry}"`,
            ));
            return;
          }
          seen.add(entry);
          names.push(entry);
        });
      }
      // mode 或 names 本身坏掉时不再追加连带诊断——根因只有一个。
      if (modeOk && namesOk) {
        // `names` 只在 allowlist 下有意义。给出名字却选了 all/none 是「按了没生效」，
        // 属于必须诊断的静默失效，不做「静默忽略」。
        if (mode !== 'allowlist' && names.length > 0) {
          errors.push(diag(
            'skillPolicy.system.names',
            'CONFIG_TYPE',
            'skillPolicy.system.names is only allowed when mode is "allowlist"',
          ));
        }
        if (mode === 'allowlist' && (rawNames === undefined || names.length === 0)) {
          errors.push(diag(
            'skillPolicy.system.names',
            'CONFIG_TYPE',
            'skillPolicy.system.names is required and must not be empty when mode is "allowlist"',
          ));
        }
      }
    }
  }

  // ── org ───────────────────────────────────────────────────────────────────
  const rawOrg = value['org'];
  const org: SkillOrgBinding[] = [];
  if (rawOrg !== undefined) {
    if (!Array.isArray(rawOrg)) {
      errors.push(diag('skillPolicy.org', 'CONFIG_TYPE', 'skillPolicy.org must be an array'));
    } else if (rawOrg.length > SKILL_POLICY_LAYER_MAX) {
      errors.push(diag(
        'skillPolicy.org',
        'CONFIG_LIMIT',
        `skillPolicy.org must not exceed ${SKILL_POLICY_LAYER_MAX} entries`,
      ));
    } else {
      const seen = new Set<string>();
      rawOrg.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          errors.push(diag(`skillPolicy.org[${index}]`, 'CONFIG_TYPE', 'skillPolicy.org[] must be objects'));
          return;
        }
        for (const key of Object.keys(entry)) {
          if (!ORG_ENTRY_KEYS.includes(key)) {
            errors.push(diag(
              `skillPolicy.org[${index}].${key}`,
              'CONFIG_UNKNOWN_FIELD',
              `Unknown configuration field "${key}"`,
            ));
          }
        }
        const name = entry['name'];
        const digest = entry['contentDigest'];
        let ok = true;
        if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) {
          errors.push(diag(`skillPolicy.org[${index}].name`, 'CONFIG_TYPE', 'skillPolicy.org[].name is invalid'));
          ok = false;
        }
        if (typeof digest !== 'string' || !SKILL_DIGEST_PATTERN.test(digest)) {
          errors.push(diag(
            `skillPolicy.org[${index}].contentDigest`,
            'CONFIG_TYPE',
            'skillPolicy.org[].contentDigest must be a sha256 hex digest',
          ));
          ok = false;
        }
        if (!ok) return;
        const skillName = name as string;
        if (seen.has(skillName)) {
          errors.push(diag(`skillPolicy.org[${index}].name`, 'CONFIG_TYPE', `duplicate skill name "${skillName}"`));
          return;
        }
        seen.add(skillName);
        org.push(Object.freeze({ name: skillName, contentDigest: digest as string }));
      });
    }
  }

  // ── user ──────────────────────────────────────────────────────────────────
  const rawUser = value['user'];
  let user: SkillUserMode = 'allow';
  if (rawUser !== undefined) {
    if (typeof rawUser !== 'string' || !SKILL_USER_MODES.includes(rawUser as SkillUserMode)) {
      errors.push(diag(
        'skillPolicy.user',
        'CONFIG_TYPE',
        `skillPolicy.user must be one of ${SKILL_USER_MODES.join(' | ')}`,
      ));
    } else {
      user = rawUser as SkillUserMode;
    }
  }

  // ── 跨层与总量 ────────────────────────────────────────────────────────────
  // system 选中名与 org 名重复：org 发布时已禁止（`assertDoesNotShadowSystem`），
  // 这里防的是历史数据。名字在一个 Run 内必须唯一（ADR 0015 D7）。
  if (mode === 'allowlist') {
    const systemNames = new Set(names);
    org.forEach((entry, index) => {
      if (systemNames.has(entry.name)) {
        errors.push(diag(
          `skillPolicy.org[${index}].name`,
          'CONFIG_TYPE',
          `"${entry.name}" is already selected by skillPolicy.system; a skill name must be unique within one Run`,
        ));
      }
    });
  }

  // `all` 模式的实际条数取决于 release，这里只能判「已知条数」的那部分；
  // 展开后的总量由调用方用 `skillPolicyTooLarge()` 在拿到 release 名单后再判一次。
  const knownTotal = (mode === 'allowlist' ? names.length : 0) + org.length;
  if (knownTotal > SKILL_POLICY_TOTAL_MAX) {
    errors.push(diag(
      'skillPolicy',
      'SKILL_POLICY_TOO_LARGE',
      `skillPolicy selects ${knownTotal} skills, exceeding the limit of ${SKILL_POLICY_TOTAL_MAX}`,
    ));
  }

  if (errors.length > 0) return Object.freeze({ policy: null, errors: Object.freeze(errors) });
  return Object.freeze({
    policy: Object.freeze({
      system: Object.freeze({ mode, names: Object.freeze([...names]) }),
      org: Object.freeze([...org]),
      user,
    }),
    errors: Object.freeze([]),
  });
}

/** 形状错误的对外错误（内部面请求体里出现坏 `skillPolicy` 时用）。 */
export function skillPolicyError(message: string): ContractError {
  return new ContractError('ENVELOPE_INVALID', message);
}

/**
 * 有效清单总量校验（design §4.1 末条，上限与 `ENABLED_SKILLS_MAX` 一致）。
 *
 * 为什么单独成一个函数：**形状校验阶段算不出总量**。`system.mode: all` 的条数取决于
 * 部署的 release 目录，只有 Agent 侧拿到系统包名集合之后才知道。反过来，纯形状阶段
 * 能算出的上界是 `2 × SKILL_POLICY_LAYER_MAX = 128`，永远够不到 256——所以总量这条
 * 不可能只在 `parseSkillPolicy` 里守住，必须由「拿到展开后名单」的调用方再判一次。
 *
 * 两侧共用这一个判定，避免「保存时按一套规则、起 Run 时按另一套」。
 *
 * @param counts 每一层的**展开后**条数（system / org / user）
 * @returns 超限时返回诊断，否则 `null`
 */
export function skillPolicyTooLarge(
  counts: { readonly system: number; readonly org: number; readonly user?: number },
): SkillPolicyDiagnostic | null {
  const total = counts.system + counts.org + (counts.user ?? 0);
  if (total <= SKILL_POLICY_TOTAL_MAX) return null;
  return diag(
    'skillPolicy',
    'SKILL_POLICY_TOO_LARGE',
    `skillPolicy selects ${total} skills, exceeding the limit of ${SKILL_POLICY_TOTAL_MAX}`,
  );
}
