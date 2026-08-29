/**
 * 工具风险表——分类决定“这是哪类工具”，表决定“这类有多危险、要不要审批”。
 *
 * 未知工具一律 deny（fail-closed）。high → require_approval，critical → deny。
 */

import { makePolicyDecision, type PolicyDecision, type PolicyRiskLevel } from './decision.js';

export type ToolRiskClass = 'internal_interaction' | 'local_low' | 'external_readonly' | 'external_high' | 'unknown';

const LOCAL_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'process_start',
  'process_poll',
  'process_write_stdin',
  'process_kill',
  'submit_artifact',
  'skill_list',
  'skill_install',
  'skill_uninstall',
  'spawn_subagent',
  'todo_write',
  'memory_write',
  'memory_search',
]);

export const DEFAULT_CLASS_RISK: Record<Exclude<ToolRiskClass, 'unknown'>, PolicyRiskLevel> = {
  internal_interaction: 'low',
  local_low: 'low',
  external_readonly: 'medium',
  external_high: 'high',
};

export const DEFAULT_RISK_APPROVAL: Record<PolicyRiskLevel, PolicyDecision['decision']> = {
  low: 'allow',
  medium: 'allow',
  high: 'require_approval',
  critical: 'deny',
};

export function classifyTool(toolName: string): ToolRiskClass {
  if (toolName === 'ask_user') return 'internal_interaction';
  if (LOCAL_TOOLS.has(toolName)) return 'local_low';
  if (toolName.startsWith('mcp__')) return 'external_high';
  return 'unknown';
}

const DEFAULT_TOOL_OVERRIDES: Readonly<Record<string, PolicyRiskLevel>> = {
  skill_install: 'high',
};

export function decideFromRiskTable(
  toolName: string,
  overrides: Readonly<Record<string, PolicyRiskLevel>> = {},
): PolicyDecision {
  const cls = classifyTool(toolName);
  if (cls === 'unknown') {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: 'UNKNOWN_TOOL',
      reason: `unknown tool ${toolName} is denied`,
      policyId: 'platform:risk-table',
      riskLevel: 'critical',
    });
  }
  const riskLevel = overrides[toolName] ?? DEFAULT_TOOL_OVERRIDES[toolName] ?? DEFAULT_CLASS_RISK[cls];
  const decision = DEFAULT_RISK_APPROVAL[riskLevel];
  return makePolicyDecision({
    decision,
    reasonCode: `RISK_${riskLevel.toUpperCase()}`,
    reason: `${toolName} classified ${cls} at ${riskLevel}`,
    policyId: 'platform:risk-table',
    riskLevel,
  });
}
