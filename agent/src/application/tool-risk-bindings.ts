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
import { parseAgentVersionConfigJson } from '../infrastructure/mcp/mcp-config-loader.js';
import { buildMcpPolicyBindings } from '../infrastructure/mcp/mcp-policy-bindings.js';

/** Risk-table fields inside toolPolicy; everything else is a decision entry. */
const RISK_FIELDS = Object.freeze([
  'riskLevels',
  'riskApproval',
  'classRiskLevels',
]);

const DECISION_RANK: Readonly<Record<string, number>> = Object.freeze({
  allow: 0,
  require_approval: 1,
  deny: 2,
});

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
 * 把一张按工具名索引的表合并进决定表。**冲突取更严**：快照里同时写了
 * `tools` 嵌套项与 flat 项时，只保留更严格的决定，避免旧字段把禁止放松成允许。
 *
 * 注意：这里不再做旧引擎工具名到新名的投影（legacy 升级路径已删除）。
 * 快照里的 key 原样保留；旧名不对应任何当前工具，运行时分类器 fail-closed
 *（未知工具一律拒绝），不会静默获得授权。
 */
function putStrictestDecisions(
  target: Record<string, unknown>,
  table: Record<string, unknown>,
): void {
  for (const [rawKey, value] of Object.entries(table)) {
    const toolName = String(rawKey).trim();
    const current = target[toolName];
    if (current === undefined) {
      target[toolName] = value;
      continue;
    }
    const currentRaw =
      current && typeof current === 'object' && !Array.isArray(current) &&
      Object.hasOwn(current as object, 'decision')
        ? (current as Record<string, unknown>).decision
        : current;
    const nextRaw =
      value && typeof value === 'object' && !Array.isArray(value) &&
      Object.hasOwn(value as object, 'decision')
        ? (value as Record<string, unknown>).decision
        : value;
    if (
      DECISION_RANK[String(nextRaw ?? '').trim().toLowerCase()] >
      DECISION_RANK[String(currentRaw ?? '').trim().toLowerCase()]
    ) {
      target[toolName] = value;
    }
  }
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
   * Explicit decisions live either under `tools` or — for the flat
   * `{ toolName: decision }` shape — directly on toolPolicy. Both spellings
   * merge with "stricter wins" so a flat entry cannot loosen a nested one.
   * @type {Record<string, unknown>}
   */
  const decisions: Record<string, unknown> = {};
  if (
    toolPolicy.tools &&
    typeof toolPolicy.tools === 'object' &&
    !Array.isArray(toolPolicy.tools)
  ) {
    putStrictestDecisions(decisions, toolPolicy.tools as Record<string, unknown>);
  }
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolPolicy)) {
    if (key === 'tools' || RISK_FIELDS.includes(key)) continue;
    flat[key] = value;
  }
  putStrictestDecisions(decisions, flat);

  const riskRaw: Record<string, unknown> = {};
  if (toolPolicy.riskLevels != null) {
    riskRaw.tools = { ...(toolPolicy.riskLevels as Record<string, unknown>) };
  }
  if (toolPolicy.riskApproval != null) riskRaw.riskApproval = toolPolicy.riskApproval;
  if (toolPolicy.classRiskLevels != null) {
    riskRaw.classRiskLevels = toolPolicy.classRiskLevels;
  }

  const suppliedMcpServers = mcpBindings?.mcpToolRiskPolicy?.mcpServers;
  const inferredMcpBindings =
    suppliedMcpServers === undefined &&
    agentVersion &&
    typeof agentVersion === 'object' &&
    (Object.hasOwn(agentVersion as object, 'configJson') ||
      Object.hasOwn(agentVersion as object, 'config_json'))
      ? buildMcpPolicyBindings(agentVersion)
      : null;
  const mcpServers = suppliedMcpServers ?? inferredMcpBindings?.mcpToolRiskPolicy?.mcpServers;
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
