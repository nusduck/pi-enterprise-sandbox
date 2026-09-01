/**
 * `MCP_SERVERS_JSON` → 每个 server 一条 `@deepseek-ai/dsh-mcp-client` patch 条目
 * （ADR 0009 D9 / 计划 H7.1）。
 *
 * ## 为什么是 host 组合而不是 per-Run 装配
 *
 * 官方 `dsh` / `dsh web` 就是这么加载 MCP 的：`cordis.yml` 里一个 MCP server
 * 一个插件实例。AgentVersion 之间的差异不靠「装配不同的插件集」，而靠
 * **逐调用闸门**（`tools/pre-execute` / `ctx.tools.guard()`）与**可见性收窄**
 * （`ctx.tools.restrict()`，H0.4 已确认存在）——ADR 0009 D3 的「host 挂全量 +
 * 按 Run 过滤」。
 *
 * ## 密钥只走 env 占位符
 *
 * `buildMcpPatchEntries` 仍产出 `!!js:env:` / `!!js:bearer:` 占位符，给 YAML
 * 生成与密钥断言用。真正装进插件树的是 `buildMcpRuntimePatches()`：boot 时
 * 按 `MCP_SERVERS_JSON` 求值，明文只存在于进程内存。
 */
import type { PatchEntry } from './manifest.js';

/** `MCP_SERVERS_JSON` 的一条（与 `mcp-server-registry.ts` 的 `McpServerRecord` 同形）。 */
export interface McpServerInput {
  readonly serverId?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly enabled?: unknown;
  readonly url?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly cwd?: unknown;
  readonly transport?: unknown;
  readonly timeoutMs?: unknown;
  readonly authTokenRef?: unknown;
  readonly envRefs?: unknown;
  readonly headerRefs?: unknown;
}

/**
 * 出厂对 `serverName` 的约束：`[A-Za-z0-9_-]{1,32}`。
 *
 * 我们的 `serverId` 允许 `.`（`[A-Za-z0-9._-]+`），所以两者不是一回事。
 * **不做静默转换**——`a.b` 与 `a-b` 悄悄映射到同一个 `serverName` 会让两台服务器
 * 的工具挤进同一个命名空间，而症状只是「工具莫名其妙少了几个」。直接拒。
 */
function assertServerName(serverId: string): void {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverId)) {
    throw new Error(
      `MCP serverId "${serverId}" cannot be used as a dsh-mcp-client serverName: ` +
        'it must match [A-Za-z0-9_-]{1,32}. Rename the server rather than letting ' +
        'two ids collapse into one tool namespace.',
    );
  }
}

function refMap(raw: unknown, kind: 'env' | 'bearer'): Record<string, string> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, ref] of Object.entries(raw as Record<string, unknown>)) {
    const name = String(ref ?? '').trim();
    if (name === '') continue;
    out[key] = `!!js:${kind}:${name}`;
  }
  return out;
}

/**
 * 生成 patch 条目。**只收 `enabled !== false` 的**：一台被显式停用的服务器
 * 不该在 boot 时就去连。
 */
export function buildMcpPatchEntries(servers: readonly McpServerInput[]): PatchEntry[] {
  const entries: PatchEntry[] = [];
  const seen = new Set<string>();

  for (const server of servers) {
    if (server.enabled === false) continue;
    const serverId = String(server.serverId ?? server.id ?? server.name ?? '').trim();
    if (serverId === '') continue;
    assertServerName(serverId);
    if (seen.has(serverId)) {
      // 出厂对重复 serverName 的处理是「后一个插件实例加载失败」——那是运行时
      // 才发现的。这里提前拒，错误消息也说得清是哪一台。
      throw new Error(`duplicate MCP serverId in MCP_SERVERS_JSON: ${serverId}`);
    }
    seen.add(serverId);

    const url = String(server.url ?? '').trim();
    const command = String(server.command ?? '').trim();
    const transport =
      String(server.transport ?? '').trim() || (command !== '' ? 'stdio' : 'streamable-http');

    const config: Record<string, unknown> = { serverName: serverId, transport };
    if (transport === 'stdio') {
      if (command === '') {
        throw new Error(`MCP server "${serverId}" uses stdio transport but has no command`);
      }
      config['command'] = command;
      if (Array.isArray(server.args) && server.args.length > 0) {
        config['args'] = server.args.map(String);
      }
      const cwd = String(server.cwd ?? '').trim();
      if (cwd !== '') config['cwd'] = cwd;
      const env = refMap(server.envRefs, 'env');
      if (Object.keys(env).length > 0) config['env'] = env;
    } else {
      if (url === '') {
        throw new Error(`MCP server "${serverId}" uses ${transport} transport but has no url`);
      }
      config['url'] = url;
      const headers = refMap(server.headerRefs, 'env');
      const authTokenRef = String(server.authTokenRef ?? '').trim();
      if (authTokenRef !== '') headers['Authorization'] = `!!js:bearer:${authTokenRef}`;
      if (Object.keys(headers).length > 0) config['headers'] = headers;
    }

    const timeoutMs = Number(server.timeoutMs);
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) config['toolCallTimeoutMs'] = timeoutMs;

    // `failOnStartupError` 保持出厂默认 false：一台 MCP 服务器连不上不该让整个
    // Agent 起不来。连接失败会被记日志，那台的工具就是不存在——而不存在的工具
    // 在 fail-closed 分类器下本来就调不动。
    entries.push({ id: `mcp-${serverId}`, name: '@deepseek-ai/dsh-mcp-client', config });
  }

  return entries;
}

/**
 * 把生成条目里的 `!!js:env:` / `!!js:bearer:` 占位符换成进程里的真实值。
 *
 * YAML 路径靠 dsh-app-boot 的 `!!js` 标签在加载时求值；boot 时直接插
 * JS 对象没有这条路径，必须在这里解析。引用的环境变量为空则跳过那台
 * 服务器（fail-closed 关能力，不让整个 Agent 起不来）。
 */
function resolveJsPlaceholder(
  value: unknown,
  env: NodeJS.ProcessEnv,
): { ok: true; value: unknown } | { ok: false; missing: string } {
  if (typeof value !== 'string') return { ok: true, value };
  if (value.startsWith('!!js:env:')) {
    const name = value.slice('!!js:env:'.length);
    const resolved = env[name];
    if (resolved == null || resolved === '') return { ok: false, missing: name };
    return { ok: true, value: resolved };
  }
  if (value.startsWith('!!js:bearer:')) {
    const name = value.slice('!!js:bearer:'.length);
    const resolved = env[name];
    if (resolved == null || resolved === '') return { ok: false, missing: name };
    return { ok: true, value: `Bearer ${resolved}` };
  }
  return { ok: true, value };
}

function resolveConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = resolveConfig(value as Record<string, unknown>, env);
      if (nested === null) return null;
      out[key] = nested;
      continue;
    }
    const hit = resolveJsPlaceholder(value, env);
    if (hit.ok === false) {
      console.error(`[agent-mcp] skipping MCP server: env ${hit.missing} is not set`);
      return null;
    }
    out[key] = hit.value;
  }
  return out;
}

/**
 * 进程启动时按 `MCP_SERVERS_JSON` 生成要叠进 overlay 的 patch。
 *
 * 不写进 `cordis.patch.yml`：那份 YAML 是提交物，Docker 镜像构建时环境是空的，
 * 运维在 compose `.env` 里配的服务器永远进不了插件树——症状就是模型看不见
 * `mcp__*` 工具，`/ready` 报 `server_count: 0`。
 */
export function buildMcpRuntimePatches(env: NodeJS.ProcessEnv = process.env): PatchEntry[] {
  const entries = buildMcpPatchEntries(readMcpServersFromEnv(env));
  const insert: PatchEntry[] = [];
  for (const entry of entries) {
    const raw = entry.config && typeof entry.config === 'object' ? { ...entry.config } : {};
    const config = resolveConfig(raw, env);
    if (config === null) continue;
    insert.push({ id: entry.id, name: entry.name, config });
  }
  if (insert.length === 0) return [];
  return [{ insert }];
}

/** 解析 `MCP_SERVERS_JSON`；空/缺省返回空数组，坏 JSON fail-closed。 */
export function readMcpServersFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerInput[] {
  const raw = String(env['MCP_SERVERS_JSON'] ?? '').trim();
  if (raw === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid MCP_SERVERS_JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('Invalid MCP_SERVERS_JSON: must be an array');
  return parsed as McpServerInput[];
}
