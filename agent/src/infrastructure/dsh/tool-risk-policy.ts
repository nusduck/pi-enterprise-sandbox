/**
 * Operator-configurable tool risk levels (plan §14.2 extension).
 *
 * The classifier decides *what kind* of tool this is; this module decides
 * *how risky* it is and what that risk costs. Risk is the single input to the
 * approval decision, so an operator changes approval behaviour by editing risk
 * levels, never by hand-editing decision constants.
 *
 * Two layers exist, in the same "lower layers may only tighten" direction as
 * the rest of the policy stack:
 *
 *   platform (config/agent/tool-risk.json or TOOL_RISK_POLICY_JSON)
 *     > agentVersion (configJson.toolPolicy + configJson.mcpServers[].toolPolicy)
 *
 * An AgentVersion may raise a tool's risk and may tighten what a risk level
 * costs. It can never lower either — an org cannot opt out of a platform
 * approval gate by shipping a new agent version.
 */

import { DECISION_RANK, RISK_LEVELS, RISK_RANK } from './policy-decision.js';
import {
  ASK_USER_TOOL_NAME,
  SANDBOX_TOOL_NAMES,
  isRetiredToolName,
} from './constants.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** Classification classes the risk table can address. */
export const RISK_CLASSES = Object.freeze([
  'internal_interaction',
  'local_low',
  'external_readonly',
  'external_high',
]);

/**
 * Built-in risk baseline per classification class. Chosen so the default
 * configuration reproduces the pre-configuration behaviour exactly.
 * `unknown` is deliberately absent: unknown tools are denied by the engine
 * before risk resolution and must not become configurable.
 */
export const DEFAULT_CLASS_RISK_LEVELS = Object.freeze({
  internal_interaction: 'low',
  local_low: 'low',
  external_readonly: 'medium',
  external_high: 'high',
});

/** Built-in risk → decision mapping. */
export const DEFAULT_RISK_APPROVAL = Object.freeze({
  low: 'allow',
  medium: 'allow',
  high: 'require_approval',
  critical: 'deny',
});

const DECISIONS = Object.freeze(['allow', 'require_approval', 'deny']);

export class ToolRiskPolicyError extends Error {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  code: Loose;

  constructor(message: string, opts: { code?: string } = {}) {
    super(message);
    this.name = 'ToolRiskPolicyError';
    this.code = opts.code ?? 'TOOL_RISK_POLICY_INVALID';
  }
}

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type RiskDecision = 'allow' | 'require_approval' | 'deny';

export type ToolRiskPolicy = {
  riskApproval: Readonly<Record<RiskLevel, RiskDecision>>;
  classRiskLevels: Readonly<Record<string, RiskLevel>>;
  tools: Readonly<Record<string, RiskLevel>>;
  toolPatterns: ReadonlyArray<{ prefix: string, riskLevel: RiskLevel }>;
  mcpServers: Readonly<Record<string, { riskLevel: RiskLevel | null, tools: Readonly<Record<string, RiskLevel>>, }>>;
};

/**
 * @param value
 * @param field
 * @returns {RiskLevel}
 */
function assertRiskLevel(value: unknown, field: string) {
  const level = String(value ?? '').trim().toLowerCase();
  if (!RISK_LEVELS.includes((level as any))) {
    throw new ToolRiskPolicyError(
      `${field} must be one of ${RISK_LEVELS.join('|')} (got ${JSON.stringify(value)})`,
      { code: 'TOOL_RISK_LEVEL_INVALID' },
    );
  }
  return (level as RiskLevel);
}

/**
 * @param value
 * @param field
 * @returns {RiskDecision}
 */
function assertDecision(value: unknown, field: string) {
  const decision = String(value ?? '').trim().toLowerCase();
  if (!DECISIONS.includes((decision as any))) {
    throw new ToolRiskPolicyError(
      `${field} must be one of ${DECISIONS.join('|')} (got ${JSON.stringify(value)})`,
      { code: 'TOOL_RISK_DECISION_INVALID' },
    );
  }
  return (decision as RiskDecision);
}

/**
 * A risk entry is either a bare level (`"high"`) or an object carrying one
 * (`{ riskLevel: "high" }`), so the same table can gain fields later without
 * breaking existing config files.
 *
 * @param entry
 * @param field
 * @returns {RiskLevel}
 */
function readRiskEntry(entry: unknown, field: string) {
  if (entry != null && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = (entry as Record<string, unknown>);
    const raw = obj.riskLevel ?? obj.risk_level ?? obj.risk;
    if (raw == null) {
      throw new ToolRiskPolicyError(`${field} must carry riskLevel`, {
        code: 'TOOL_RISK_LEVEL_INVALID',
      });
    }
    return assertRiskLevel(raw, `${field}.riskLevel`);
  }
  return assertRiskLevel(entry, field);
}

/**
 * @param value
 * @param field
 * @returns {Record<string, unknown>}
 */
function assertObject(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolRiskPolicyError(`${field} must be an object`, {
      code: 'TOOL_RISK_POLICY_SHAPE',
    });
  }
  return (value as Record<string, unknown>);
}

/**
 * Tool keys accept the projected tool name (`read`, `mcp__github__create_pr`),
 * the `server::tool` form, or a trailing-`*` prefix pattern.
 * @param key
 */
/**
 * 平台层的工具名断言（ADR 0009 D4 / 计划 H1.5）。
 *
 * 放过三类 key：`mcp__*` 前缀式（MCP 工具名由服务端决定，且出厂包会对超长/非法名
 * 做规范化并追加哈希，只能靠前缀兜底）、`server::tool` 形式、以及退役名
 * （退役是显式决定，理由码稳定，不算拼写错误）。其余必须命中事实源。
 */
function assertKnownToolName(key: string, field: string): void {
  if (key.endsWith('*')) return;
  if (key.startsWith('mcp__') || key.includes('::')) return;
  if (SANDBOX_TOOL_NAMES.includes(key) || key === ASK_USER_TOOL_NAME) return;
  if (isRetiredToolName(key)) return;
  throw new ToolRiskPolicyError(
    `${field}: "${key}" is not a known tool name. The single source is ` +
      `src/runtime/policy/tool-names.ts (SANDBOX_TOOL_NAMES). A key that names no ` +
      `registered tool is dead config: the classifier is fail-closed, so the tool it ` +
      `meant to cover would be denied at runtime with nobody reporting it.`,
    { code: 'TOOL_RISK_POLICY_UNKNOWN_TOOL' },
  );
}

function normalizeToolKey(key: string) {
  const raw = String(key ?? '').trim();
  if (!raw) {
    throw new ToolRiskPolicyError('tool risk key must be a non-empty string', {
      code: 'TOOL_RISK_POLICY_SHAPE',
    });
  }
  if (!/^[A-Za-z0-9._:*-]+$/.test(raw)) {
    throw new ToolRiskPolicyError(
      `tool risk key "${raw}" may only contain [A-Za-z0-9._:-] with an optional trailing *`,
      { code: 'TOOL_RISK_POLICY_SHAPE' },
    );
  }
  const starCount = (raw.match(/\*/g) || []).length;
  if (starCount > 1 || (starCount === 1 && !raw.endsWith('*'))) {
    throw new ToolRiskPolicyError(
      `tool risk key "${raw}" may only use a single trailing * wildcard`,
      { code: 'TOOL_RISK_POLICY_SHAPE' },
    );
  }
  return raw;
}

/** Empty policy: built-in defaults only. */
export function defaultToolRiskPolicy() {
  return Object.freeze({
    riskApproval: Object.freeze({ ...DEFAULT_RISK_APPROVAL }),
    classRiskLevels: Object.freeze({ ...DEFAULT_CLASS_RISK_LEVELS }),
    tools: Object.freeze({}),
    toolPatterns: Object.freeze([]),
    mcpServers: Object.freeze({}),
  });
}

/**
 * Parse and validate one risk policy layer. Unknown keys are rejected so a
 * typo in an operator config file fails at startup instead of silently
 * leaving a tool at its default risk.
 *
 * @param raw
 * @param [opts]
 * @returns {ToolRiskPolicy}
 */
export function loadToolRiskPolicy(
  raw: unknown,
  opts: { field?: string; assertKnownNames?: boolean } = {},
) {
  const field = opts.field || 'toolRiskPolicy';
  if (raw == null) return defaultToolRiskPolicy();

  let parsed = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return defaultToolRiskPolicy();
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new ToolRiskPolicyError(
        `${field} contains invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        { code: 'TOOL_RISK_POLICY_SHAPE' },
      );
    }
  }

  const obj = assertObject(parsed, field);
  const known = new Set([
    'riskApproval',
    'classRiskLevels',
    'tools',
    'mcpServers',
  ]);
  for (const key of Object.keys(obj)) {
    // `_`-prefixed keys are comments: this file is meant to be hand-edited.
    if (key.startsWith('_')) continue;
    if (!known.has(key)) {
      throw new ToolRiskPolicyError(
        `${field}.${key} is not a recognized field (expected ${[...known].join(', ')})`,
        { code: 'TOOL_RISK_POLICY_SHAPE' },
      );
    }
  }

  const riskApproval: Record<string, RiskDecision> = { ...DEFAULT_RISK_APPROVAL };
  if (obj.riskApproval != null) {
    const table = assertObject(obj.riskApproval, `${field}.riskApproval`);
    for (const [level, decision] of Object.entries(table)) {
      const normalized = assertRiskLevel(level, `${field}.riskApproval key`);
      riskApproval[normalized] = assertDecision(
        decision,
        `${field}.riskApproval.${level}`,
      );
    }
  }

  const classRiskLevels: Record<string, RiskLevel> = { ...DEFAULT_CLASS_RISK_LEVELS };
  if (obj.classRiskLevels != null) {
    const table = assertObject(obj.classRiskLevels, `${field}.classRiskLevels`);
    for (const [cls, level] of Object.entries(table)) {
      if (!RISK_CLASSES.includes((cls as any))) {
        throw new ToolRiskPolicyError(
          `${field}.classRiskLevels.${cls} is not a tool class (expected ${RISK_CLASSES.join(', ')})`,
          { code: 'TOOL_RISK_POLICY_SHAPE' },
        );
      }
      classRiskLevels[cls] = readRiskEntry(level, `${field}.classRiskLevels.${cls}`);
    }
  }

  const tools: Record<string, RiskLevel> = {};
  const toolPatterns: Array<{ prefix: string, riskLevel: RiskLevel }> = [];
  if (obj.tools != null) {
    const table = assertObject(obj.tools, `${field}.tools`);
    for (const [key, entry] of Object.entries(table)) {
      if (key.startsWith('_')) continue; // inline comment
      const normalized = normalizeToolKey(key);
      // ADR 0009 D4：这张表的 key 就是工具名，而分类器是 fail-closed 的
      // （未知工具 → deny）。所以一个拼错的 key、或者一个 2026-08-31 改名之后
      // 忘了同步的旧名，表现出来是「那个工具在运行时整片被拒」，而且**没有人报错**。
      // 平台层因此 fail-fast：key 必须在 tool-names.ts 的唯一事实源里。
      // 租户层（AgentVersion.toolPolicy）不开这个断言——存量 configJson 是冻结的
      // 不可变快照，旧名由 resolveToolNameAlias() 在读取时投影。
      if (opts.assertKnownNames === true) assertKnownToolName(normalized, `${field}.tools.${key}`);
      const riskLevel = readRiskEntry(entry, `${field}.tools.${key}`);
      if (normalized.endsWith('*')) {
        toolPatterns.push({ prefix: normalized.slice(0, -1), riskLevel });
      } else {
        tools[normalized] = riskLevel;
      }
    }
  }
  // Longest prefix wins, so `mcp__github__delete_*` beats `mcp__github__*`.
  toolPatterns.sort((a, b) => b.prefix.length - a.prefix.length);

  const mcpServers: Record<string, { riskLevel: RiskLevel | null, tools: Record<string, RiskLevel> }> = {};
  if (obj.mcpServers != null) {
    const table = assertObject(obj.mcpServers, `${field}.mcpServers`);
    for (const [serverId, entry] of Object.entries(table)) {
      if (serverId.startsWith('_')) continue; // inline comment
      const id = String(serverId).trim();
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new ToolRiskPolicyError(
          `${field}.mcpServers key "${serverId}" must match [A-Za-z0-9._-]+`,
          { code: 'TOOL_RISK_POLICY_SHAPE' },
        );
      }
      // Bare level shorthand: { "github": "high" }
      if (typeof entry === 'string') {
        mcpServers[id] = {
          riskLevel: assertRiskLevel(entry, `${field}.mcpServers.${id}`),
          tools: {},
        };
        continue;
      }
      const server = assertObject(entry, `${field}.mcpServers.${id}`);
      const rawLevel = server.riskLevel ?? server.risk_level ?? null;
      const serverTools: Record<string, RiskLevel> = {};
      const rawTools = server.tools ?? server.toolRiskLevels ?? null;
      if (rawTools != null) {
        const toolTable = assertObject(rawTools, `${field}.mcpServers.${id}.tools`);
        for (const [toolName, level] of Object.entries(toolTable)) {
          const bare = String(toolName).trim();
          if (!/^[A-Za-z0-9._-]+$/.test(bare)) {
            throw new ToolRiskPolicyError(
              `${field}.mcpServers.${id}.tools key "${toolName}" must be a bare tool name`,
              { code: 'TOOL_RISK_POLICY_SHAPE' },
            );
          }
          serverTools[bare] = readRiskEntry(
            level,
            `${field}.mcpServers.${id}.tools.${bare}`,
          );
        }
      }
      mcpServers[id] = {
        riskLevel:
          rawLevel == null
            ? null
            : assertRiskLevel(rawLevel, `${field}.mcpServers.${id}.riskLevel`),
        tools: serverTools,
      };
    }
  }

  return Object.freeze({
    riskApproval: Object.freeze(riskApproval),
    classRiskLevels: Object.freeze(classRiskLevels),
    tools: Object.freeze(tools),
    toolPatterns: Object.freeze(toolPatterns.map((p) => Object.freeze({ ...p }))),
    mcpServers: Object.freeze(
      Object.fromEntries(
        Object.entries(mcpServers).map(([id, server]) => [
          id,
          Object.freeze({
            riskLevel: server.riskLevel,
            tools: Object.freeze({ ...server.tools }),
          }),
        ]),
      ),
    ),
  });
}

/**
 * @param a
 * @param b
 * @returns {RiskLevel | null}
 */
function maxRisk(a: RiskLevel | null | undefined, b: RiskLevel | null | undefined) {
  if (!a) return b ?? null;
  if (!b) return a;
  return RISK_RANK[b] > RISK_RANK[a] ? b : a;
}

function strictestDecision(a: RiskDecision, b: RiskDecision) {
  return DECISION_RANK[b] > DECISION_RANK[a] ? b : a;
}

/**
 * Merge an override layer onto a base layer. The override may only tighten:
 * risk levels take the maximum, decisions take the stricter of the two.
 *
 * @param base
 * @param override
 * @returns {ToolRiskPolicy}
 */
export function mergeToolRiskPolicies(base: ToolRiskPolicy, override: ToolRiskPolicy | null | undefined) {
  if (!override) return base;

  const riskApproval: Record<string, RiskDecision> = { ...base.riskApproval };
  for (const level of RISK_LEVELS) {
    riskApproval[level] = strictestDecision(
      base.riskApproval[level],
      override.riskApproval[level],
    );
  }

  const classRiskLevels: Record<string, RiskLevel> = { ...base.classRiskLevels };
  for (const cls of RISK_CLASSES) {
    const merged = maxRisk(base.classRiskLevels[cls], override.classRiskLevels[cls]);
    if (merged) classRiskLevels[cls] = merged;
  }

  const tools: Record<string, RiskLevel> = { ...base.tools };
  for (const [name, level] of Object.entries(override.tools)) {
    const merged = maxRisk(tools[name], level);
    if (merged) tools[name] = merged;
  }

  const patterns: Map<string, RiskLevel> = new Map();
  for (const { prefix, riskLevel } of [...base.toolPatterns, ...override.toolPatterns]) {
    const merged = maxRisk(patterns.get(prefix), riskLevel);
    if (merged) patterns.set(prefix, merged);
  }

  const mcpServers: Record<string, { riskLevel: RiskLevel | null, tools: Record<string, RiskLevel> }> = {};
  for (const id of new Set([
    ...Object.keys(base.mcpServers),
    ...Object.keys(override.mcpServers),
  ])) {
    const b = base.mcpServers[id];
    const o = override.mcpServers[id];
    const serverTools: Record<string, RiskLevel> = { ...(b?.tools || {}) };
    for (const [tool, level] of Object.entries(o?.tools || {})) {
      const merged = maxRisk(serverTools[tool], level);
      if (merged) serverTools[tool] = merged;
    }
    mcpServers[id] = {
      riskLevel: maxRisk(b?.riskLevel, o?.riskLevel),
      tools: serverTools,
    };
  }

  return Object.freeze({
    riskApproval: Object.freeze(riskApproval),
    classRiskLevels: Object.freeze(classRiskLevels),
    tools: Object.freeze(tools),
    toolPatterns: Object.freeze(
      [...patterns.entries()]
        .map(([prefix, riskLevel]) => Object.freeze({ prefix, riskLevel }))
        .sort((a, b) => b.prefix.length - a.prefix.length),
    ),
    mcpServers: Object.freeze(
      Object.fromEntries(
        Object.entries(mcpServers).map(([id, server]) => [
          id,
          Object.freeze({
            riskLevel: server.riskLevel,
            tools: Object.freeze(server.tools),
          }),
        ]),
      ),
    ),
  });
}

/**
 * Resolve the effective risk level for one tool call, most specific first:
 *
 *   1. exact tool name              `mcp__github__create_pr`, `bash_run`
 *   2. `server::tool`               `github::create_pr`
 *   3. trailing-* pattern           `mcp__github__*`, `process_*`
 *   4. per-server tool table        mcpServers.github.tools.create_pr
 *   5. per-server default           mcpServers.github.riskLevel
 *   6. classification baseline      classRiskLevels.external_high
 *
 * @param toolName
 * @param cls
 * @param policy
 * @returns {{ riskLevel: RiskLevel, source: string, configured: boolean }}
 */
export function resolveToolRiskLevel(toolName: string, cls: { class?: string, serverId?: string, tool?: string }, policy: ToolRiskPolicy) {
  const name = String(toolName || '');
  const serverId = cls?.serverId ? String(cls.serverId) : null;
  const bareTool = cls?.tool ? String(cls.tool) : null;

  const exact = policy.tools[name];
  if (exact) {
    return { riskLevel: exact, source: `tool:${name}`, configured: true };
  }

  if (serverId && bareTool) {
    const scoped = policy.tools[`${serverId}::${bareTool}`];
    if (scoped) {
      return {
        riskLevel: scoped,
        source: `tool:${serverId}::${bareTool}`,
        configured: true,
      };
    }
  }

  for (const { prefix, riskLevel } of policy.toolPatterns) {
    if (name.startsWith(prefix)) {
      return { riskLevel, source: `pattern:${prefix}*`, configured: true };
    }
  }

  if (serverId) {
    const server = policy.mcpServers[serverId];
    if (server) {
      if (bareTool && server.tools[bareTool]) {
        return {
          riskLevel: server.tools[bareTool],
          source: `mcpServer:${serverId}.tools.${bareTool}`,
          configured: true,
        };
      }
      if (server.riskLevel) {
        return {
          riskLevel: server.riskLevel,
          source: `mcpServer:${serverId}`,
          configured: true,
        };
      }
    }
  }

  const className = String(cls?.class || '');
  const classLevel =
    policy.classRiskLevels[className] ??
    DEFAULT_CLASS_RISK_LEVELS[(className as keyof typeof DEFAULT_CLASS_RISK_LEVELS)] ??
    'critical';
  return {
    riskLevel: (classLevel as RiskLevel),
    source: `class:${className || 'unknown'}`,
    configured:
      classLevel !==
      DEFAULT_CLASS_RISK_LEVELS[
        (className as keyof typeof DEFAULT_CLASS_RISK_LEVELS)
      ],
  };
}

/**
 * @param riskLevel
 * @param policy
 * @returns {RiskDecision}
 */
export function decisionForRiskLevel(riskLevel: RiskLevel, policy: ToolRiskPolicy) {
  return policy.riskApproval[riskLevel] ?? DEFAULT_RISK_APPROVAL[riskLevel] ?? 'deny';
}

/**
 * Accept an already-normalized policy or raw config and return a policy.
 * @param value
 * @param [opts]
 * @returns {ToolRiskPolicy}
 */
export function coerceToolRiskPolicy(value: unknown, opts: { field?: string } = {}) {
  if (!value) return defaultToolRiskPolicy();
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'riskApproval' in value &&
    'toolPatterns' in value
  ) {
    return (value as ToolRiskPolicy);
  }
  return loadToolRiskPolicy(value, opts);
}
