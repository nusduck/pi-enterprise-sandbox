/**
 * AgentVersion 的 MCP 策略投影：把逻辑 MCP 配置摊成
 * `mcpServerPolicies`（每台服务器的工具策略）与 `mcpToolRiskPolicy`
 * （喂给风险表的分层覆盖）。
 *
 * 2026-08-31（ADR 0009 D9 / 计划 H7.5）从 `pi-mcp-adapter-factory.ts` 搬出来。
 * 那个文件连同钉死的 `pi-mcp-adapter@2.11.0` 一起退役了——MCP 的**连接**面
 * 现在是出厂 `@deepseek-ai/dsh-mcp-client`（overlay 里一台服务器一个实例）。
 * 但**策略**面不是连接面：它读的是 AgentVersion 的配置，与谁去连没有关系，
 * 所以留下来。
 */
import { loadMcpConfig, loadMcpConfigFromAgentVersion } from './mcp-config-loader.js';

export function buildMcpPolicyBindings(raw: unknown) {
  const logical =
    raw &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    (Object.hasOwn(raw, 'configJson') || Object.hasOwn(raw, 'config_json'))
      ? loadMcpConfigFromAgentVersion(raw)
      : loadMcpConfig(raw ?? []);
  const mcpServerPolicies: Record<string, Record<string, unknown>> = {};
  const riskServers: Record<string, { riskLevel?: string, tools?: Record<string, string> }> = {};
  for (const server of logical) {
    mcpServerPolicies[server.serverId] = {
      ...server.toolPolicy,
      tools:
        server.toolPolicy.tools && typeof server.toolPolicy.tools === 'object'
          ? { ...server.toolPolicy.tools }
          : undefined,
    };

    const riskLevel = server.toolPolicy.riskLevel;
    const toolRiskLevels = server.toolPolicy.toolRiskLevels;
    if (riskLevel || toolRiskLevels) {
      riskServers[server.serverId] = {
        ...(riskLevel ? { riskLevel: String(riskLevel) } : {}),
        ...(toolRiskLevels && typeof toolRiskLevels === 'object'
          ? { tools: { ...(toolRiskLevels as Record<string, any>) } }
          : {}),
      };
    }
  }
  return Object.freeze({
    mcpServerPolicies: Object.freeze(mcpServerPolicies),
    mcpToolRiskPolicy: Object.freeze(
      Object.keys(riskServers).length > 0
        ? { mcpServers: Object.freeze(riskServers) }
        : {},
    ),
  });
}
