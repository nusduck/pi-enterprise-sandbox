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
 * - **冲突取更严**：快照里同时写了旧名和新名，或同时写了 v1 的嵌套项与
 *   legacy flat 项时，投影后只保留更严格的决定，避免旧字段把禁止放松成允许。
 */
function projectLegacyToolNames(
  table: Record<string, unknown>,
  mode: 'decision' | 'value' = 'value',
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (projected: string, value: unknown) => {
    const current = out[projected];
    if (mode !== 'decision' || current === undefined) {
      out[projected] = value;
      return;
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
      out[projected] = value;
    }
  };
  for (const [rawKey, value] of Object.entries(table)) {
    const key = String(rawKey).trim();
    const projected = key.startsWith('mcp__') ? key : resolveToolNameAlias(key);
    if (projected === null) continue; // 退役能力，交给风险表给理由码
    put(projected, value);
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
    Object.assign(
      decisions,
      projectLegacyToolNames(toolPolicy.tools as Record<string, unknown>, 'decision'),
    );
  }
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(toolPolicy)) {
    if (key === 'tools' || RISK_FIELDS.includes(key)) continue;
    flat[key] = value;
  }
  for (const [toolName, decision] of Object.entries(
    projectLegacyToolNames(flat, 'decision'),
  )) {
    const current = decisions[toolName];
    const currentRaw =
      current && typeof current === 'object' && !Array.isArray(current) &&
      Object.hasOwn(current as object, 'decision')
        ? (current as Record<string, unknown>).decision
        : current;
    const nextRaw =
      decision && typeof decision === 'object' && !Array.isArray(decision) &&
      Object.hasOwn(decision as object, 'decision')
        ? (decision as Record<string, unknown>).decision
        : decision;
    if (
      current === undefined ||
      DECISION_RANK[String(nextRaw ?? '').trim().toLowerCase()] >
        DECISION_RANK[String(currentRaw ?? '').trim().toLowerCase()]
    ) {
      decisions[toolName] = decision;
    }
  }

  const riskRaw: Record<string, unknown> = {};
  if (toolPolicy.riskLevels != null) {
    riskRaw.tools = projectLegacyToolNames(toolPolicy.riskLevels as Record<string, unknown>);
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
