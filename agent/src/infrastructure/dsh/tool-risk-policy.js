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
  /**
   * @param {string} message
   * @param {{ code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'ToolRiskPolicyError';
    this.code = opts.code ?? 'TOOL_RISK_POLICY_INVALID';
  }
}

/**
 * @typedef {'low' | 'medium' | 'high' | 'critical'} RiskLevel
 * @typedef {'allow' | 'require_approval' | 'deny'} RiskDecision
 *
 * @typedef {{
 *   riskApproval: Readonly<Record<RiskLevel, RiskDecision>>,
 *   classRiskLevels: Readonly<Record<string, RiskLevel>>,
 *   tools: Readonly<Record<string, RiskLevel>>,
 *   toolPatterns: ReadonlyArray<{ prefix: string, riskLevel: RiskLevel }>,
 *   mcpServers: Readonly<Record<string, {
 *     riskLevel: RiskLevel | null,
 *     tools: Readonly<Record<string, RiskLevel>>,
 *   }>>,
 * }} ToolRiskPolicy
 */

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {RiskLevel}
 */
function assertRiskLevel(value, field) {
  const level = String(value ?? '').trim().toLowerCase();
  if (!RISK_LEVELS.includes(/** @type {any} */ (level))) {
    throw new ToolRiskPolicyError(
      `${field} must be one of ${RISK_LEVELS.join('|')} (got ${JSON.stringify(value)})`,
      { code: 'TOOL_RISK_LEVEL_INVALID' },
    );
  }
  return /** @type {RiskLevel} */ (level);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {RiskDecision}
 */
function assertDecision(value, field) {
  const decision = String(value ?? '').trim().toLowerCase();
  if (!DECISIONS.includes(/** @type {any} */ (decision))) {
    throw new ToolRiskPolicyError(
      `${field} must be one of ${DECISIONS.join('|')} (got ${JSON.stringify(value)})`,
      { code: 'TOOL_RISK_DECISION_INVALID' },
    );
  }
  return /** @type {RiskDecision} */ (decision);
}

/**
 * A risk entry is either a bare level (`"high"`) or an object carrying one
 * (`{ riskLevel: "high" }`), so the same table can gain fields later without
 * breaking existing config files.
 *
 * @param {unknown} entry
 * @param {string} field
 * @returns {RiskLevel}
 */
function readRiskEntry(entry, field) {
  if (entry != null && typeof entry === 'object' && !Array.isArray(entry)) {
    const obj = /** @type {Record<string, unknown>} */ (entry);
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
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
function assertObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolRiskPolicyError(`${field} must be an object`, {
      code: 'TOOL_RISK_POLICY_SHAPE',
    });
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * Tool keys accept the projected tool name (`read`, `mcp__github__create_pr`),
 * the `server::tool` form, or a trailing-`*` prefix pattern.
 * @param {string} key
 */
function normalizeToolKey(key) {
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
 * @param {unknown} raw
 * @param {{ field?: string }} [opts]
 * @returns {ToolRiskPolicy}
 */
export function loadToolRiskPolicy(raw, opts = {}) {
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

  /** @type {Record<string, RiskDecision>} */
  const riskApproval = { ...DEFAULT_RISK_APPROVAL };
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

  /** @type {Record<string, RiskLevel>} */
  const classRiskLevels = { ...DEFAULT_CLASS_RISK_LEVELS };
  if (obj.classRiskLevels != null) {
    const table = assertObject(obj.classRiskLevels, `${field}.classRiskLevels`);
    for (const [cls, level] of Object.entries(table)) {
      if (!RISK_CLASSES.includes(/** @type {any} */ (cls))) {
        throw new ToolRiskPolicyError(
          `${field}.classRiskLevels.${cls} is not a tool class (expected ${RISK_CLASSES.join(', ')})`,
          { code: 'TOOL_RISK_POLICY_SHAPE' },
        );
      }
      classRiskLevels[cls] = readRiskEntry(level, `${field}.classRiskLevels.${cls}`);
    }
  }

  /** @type {Record<string, RiskLevel>} */
  const tools = {};
  /** @type {Array<{ prefix: string, riskLevel: RiskLevel }>} */
  const toolPatterns = [];
  if (obj.tools != null) {
    const table = assertObject(obj.tools, `${field}.tools`);
    for (const [key, entry] of Object.entries(table)) {
      if (key.startsWith('_')) continue; // inline comment
      const normalized = normalizeToolKey(key);
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

  /** @type {Record<string, { riskLevel: RiskLevel | null, tools: Record<string, RiskLevel> }>} */
  const mcpServers = {};
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
      /** @type {Record<string, RiskLevel>} */
      const serverTools = {};
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
 * @param {RiskLevel | null | undefined} a
 * @param {RiskLevel | null | undefined} b
 * @returns {RiskLevel | null}
 */
function maxRisk(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return RISK_RANK[b] > RISK_RANK[a] ? b : a;
}

/**
 * @param {RiskDecision} a
 * @param {RiskDecision} b
 */
function strictestDecision(a, b) {
  return DECISION_RANK[b] > DECISION_RANK[a] ? b : a;
}

/**
 * Merge an override layer onto a base layer. The override may only tighten:
 * risk levels take the maximum, decisions take the stricter of the two.
 *
 * @param {ToolRiskPolicy} base
 * @param {ToolRiskPolicy | null | undefined} override
 * @returns {ToolRiskPolicy}
 */
export function mergeToolRiskPolicies(base, override) {
  if (!override) return base;

  /** @type {Record<string, RiskDecision>} */
  const riskApproval = { ...base.riskApproval };
  for (const level of RISK_LEVELS) {
    riskApproval[level] = strictestDecision(
      base.riskApproval[level],
      override.riskApproval[level],
    );
  }

  /** @type {Record<string, RiskLevel>} */
  const classRiskLevels = { ...base.classRiskLevels };
  for (const cls of RISK_CLASSES) {
    const merged = maxRisk(base.classRiskLevels[cls], override.classRiskLevels[cls]);
    if (merged) classRiskLevels[cls] = merged;
  }

  /** @type {Record<string, RiskLevel>} */
  const tools = { ...base.tools };
  for (const [name, level] of Object.entries(override.tools)) {
    const merged = maxRisk(tools[name], level);
    if (merged) tools[name] = merged;
  }

  /** @type {Map<string, RiskLevel>} */
  const patterns = new Map();
  for (const { prefix, riskLevel } of [...base.toolPatterns, ...override.toolPatterns]) {
    const merged = maxRisk(patterns.get(prefix), riskLevel);
    if (merged) patterns.set(prefix, merged);
  }

  /** @type {Record<string, { riskLevel: RiskLevel | null, tools: Record<string, RiskLevel> }>} */
  const mcpServers = {};
  for (const id of new Set([
    ...Object.keys(base.mcpServers),
    ...Object.keys(override.mcpServers),
  ])) {
    const b = base.mcpServers[id];
    const o = override.mcpServers[id];
    /** @type {Record<string, RiskLevel>} */
    const serverTools = { ...(b?.tools || {}) };
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
 * @param {string} toolName
 * @param {{ class?: string, serverId?: string, tool?: string }} cls
 * @param {ToolRiskPolicy} policy
 * @returns {{ riskLevel: RiskLevel, source: string, configured: boolean }}
 */
export function resolveToolRiskLevel(toolName, cls, policy) {
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
    DEFAULT_CLASS_RISK_LEVELS[/** @type {keyof typeof DEFAULT_CLASS_RISK_LEVELS} */ (className)] ??
    'critical';
  return {
    riskLevel: /** @type {RiskLevel} */ (classLevel),
    source: `class:${className || 'unknown'}`,
    configured:
      classLevel !==
      DEFAULT_CLASS_RISK_LEVELS[
        /** @type {keyof typeof DEFAULT_CLASS_RISK_LEVELS} */ (className)
      ],
  };
}

/**
 * @param {RiskLevel} riskLevel
 * @param {ToolRiskPolicy} policy
 * @returns {RiskDecision}
 */
export function decisionForRiskLevel(riskLevel, policy) {
  return policy.riskApproval[riskLevel] ?? DEFAULT_RISK_APPROVAL[riskLevel] ?? 'deny';
}

/**
 * Accept an already-normalized policy or raw config and return a policy.
 * @param {unknown} value
 * @param {{ field?: string }} [opts]
 * @returns {ToolRiskPolicy}
 */
export function coerceToolRiskPolicy(value, opts = {}) {
  if (!value) return defaultToolRiskPolicy();
  if (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'riskApproval' in value &&
    'toolPatterns' in value
  ) {
    return /** @type {ToolRiskPolicy} */ (value);
  }
  return loadToolRiskPolicy(value, opts);
}
