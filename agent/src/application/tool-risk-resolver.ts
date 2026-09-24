/**
 * 把「平台层 + 租户层」两张风险表合成一个**按 Run 的解析函数**，交给策略装配
 * （ADR 0009 D3「`toolPolicy` → 闸门的过滤」/ 计划 H8）。
 *
 * ## 这里补的是第三条断掉的链
 *
 * 两处都断着，症状都是「配了没用，且没有人报错」：
 *
 * 1. **平台层**：`container-run-executor.ts` 把 `resolveToolRiskPolicy(env)` 的
 *    结果放进 **executor 工厂**的 `riskOverrides`，而 `runtime-factory` 读的是
 *    **它自己的** `opts.riskOverrides`——两个不同的对象。于是
 *    `config/agent/tool-risk.json` 与 `TOOL_RISK_POLICY_*` 零效果。
 * 2. **租户层**：`buildAgentVersionToolRiskBindings(agentVersion)` 算出来的
 *    `agentVersionToolRiskPolicy` 现在直接合入本 Run 的风险解析函数，随策略
 *    装配一起生效。
 *
 * ## 分层不变量
 *
 * 租户层只能**收紧**，不能放松：`mergeToolRiskPolicies` 取风险等级的最大值、
 * 决定的更严者。一个 org 不能靠发一个新 AgentVersion 把平台的审批闸门关掉。
 */
import {
  coerceToolRiskPolicy,
  decisionForRiskLevel,
  resolveToolRiskLevel,
  type ToolRiskPolicy,
} from '../infrastructure/dsh/tool-risk-policy.js';
import { buildAgentVersionToolRiskBindings } from './tool-risk-bindings.js';
import { classifyTool } from '../runtime/policy/risk-table.js';
import {
  RISK_RANK,
  makePolicyDecision,
  mergePolicyDecisions,
  type PolicyDecision,
} from '../runtime/policy/decision.js';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * `mcp__<server>__<tool>` 拆出 server 与裸工具名。
 *
 * 出厂 `dsh-mcp-client` 对超长或含非法字符的名字会**规范化并追加 12 位十六进制
 * 哈希**，那种名字精确匹配不上，只能靠 `mcp__<server>__*` 前缀条目兜底
 * （ADR 0009 D9 §2）。所以这里拆不出裸名也不算错，交给前缀规则。
 */
function splitMcpName(toolName: string): { serverId?: string; tool?: string } {
  if (!toolName.startsWith('mcp__')) return {};
  const rest = toolName.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return {};
  return { serverId: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * 建本 Run 的风险解析函数。
 *
 * @param platformPolicy 运维层（`config/agent/tool-risk.json` / `TOOL_RISK_POLICY_*`）
 * @param agentVersion   本 Run 的 AgentVersion（可为空）
 */
export function buildRunRiskResolver(
  platformPolicy: unknown,
  agentVersion: unknown,
): (toolName: string) => RiskLevel | undefined {
  const base = coerceToolRiskPolicy(platformPolicy, { field: 'platform.toolRiskPolicy' });
  const { agentVersionToolRiskPolicy } = buildAgentVersionToolRiskBindings(agentVersion);
  const tenant = agentVersionToolRiskPolicy ?? null;

  return (toolName: string): RiskLevel | undefined => {
    const cls = { class: classifyTool(toolName), ...splitMcpName(toolName) };
    const baseHit = resolveToolRiskLevel(toolName, cls, base as never);
    const tenantHit = tenant
      ? resolveToolRiskLevel(toolName, cls, tenant as never)
      : null;
    // The high floor applies only when the platform has not explicitly
    // classified this exact MCP call (or a matching server/pattern) as a
    // lower-risk operation. A deliberate platform readonly-low entry is a
    // valid override; a tenant low entry alone cannot lower the unconfigured
    // platform external-high baseline.
    const mcpFloor =
      toolName.startsWith('mcp__') && baseHit.configured !== true
        ? 'high' as RiskLevel
        : null;
    const effective = maxRiskLevel(
      baseHit.riskLevel as RiskLevel,
      tenantHit?.configured === true ? tenantHit.riskLevel as RiskLevel : null,
      mcpFloor,
    );
    // MCP 的地板（ADR 0009 D9 §2）：任何 `mcp__*` 名字没配到时按 high。
    //
    // 出厂包对超长或含非法字符的工具名会规范化并**追加 12 位十六进制哈希**，
    // 那种名字精确 key 匹配不上，只能靠 `mcp__<server>__*` 前缀条目兜底——
    // 而前缀条目也可能被漏配。所以这里再钉一层：漏配的后果是「要审批」，
    // 绝不能是「放行」。
    //
    // 分类默认对 `mcp__` 本来也是 external_high，两者一致；显式写出来是为了
    // **不依赖那个巧合**——哪天有人把 external_high 的默认调低，这条仍然守着。
    if (
      baseHit.configured !== true &&
      tenantHit?.configured !== true &&
      toolName.startsWith('mcp__')
    ) return 'high';
    // `configured: false` 表示这一层没配，落回风险表按分类给的默认值——
    // 返回 undefined 让 `decideFromRiskTable` 走它自己的默认，不要在这里
    // 把「没配」硬编成一个等级。
    if (baseHit.configured === true || tenantHit?.configured === true) {
      return effective;
    }
    return undefined;
  };
}

function maxRiskLevel(...levels: Array<RiskLevel | null | undefined>): RiskLevel {
  return levels.reduce<RiskLevel>((best, candidate) => {
    if (candidate == null) return best;
    return RISK_RANK[candidate] > RISK_RANK[best] ? candidate : best;
  }, 'low');
}

/**
 * Resolve the complete decision for one Run. Each policy layer is resolved
 * independently before the stricter decision is selected. Resolving a merged
 * map by key is unsafe: a tenant exact `low` entry could shadow a platform
 * wildcard `high` entry even though the tenant is only allowed to tighten.
 */
export function buildRunPolicyResolver(
  platformPolicy: unknown,
  agentVersion: unknown,
): (toolName: string) => PolicyDecision {
  const base = coerceToolRiskPolicy(platformPolicy, { field: 'platform.toolRiskPolicy' });
  const { agentVersionToolRiskPolicy } = buildAgentVersionToolRiskBindings(agentVersion);
  const tenant = agentVersionToolRiskPolicy ?? null;

  return (toolName: string): PolicyDecision => {
    const cls = { class: classifyTool(toolName), ...splitMcpName(toolName) };
    const baseHit = resolveToolRiskLevel(toolName, cls, base as never);
    const tenantHit = tenant
      ? resolveToolRiskLevel(toolName, cls, tenant as never)
      : null;
    const effectiveRisk = maxRiskLevel(
      baseHit.riskLevel as RiskLevel,
      tenantHit?.configured === true ? tenantHit.riskLevel as RiskLevel : null,
      toolName.startsWith('mcp__') && baseHit.configured !== true ? 'high' : null,
    );
    const decisions: PolicyDecision[] = [
      makeRiskDecision(toolName, baseHit, effectiveRisk, base, 'platform'),
    ];
    if (tenant) {
      // Applying the tenant's riskApproval table to the effective risk preserves
      // explicit approval tightening even when it did not set a level for this
      // particular tool. The merge below prevents it from ever lowering the
      // platform decision.
      decisions.push(
        makeRiskDecision(toolName, tenantHit ?? baseHit, effectiveRisk, tenant, 'agent-version'),
      );
    }
    return mergePolicyDecisions(decisions);
  };
}

function makeRiskDecision(
  toolName: string,
  hit: { riskLevel: string, source: string },
  effectiveRisk: RiskLevel,
  policy: ToolRiskPolicy,
  layer: string,
): PolicyDecision {
  const decision = decisionForRiskLevel(effectiveRisk, policy);
  return makePolicyDecision({
    decision,
    reasonCode: `RISK_${effectiveRisk.toUpperCase()}`,
    reason: `${toolName} resolved ${effectiveRisk} by ${layer} (${hit.source})`,
    policyId: `${layer}:risk-policy`,
    riskLevel: effectiveRisk,
  });
}
