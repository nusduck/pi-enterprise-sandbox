/**
 * 工具风险表——分类决定“这是哪类工具”，表决定“这类有多危险、要不要审批”。
 *
 * 未知工具一律 deny（fail-closed）。high → require_approval，critical → deny。
 */

import { makePolicyDecision, type PolicyDecision, type PolicyRiskLevel } from './decision.js';
import {
  ASK_USER_TOOL_NAME,
  SANDBOX_TOOL_NAMES,
  EXTERNAL_HOST_TOOL_NAMES,
  isRetiredToolName,
  RETIRED_TOOL_REASON_CODE,
} from './tool-names.js';

export type ToolRiskClass = 'internal_interaction' | 'local_low' | 'external_readonly' | 'external_high' | 'unknown';

/**
 * 引用 `constants.ts` 的唯一事实源（ADR 0009 D4）。**不要在这里再列一份工具名**
 * ——2026-08-31 之前这里与 `constants.ts` 就已经漂到两套进程族名字了。
 */
const LOCAL_TOOLS: ReadonlySet<string> = new Set(SANDBOX_TOOL_NAMES);
const EXTERNAL_HOST_TOOLS: ReadonlySet<string> = new Set(EXTERNAL_HOST_TOOL_NAMES);

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
  if (toolName === ASK_USER_TOOL_NAME) return 'internal_interaction';
  if (LOCAL_TOOLS.has(toolName)) return 'local_low';
  if (EXTERNAL_HOST_TOOLS.has(toolName)) return 'external_high';
  if (toolName.startsWith('mcp__')) return 'external_high';
  return 'unknown';
}

/**
 * 平台级风险覆盖。
 *
 * 2026-08-31 清空：原来只有 `skill_install: 'high'`，而 ADR 0009 D7 取消了整套
 * skill 变更工具（模型改用 `write`/`bash` 写草稿目录，闸门移到 UI 上的「启用」），
 * 那条覆盖与它服务的 `source-digest` 重放路径一起退役。
 *
 * 2026-10-03 产品决定：远端委派默认不审批。分类仍是 `external_high`（内容会发到外部），
 * 只把默认风险降到 medium（放行）；远端清单由运维登记、AgentVersion 白名单授权，
 * 需要审批的 Agent 可在 `toolPolicy.riskLevels` 里调回 high。
 */
const DEFAULT_TOOL_OVERRIDES: Readonly<Record<string, PolicyRiskLevel>> = {
  delegate_to_remote_agent: 'medium',
};

export function decideFromRiskTable(
  toolName: string,
  overrides:
    | Readonly<Record<string, PolicyRiskLevel>>
    | ((toolName: string) => PolicyRiskLevel | undefined) = {},
): PolicyDecision {
  if (isRetiredToolName(toolName)) {
    return makePolicyDecision({
      decision: 'deny',
      reasonCode: RETIRED_TOOL_REASON_CODE,
      reason: `${toolName} is retired in this stage and is not callable`,
      policyId: 'platform:risk-table',
      riskLevel: 'critical',
    });
  }
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
  const override =
    typeof overrides === 'function' ? overrides(toolName) : overrides[toolName];
  const riskLevel = override ?? DEFAULT_TOOL_OVERRIDES[toolName] ?? DEFAULT_CLASS_RISK[cls];
  const decision = DEFAULT_RISK_APPROVAL[riskLevel];
  return makePolicyDecision({
    decision,
    reasonCode: `RISK_${riskLevel.toUpperCase()}`,
    reason: `${toolName} classified ${cls} at ${riskLevel}`,
    policyId: 'platform:risk-table',
    riskLevel,
  });
}
