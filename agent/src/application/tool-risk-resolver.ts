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
 *    `agentVersionToolRiskPolicy` 只喂给 `extensionBundleFactory`——那批 Pi
 *    Extension 早已删除。而唯一会校验它的 `resolveAgentVersionBindings()`
 *    **没有任何调用方**，所以连 fail-closed 都不会触发。
 *
 * ## 分层不变量
 *
 * 租户层只能**收紧**，不能放松：`mergeToolRiskPolicies` 取风险等级的最大值、
 * 决定的更严者。一个 org 不能靠发一个新 AgentVersion 把平台的审批闸门关掉。
 */
import {
  coerceToolRiskPolicy,
  mergeToolRiskPolicies,
  resolveToolRiskLevel,
} from '../infrastructure/dsh/tool-risk-policy.js';
import { buildAgentVersionToolRiskBindings } from './tool-risk-bindings.js';

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
  const merged = mergeToolRiskPolicies(
    base as never,
    (agentVersionToolRiskPolicy ?? null) as never,
  );

  return (toolName: string): RiskLevel | undefined => {
    const hit = resolveToolRiskLevel(toolName, splitMcpName(toolName), merged as never);
    // `configured: false` 表示这一层没配，落回风险表按分类给的默认值——
    // 返回 undefined 让 `decideFromRiskTable` 走它自己的默认，不要在这里
    // 把「没配」硬编成一个等级。
    return hit?.configured === true ? (hit.riskLevel as RiskLevel) : undefined;
  };
}
