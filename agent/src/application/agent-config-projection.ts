/**
 * `agent-config-validator.ts` 的纯投影辅助（从该文件拆出，见 AGENTS.md §4 行数棘轮）。
 *
 * 这些函数都不读 `this`、不持有状态：把已验证/未验证的 config JSON 投影成
 * `platformConstraints` 与 `effectiveSummary` 需要的形状，以及把
 * `MCP_SERVERS_JSON` / 宿主参数声明读成进程级目录。
 *
 * 拆出的理由只是行数：`AgentConfigValidator` 本身（类 + 校验流程）留在原文件。
 */
import { buildRegistry, type ModelEntry } from '../infrastructure/model-registry.js';
import { selectableReasoningEfforts } from '../infrastructure/dsh/reasoning-efforts.js';
import {
  parseAgentVersionConfigJson,
} from '../infrastructure/mcp/mcp-config-loader.js';
import {
  readHostArgumentDeclarations,
  type HostArgumentSpec,
} from '../domain/agent/mcp-host-arguments.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/**
 * v1 白名单常量跟着 `canonicalObject` 一起搬过来：它按这些清单决定嵌套键的排序，
 * 是唯一消费者（`TOP_LEVEL_V1_KEYS` 与 `MCP_FORBIDDEN_V1_KEYS` 留在 validator，
 * 它们只服务校验流程）。
 */
export const MODEL_POLICY_V1_KEYS = Object.freeze([
  'modelId',
  'maxOutputTokens',
  'thinkingLevel',
  'temperature',
]);

export const TOOL_POLICY_V1_KEYS = Object.freeze([
  'tools',
  'riskLevels',
  'classRiskLevels',
  'riskApproval',
]);

export const MCP_ENTRY_V1_KEYS = Object.freeze([
  'serverId',
  'enabledTools',
  'toolPolicy',
  'toolArguments',
]);

export const MCP_TOOL_POLICY_KEYS = Object.freeze([
  'default',
  'tools',
  'riskLevel',
  'toolRiskLevels',
]);

export const SIMPLE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * 本地定义而不是从 validator 导入：两个模块互相需要这个判定，跨文件共享会成环。
 * 它只有四行，重复的代价小于一条循环 import。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalObject(
  value: unknown,
  preferred: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalObject(item));
  if (!isPlainObject(value)) return value;
  const rank = new Map(preferred.map((key, index) => [key, index]));
  const keys = Object.keys(value).sort((left, right) => {
    const l = rank.has(left) ? rank.get(left)! : Number.MAX_SAFE_INTEGER;
    const r = rank.has(right) ? rank.get(right)! : Number.MAX_SAFE_INTEGER;
    return l === r ? left.localeCompare(right) : l - r;
  });
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const nestedPreferred = key === 'modelPolicy'
      ? MODEL_POLICY_V1_KEYS
      : key === 'toolPolicy'
        ? TOOL_POLICY_V1_KEYS
        : key === 'mcpServers'
          ? MCP_ENTRY_V1_KEYS
          : key === 'tools'
            ? []
            : key === 'riskLevels' || key === 'classRiskLevels' || key === 'riskApproval'
              ? []
              : key === 'toolPolicy'
                ? MCP_TOOL_POLICY_KEYS
                : [];
    out[key] = canonicalObject(value[key], nestedPreferred);
  }
  return out;
}

export function modelIdOf(entry: ModelEntry | null | undefined): string | null {
  return entry?.model_id ? String(entry.model_id) : null;
}

export function safeModel(entry: ModelEntry) {
  return {
    modelId: entry.model_id,
    provider: entry.provider,
    maxOutputTokens: entry.max_output_tokens,
    contextWindow: entry.context_window,
    thinkingLevels: [...selectableReasoningEfforts(entry)],
    supportsReasoning: Boolean(entry.supports_reasoning),
    // The current DSH loop has no temperature call-config seam.  Keep this
    // explicit so a future adapter must opt in before the UI exposes it.
    supportsTemperature: Boolean((entry as Loose).supports_temperature),
    ...(Number.isFinite(Number((entry as Loose).temperature_min))
      ? { temperatureMin: Number((entry as Loose).temperature_min) }
      : {}),
    ...(Number.isFinite(Number((entry as Loose).temperature_max))
      ? { temperatureMax: Number((entry as Loose).temperature_max) }
      : {}),
  };
}

export function safeMcpServers(raw: unknown): Array<{
  serverId: string;
  toolNames: string[];
}> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const output: Array<{ serverId: string; toolNames: string[] }> = [];
  for (const value of raw) {
    if (!isPlainObject(value)) continue;
    const serverId = String(value.serverId ?? value.server_id ?? value.id ?? '').trim();
    if (!SIMPLE_NAME.test(serverId) || seen.has(serverId)) continue;
    seen.add(serverId);
    const candidates = value.tools ?? value.toolNames ?? value.tool_names;
    const toolNames = Array.isArray(candidates)
      ? [...new Set(candidates.map((item) => {
          if (typeof item === 'string') return item.trim();
          return isPlainObject(item)
            ? String(item.name ?? item.toolName ?? item.tool_name ?? '').trim()
            : '';
        }).filter((name) => SIMPLE_NAME.test(name)))]
      : [];
    output.push({ serverId, toolNames });
  }
  return output;
}

export type McpReadiness = {
  /**
   * `ready`   — the process knows the full server/tool inventory.
   * `not_configured` — the deployment declares no MCP server at all.
   * `unknown` — discovery has not completed or failed; the inventory below is
   *             *not* evidence that a server or tool is absent.
   */
  readonly status: 'ready' | 'not_configured' | 'unknown';
  /**
   * 稳定原因码，供 UI 与文档映射文案。**不放进程环境变量名或连接材料**——
   * 这个 DTO 是给组织管理员看的，不是运维排障日志。
   */
  readonly reason?: 'DISCOVERY_PENDING' | 'INVENTORY_UNREADABLE' | 'NO_SERVER_DECLARED';
};

/**
 * Project the process MCP inventory *with* its readiness. An empty array and
 * "we could not ask yet" are different facts: the first authorizes nothing,
 * the second must block edits that depend on the catalog rather than be
 * rendered as an empty capability set.
 */
export function loadPlatformMcpServers(env: Record<string, string | undefined>): {
  servers: Array<{ serverId: string; toolNames: string[] }>;
  readiness: McpReadiness;
} {
  const raw = env.MCP_SERVERS_JSON;
  if (raw === undefined) {
    return { servers: [], readiness: { status: 'unknown', reason: 'DISCOVERY_PENDING' } };
  }
  if (!String(raw).trim()) {
    return { servers: [], readiness: { status: 'not_configured', reason: 'NO_SERVER_DECLARED' } };
  }
  try {
    const servers = safeMcpServers(JSON.parse(String(raw)));
    return {
      servers,
      readiness: servers.length > 0
        ? { status: 'ready' }
        : { status: 'not_configured', reason: 'NO_SERVER_DECLARED' },
    };
  } catch {
    // Startup already rejects malformed MCP_SERVERS_JSON. Here the inventory
    // is simply unknown; it must not read as "no MCP server exists".
    return { servers: [], readiness: { status: 'unknown', reason: 'INVENTORY_UNREADABLE' } };
  }
}

/**
 * 运维声明的宿主参数（`MCP_SERVERS_JSON[].hostArguments`）。启动期已拒绝非法声明；
 * 这里读不出来时返回空表——于是任何 `toolArguments` 键都报 MCP_ARGUMENT_UNKNOWN，
 * 是关闭而不是放行。
 */
export function loadHostArgumentDeclarations(env: Record<string, string | undefined>): Map<string, HostArgumentSpec> {
  try {
    const parsed = JSON.parse(String(env.MCP_SERVERS_JSON ?? '').trim() || '[]');
    return Array.isArray(parsed) ? readHostArgumentDeclarations(parsed) : new Map();
  } catch {
    return new Map();
  }
}

export function decisionsOf(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const decision = isPlainObject(raw) ? raw.decision : raw;
    const normalized = String(decision ?? '').trim().toLowerCase();
    if (normalized) out[key] = normalized;
  }
  return out;
}
