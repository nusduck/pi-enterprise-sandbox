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

import { loadToolRiskPolicy } from '../extensions/enterprise-policy/tool-risk-policy.js';
import { parseAgentVersionConfigJson } from '../infrastructure/mcp/mcp-config-loader.js';

/** Risk-table fields inside toolPolicy; everything else is a decision entry. */
const RISK_FIELDS = Object.freeze([
  'riskLevels',
  'riskApproval',
  'classRiskLevels',
]);

/**
 * @param {unknown} agentVersion
 * @returns {Record<string, unknown>}
 */
function readConfigJson(agentVersion) {
  if (!agentVersion || typeof agentVersion !== 'object') return {};
  const v = /** @type {Record<string, unknown>} */ (agentVersion);
  const raw = v.configJson ?? v.config_json;
  return raw != null
    ? parseAgentVersionConfigJson(raw, 'configJson')
    : /** @type {Record<string, unknown>} */ (v);
}

/**
 * The extension names this AgentVersion asks for, in its own order.
 * Empty means "platform default set".
 *
 * @param {unknown} agentVersion
 * @returns {string[]}
 */
export function readAgentVersionExtensions(agentVersion) {
  const config = readConfigJson(agentVersion);
  return Array.isArray(config?.extensions) ? [...config.extensions] : [];
}

/**
 * The raw `configJson.toolPolicy` object, or `{}` when absent/malformed.
 *
 * Exported so callers can tell "this AgentVersion configures tool policy at
 * all" apart from "the projection happened to yield no decisions and no risk
 * table" — `{ tools: {} }` is the first but not the second.
 *
 * @param {unknown} agentVersion
 * @returns {Record<string, unknown>}
 */
export function readAgentVersionToolPolicy(agentVersion) {
  return readToolPolicy(agentVersion);
}

/**
 * @param {unknown} agentVersion
 * @returns {Record<string, unknown>}
 */
function readToolPolicy(agentVersion) {
  const config = readConfigJson(agentVersion);
  const toolPolicy = config?.toolPolicy;
  if (!toolPolicy || typeof toolPolicy !== 'object' || Array.isArray(toolPolicy)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (toolPolicy);
}

/**
 * @param {unknown} agentVersion
 * @param {{ mcpToolRiskPolicy?: { mcpServers?: Record<string, unknown> } }} [mcpBindings]
 * @returns {{
 *   agentVersionToolPolicy: Record<string, unknown> | undefined,
 *   agentVersionToolRiskPolicy: Record<string, unknown> | undefined,
 * }}
 */
export function buildAgentVersionToolRiskBindings(agentVersion, mcpBindings = {}) {
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
    Object.assign(decisions, toolPolicy.tools);
  }
  for (const [key, value] of Object.entries(toolPolicy)) {
    if (key === 'tools' || RISK_FIELDS.includes(key)) continue;
    decisions[key] = value;
  }

  /** @type {Record<string, unknown>} */
  const riskRaw = {};
  if (toolPolicy.riskLevels != null) riskRaw.tools = toolPolicy.riskLevels;
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
