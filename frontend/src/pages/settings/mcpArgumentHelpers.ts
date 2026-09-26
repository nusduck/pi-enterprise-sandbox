/**
 * MCP「平台参数」的纯函数：读写 `mcpServers[i].toolArguments`，并按
 * `config/options` 的 `platformConstraints.mcpServers[].hostArguments` 投影输入行
 * （docs/design/mcp-per-agent-arguments.md §5）。
 *
 * 服务端仍是语义权威：键是否已被运维声明、值的类型由 agent 校验；这里只保证
 * 草稿里的每个键都有一行落点，不被静默丢弃。
 */
import { cloneAgentConfig } from './agentHelpers';

export type HostArgumentDecl = { name: string; description: string };

export type HostArgumentRow = HostArgumentDecl & {
  value: string;
  /** 草稿里有、当前登记表没有声明：只能移除。 */
  stale: boolean;
};

type ArgumentValue = string | number | boolean;

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function serverIdOf(value: unknown): string {
  const entry = plainObject(value);
  return String(entry?.serverId ?? entry?.server_id ?? entry?.id ?? entry?.name ?? '').trim();
}

/** 某台 server 声明的宿主参数；options 缺失或形状不对时为空。 */
export function hostArgumentsFor(
  platformConstraints: Record<string, unknown> | undefined,
  serverId: string,
): HostArgumentDecl[] {
  const servers = platformConstraints?.mcpServers;
  if (!Array.isArray(servers)) return [];
  const server = servers.map(plainObject).find((item) => serverIdOf(item) === serverId);
  const raw = server?.hostArguments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const entry = plainObject(item);
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (!name) return [];
    return [{ name, description: typeof entry?.description === 'string' ? entry.description : '' }];
  });
}

export function toolArgumentsOf(config: Record<string, unknown>, serverId: string): Record<string, unknown> {
  if (!Array.isArray(config.mcpServers)) return {};
  const entry = config.mcpServers.map(plainObject).find((item) => serverIdOf(item) === serverId);
  return plainObject(entry?.toolArguments) ?? {};
}

/** 结构不对时暂停编辑，让用户去 JSON 修，而不是覆盖掉原值。 */
export function toolArgumentsIssue(config: Record<string, unknown>, serverId: string): string | null {
  if (!Array.isArray(config.mcpServers)) return null;
  const entry = config.mcpServers.map(plainObject).find((item) => serverIdOf(item) === serverId);
  if (entry?.toolArguments == null || plainObject(entry.toolArguments)) return null;
  return `mcpServers(${serverId}).toolArguments must be an object`;
}

/** 声明的参数按声明顺序在前，草稿里多出来的键作为「已保留」行排在后面。 */
export function hostArgumentRows(declared: readonly HostArgumentDecl[], current: Record<string, unknown>): HostArgumentRow[] {
  const known = new Set(declared.map((item) => item.name));
  const rows: HostArgumentRow[] = declared.map((item) => ({
    ...item,
    value: current[item.name] == null ? '' : String(current[item.name]),
    stale: false,
  }));
  for (const [name, value] of Object.entries(current)) {
    if (!known.has(name)) rows.push({ name, description: '', value: value == null ? '' : String(value), stale: true });
  }
  return rows;
}

/**
 * 输入框文本 → 保存的值。保持原值的类型：原来是数字或布尔、输入仍能解析成同类型时
 * 照原类型保存，否则按字符串——类型不符由运行期按工具 schema 报错。
 */
export function argumentValueFromInput(text: string, previous: unknown): ArgumentValue | undefined {
  if (text === '') return undefined;
  if (typeof previous === 'number' && text.trim() !== '' && Number.isFinite(Number(text))) return Number(text);
  if (typeof previous === 'boolean' && (text === 'true' || text === 'false')) return text === 'true';
  return text;
}

/** 改一个参数；`undefined` 删键，空对象删掉整个 `toolArguments`。只动已选中的那台 server。 */
export function setToolArgument(
  config: Record<string, unknown>,
  serverId: string,
  name: string,
  value: ArgumentValue | undefined,
): Record<string, unknown> {
  if (!Array.isArray(config.mcpServers) || toolArgumentsIssue(config, serverId)) return cloneAgentConfig(config);
  const next = cloneAgentConfig(config);
  next.mcpServers = (next.mcpServers as unknown[]).map((raw) => {
    if (serverIdOf(raw) !== serverId) return raw;
    const entry = { ...(plainObject(raw) ?? { serverId }) };
    const args = { ...(plainObject(entry.toolArguments) ?? {}) };
    if (value === undefined) delete args[name];
    else args[name] = value;
    if (Object.keys(args).length) entry.toolArguments = args;
    else delete entry.toolArguments;
    return entry;
  });
  return next;
}
