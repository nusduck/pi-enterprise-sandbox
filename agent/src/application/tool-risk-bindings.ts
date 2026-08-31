/**
 * Project AgentVersion `configJson.toolPolicy` into the two enterprise-policy
 * inputs it feeds:
 *
 *   - `agentVersionToolPolicy`      explicit per-tool decisions
 *   - `agentVersionToolRiskPolicy`  the risk table layer
 *
 * `configJson.toolPolicy` shape:
 *
 *   {
 *     "tools":           { "mcp__github__create_pr": "require_approval" },
 *     "riskLevels":      { "bash_run": "high", "process_*": "medium" },
 *     "riskApproval":    { "medium": "require_approval" },
 *     "classRiskLevels": { "local_low": "medium" }
 *   }
 *
 * MCP server risk (`mcpServers[].toolPolicy.riskLevel` /
 * `.toolRiskLevels`) is merged in from buildMcpPolicyBindings so an MCP
 * server's risk lives next to the rest of its config.
 */

import { loadToolRiskPolicy } from '../infrastructure/dsh/tool-risk-policy.js';
import { resolveToolNameAlias } from '../infrastructure/dsh/constants.js';
import { parseAgentVersionConfigJson } from '../infrastructure/mcp/mcp-config-loader.js';

/** Risk-table fields inside toolPolicy; everything else is a decision entry. */
const RISK_FIELDS = Object.freeze([
  'riskLevels',
  'riskApproval',
  'classRiskLevels',
]);

/**
 * @param agentVersion
 * @returns {Record<string, unknown>}
 */
function readConfigJson(agentVersion: unknown) {
  if (!agentVersion || typeof agentVersion !== 'object') return {};
  const v = (agentVersion as Record<string, unknown>);
  const raw = v.configJson ?? v.config_json;
  return raw != null
    ? parseAgentVersionConfigJson(raw, 'configJson')
    : (v as Record<string, unknown>);
}

/**
 * The extension names this AgentVersion asks for, in its own order.
 * Empty means "platform default set".
 *
 * @param agentVersion
 * @returns {string[]}
 */
export function readAgentVersionExtensions(agentVersion: unknown) {
  const config = readConfigJson(agentVersion);
  return Array.isArray(config?.extensions) ? [...config.extensions] : [];
}


/**
 * Sub-agent resource limits declared by an AgentVersion's `configJson.subagent`
 * (`{ maxDepth?, maxConcurrent? }`). Absent/invalid values are omitted so the
 * extension falls back to its own (env-tunable) defaults. This mirrors how
 * `toolPolicy`/`thinkingLevel` live on the version: per-tenant behaviour stays
 * version-scoped instead of one deployment-wide env knob.
 *
 * @param agentVersion
 * @returns {{ maxDepth?: number, maxConcurrent?: number }}
 */
export function readAgentVersionSubagentPolicy(agentVersion: unknown) {
  const config = readConfigJson(agentVersion);
  const subagent =
    config?.subagent &&
    typeof config.subagent === 'object' &&
    !Array.isArray(config.subagent)
      ? config.subagent
      : {};
  // @ts-expect-error 遗留JS占位类型object未展开，访问maxDepth需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'maxDepth' does not exist on type 'object'.
  const maxDepth = Number(subagent.maxDepth);
  // @ts-expect-error 遗留JS占位类型object未展开，访问maxConcurrent需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'maxConcurrent' does not exist on type 'object'.
  const maxConcurrent = Number(subagent.maxConcurrent);
  return {
    ...(Number.isSafeInteger(maxDepth) && maxDepth >= 0 ? { maxDepth } : {}),
    ...(Number.isSafeInteger(maxConcurrent) && maxConcurrent >= 1
      ? { maxConcurrent }
      : {}),
  };
}

/**
 * The raw `configJson.toolPolicy` object, or `{}` when absent/malformed.
 *
 * Exported so callers can tell "this AgentVersion configures tool policy at
 * all" apart from "the projection happened to yield no decisions and no risk
 * table" — `{ tools: {} }` is the first but not the second.
 *
 * @param agentVersion
 * @returns {Record<string, unknown>}
 */
export function readAgentVersionToolPolicy(agentVersion: unknown) {
  return readToolPolicy(agentVersion);
}

/**
 * 把一张按工具名索引的表投影到当前工具名（ADR 0009 D4 的存量处置 / 计划 H1.6）。
 *
 * `AgentVersion.configJson` 是 Run 创建时冻结的**不可变快照**，2026-08-31 之前建的
 * 那些里面存的是旧 Pi 工具名。不迁移、不回写——只在**读取**时投影一次。
 * 不处置的后果不是「少一条策略」，而是老 Run 静默全拒：分类器 fail-closed，
 * 旧名在新工具面上一个都命中不了。
 *
 * 三条规矩：
 * - `mcp__*` / `server::tool` / 前缀式 key 原样保留（它们不由我们命名）。
 * - 退役能力（`memory_*` 等）投影成 `null`，这里直接丢掉该条——风险表会在
 *   `decideFromRiskTable` 里给稳定的 `TOOL_RETIRED`，不需要 toolPolicy 再说一遍。
 * - **新名优先**：快照里同时写了旧名和新名时，新名赢，旧名不覆盖它。
 */
function projectLegacyToolNames(table: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const explicit = new Set<string>();
  // 先放新名（或不由我们命名的 key），它们不该被旧名的投影覆盖。
  for (const [key, value] of Object.entries(table)) {
    if (key.startsWith('mcp__') || key.includes('::') || key.endsWith('*')) {
      out[key] = value;
      explicit.add(key);
      continue;
    }
    if (resolveToolNameAlias(key) === key) {
      out[key] = value;
      explicit.add(key);
    }
  }
  for (const [key, value] of Object.entries(table)) {
    if (explicit.has(key)) continue;
    const projected = resolveToolNameAlias(key);
    if (projected === null) continue; // 退役能力，交给风险表给理由码
    if (explicit.has(projected)) continue; // 新名已显式给过，不覆盖
    out[projected] = value;
  }
  return out;
}

/**
 * @param agentVersion
 * @returns {Record<string, unknown>}
 */
function readToolPolicy(agentVersion: unknown) {
  const config = readConfigJson(agentVersion);
  const toolPolicy = config?.toolPolicy;
  if (!toolPolicy || typeof toolPolicy !== 'object' || Array.isArray(toolPolicy)) {
    return {};
  }
  return (toolPolicy as Record<string, unknown>);
}

/**
 * @param agentVersion
 * @param [mcpBindings]
 * @returns {{
 *   agentVersionToolPolicy: Record<string, unknown> | undefined,
 *   agentVersionToolRiskPolicy: Record<string, unknown> | undefined,
 * }}
 */
export function buildAgentVersionToolRiskBindings(agentVersion: unknown, mcpBindings: { mcpToolRiskPolicy?: { mcpServers?: Record<string, unknown> } } = {}) {
  const toolPolicy = readToolPolicy(agentVersion);

  /**
   * Explicit decisions live either under `tools` or — for backwards
   * compatibility with the flat `{ toolName: decision }` shape implied by the
   * original engine dep — directly on toolPolicy.
   * @type {Record<string, unknown>}
   */
  const decisions = {};
  if (
    toolPolicy.tools &&
    typeof toolPolicy.tools === 'object' &&
    !Array.isArray(toolPolicy.tools)
  ) {
    Object.assign(decisions, projectLegacyToolNames(toolPolicy.tools as Record<string, unknown>));
  }
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolPolicy)) {
    if (key === 'tools' || RISK_FIELDS.includes(key)) continue;
    flat[key] = value;
  }
  Object.assign(decisions, projectLegacyToolNames(flat));

  const riskRaw: Record<string, unknown> = {};
  if (toolPolicy.riskLevels != null) {
    riskRaw.tools = projectLegacyToolNames(toolPolicy.riskLevels as Record<string, unknown>);
  }
  if (toolPolicy.riskApproval != null) riskRaw.riskApproval = toolPolicy.riskApproval;
  if (toolPolicy.classRiskLevels != null) {
    riskRaw.classRiskLevels = toolPolicy.classRiskLevels;
  }

  const mcpServers = mcpBindings?.mcpToolRiskPolicy?.mcpServers;
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    riskRaw.mcpServers = mcpServers;
  }

  const hasRisk = Object.keys(riskRaw).length > 0;

  return {
    agentVersionToolPolicy:
      Object.keys(decisions).length > 0 ? Object.freeze(decisions) : undefined,
    agentVersionToolRiskPolicy: hasRisk
      ? loadToolRiskPolicy(riskRaw, { field: 'agentVersion.toolPolicy' })
      : undefined,
  };
}
