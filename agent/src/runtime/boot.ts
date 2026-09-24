/**
 * 组合根——取代 `agent/src/infrastructure/dsh/dsh-runtime-factory.js`。
 *
 * 这是什么：叠在 `@deepseek-ai/dsh-base` 之上的第 1 层组合（`src/runtime/bundle/cordis.patch.yml`），
 * 把自建 provider/策略挂载点挂到 DSH 的原生能力上。能用原生的（`dsh-tool-fs`/`dsh-compaction` 等）
 * 直接用原生；必须自建的（`ctx.fs/shell/jobs` 的 RPC 代理、`ctx.sessionPersistence` 的 MySQL 后端、
 * `ctx.subagents` 的 durable、`ctx.skills` 的启用集、memory、凭据只读 env、预算/审计/脱敏/SSE）
 * 在这里一次性注册，避免分散注册导致“同一件事两处各算一遍”。
 *
 * 为什么单独一层：`dsh-base` 是上游冻结的基线，`src/runtime/bundle/cordis.patch.yml` 的
 * patch 就在它之上增量声明——`boot()` 按 patch 顺序挂载，最后写入获胜。
 * 凭据必须在 LLM 之前就位（适配器每请求都经 `ctx.credentials.resolve(apiKeyEnv)`），
 * 因此 `EnvCredentialsProvider` 放在 `credentials` id 上直接替换 `dsh-credentials-local`。
 * LLM 适配器 `dsh-llm-deepseek` 本身不改：`baseURL`+`apiKeyEnv` 的直连由 `cordis.patch.yml`
 * 的 `llm-deepseek` 行声明，路由名固定 `deepseek-official`——命名别扭但无害，不为它写适配器。
 */

import type { Context } from '@deepseek-ai/cordis';
import { EnvCredentialsProvider } from './providers/env-credentials.js';
import { RemoteFileSystem } from './providers/remote-fs.js';
import { RemoteShell } from './providers/remote-shell.js';
import { RemoteJobs } from './providers/remote-jobs.js';
import { readExecRpcFromEnv } from './providers/exec-rpc.js';
import type { ExecRpcConfig } from './providers/exec-rpc.js';
import {
  buildMcpPatchEntries,
  buildMcpRuntimePatches,
  readMcpServersFromEnv,
} from './plugins/mcp-entries.js';
export type { ExecRpcConfig } from './providers/exec-rpc.js';
export { runWithExecRpc, readExecRpcFromEnv } from './providers/exec-rpc.js';
import {
  InMemorySessionStore,
  MysqlSessionStore,
  MysqlSessionStoreConfigError,
  readMysqlSessionStoreConfig,
  type SessionEventsCommittedHook,
  type SessionStoreOwner,
} from './providers/mysql-session-store.js';
import {
  MysqlSessionPersistence,
  SessionOwnerBindings,
} from './providers/mysql-session-persistence.js';
import type { PersistenceBackend } from '@deepseek-ai/dsh-session-persistence';

// 组合根感知全部自建 provider。策略挂载点见 runtime/policy/*（W5）。

/**
 * 供 `agent` 侧创建 DSH 运行时的最小凭证与网关校验——对应 Wave 0 的 4 探针门槛。
 *
 * 不发网络，仅校验“配置是否足以让 `dsh-llm-deepseek` 发出正确请求”：
 * - `LLMIO_API_KEY` 能否经 `ctx.credentials.resolve` 取到
 * - `LLMIO_BASE_URL` 是否为可解析的 http(s) URL（自有网关与官方网关同为 OpenAI 兼容）
 * - `defaultContextWindow` 是否在 models 目录中对每个模型可解析
 *
 * 真正的 4 探针冒烟（流式文本/归属头/工具调用/include_usage）由 `scripts/llmio-smoke.mjs`
 * 对着网关实跑；此处只做启动前的 fail-closed 校验，缺配直接起不来。
 */
export async function assertBootReady(ctx: Context): Promise<void> {
  const creds = ctx.get('credentials') as unknown as EnvCredentialsProvider | undefined;
  if (creds === undefined) throw new Error('boot: ctx.credentials not mounted (env-credentials)');
  // 只读 env 提供方：LLMIO_API_KEY 必须在环境中
  const hit = await creds.resolve('LLMIO_API_KEY' as unknown as never);
  if (hit === undefined) {
    throw new Error('boot: LLMIO_API_KEY not configured (set it in the launching environment)');
  }
  const baseURL = process.env['LLMIO_BASE_URL'] ?? process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com';
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error(`boot: LLMIO_BASE_URL is not a valid URL: ${baseURL}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`boot: LLMIO_BASE_URL must be http(s): ${baseURL}`);
  }
}

/**
 * Cordis 插件入口——仅导出凭证提供方，其余能力由 bundle patch 声明。
 * `src/runtime/bundle/cordis.patch.yml` 会把本文件的 `EnvCredentialsProvider`
 * 挂在 `credentials` id 上，从而替换 `dsh-credentials-local`。
 */
export default EnvCredentialsProvider;

export { EnvCredentialsProvider };
export { RemoteFileSystem, RemoteShell, RemoteJobs };

/** 按 Run 租户装配远程 fs/shell/jobs——本机零文件/进程，全部走 exec RPC。 */
export function createRemoteProviders(ctx: Context, config: ExecRpcConfig): {
  fs: RemoteFileSystem;
  shell: RemoteShell;
  jobs: RemoteJobs;
} {
  const existingFs = ctx.get('fs') as RemoteFileSystem | undefined;
  const existingShell = ctx.get('shell') as RemoteShell | undefined;
  const existingJobs = ctx.get('jobs') as RemoteJobs | undefined;
  if (existingFs !== undefined || existingShell !== undefined || existingJobs !== undefined) {
    if (existingFs === undefined || existingShell === undefined || existingJobs === undefined) {
      throw new Error('boot: fs/shell/jobs partially mounted; refuse a mixed local+remote tree');
    }
    return { fs: existingFs, shell: existingShell, jobs: existingJobs };
  }
  return {
    fs: new RemoteFileSystem(ctx, config),
    shell: new RemoteShell(ctx, config),
    jobs: new RemoteJobs(ctx, config),
  };
}

/**
 * 会话后端：有 MySQL 配就用真库，缺配走内存（单测/macOS）。生产启动应先
 * `readMysqlSessionStoreConfig()`，缺配抛 `MysqlSessionStoreConfigError`。
 */
export function createSessionBackend(opts?: {
  physicalRoots?: readonly string[];
  requireMysql?: boolean;
  /** DBPM 下发的口令。requireMysql 路径必填：连接串不带口令，也不回退到环境变量。 */
  password?: string | undefined;
  ownerForSession?: (sessionId: string) => SessionStoreOwner;
  currentOwner?: () => SessionStoreOwner;
  onEventsCommitted?: SessionEventsCommittedHook | undefined;
}): PersistenceBackend<string> {
  const roots = opts?.physicalRoots ?? [];
  if (opts?.requireMysql === true) {
    if (opts.password === undefined) {
      throw new Error('boot: session store requires the DBPM-issued MySQL password');
    }
    const cfg = { ...readMysqlSessionStoreConfig(), password: opts.password };
    return new MysqlSessionStore(cfg, {
      physicalRoots: roots,
      ownerForSession: opts.ownerForSession,
      currentOwner: opts.currentOwner,
      onEventsCommitted: opts.onEventsCommitted,
    });
  }
  try {
    const cfg = readMysqlSessionStoreConfig();
    return new MysqlSessionStore(cfg, {
      physicalRoots: roots,
      ownerForSession: opts?.ownerForSession,
      currentOwner: opts?.currentOwner,
      onEventsCommitted: opts?.onEventsCommitted,
    });
  } catch (err) {
    if (err instanceof MysqlSessionStoreConfigError) {
      return new InMemorySessionStore();
    }
    throw err;
  }
}

/** Mount the one process-wide DSH persistence service; every session bind stays owner-scoped. */
export function mountSessionPersistence(
  ctx: Context,
  opts: {
    physicalRoots?: readonly string[];
    requireMysql?: boolean;
    password?: string | undefined;
    /** 会话事件提交之后的观察者（application 的会话标题投影）。只在首次挂载时生效。 */
    onEventsCommitted?: SessionEventsCommittedHook | undefined;
  } = {},
): MysqlSessionPersistence {
  let existing: MysqlSessionPersistence | undefined;
  try {
    existing = ctx.get('sessionPersistence') as MysqlSessionPersistence | undefined;
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (typeof existing.bindOwner !== 'function' || typeof existing.has !== 'function') {
      throw new Error('boot: unexpected sessionPersistence provider is already mounted');
    }
    return existing;
  }
  let sessions: { list?: unknown } | undefined;
  try {
    sessions = ctx.get('sessions') as { list?: unknown } | undefined;
  } catch {
    sessions = undefined;
  }
  if (typeof sessions?.list !== 'function') {
    throw new Error('boot: ctx.sessions must be mounted before sessionPersistence');
  }
  const bindings = new SessionOwnerBindings();
  const backend = createSessionBackend({
    physicalRoots: opts.physicalRoots,
    requireMysql: opts.requireMysql,
    password: opts.password,
    ownerForSession: (sessionId) => bindings.ownerForSession(sessionId),
    currentOwner: () => bindings.currentOwner(),
    onEventsCommitted: opts.onEventsCommitted,
  });
  return new MysqlSessionPersistence(ctx, backend, bindings);
}

/**
 * 叠 dsh-base + 本包 overlay，返回已结算的 Cordis 根上下文。
 * `ctx.agents.create()` 之后才能开一轮真正的 DSH turn。
 */
export function readProcessExecRpcConfig(env: NodeJS.ProcessEnv = process.env): ExecRpcConfig {
  return readExecRpcFromEnv(env);
}


/**
 * 校验 overlay patch 里每个 `name` 引用的文件真的存在。
 *
 * **为什么必须有这一条**：cordis 的 patch 在插件加载失败时不报错——它只是
 * 不替换那个 id，于是出厂实现留在原位。2026-08-30 发现 `credentials` 与
 * `subagent-spawn-in-process` 两行写的是 `../src/providers/*.js`（源码是 .ts，
 * 该文件不存在），结果 `ctx.credentials` 是出厂的 `LocalCredentialProvider`
 * ——正是 ADR 0007「必须从出厂组合中移除的行」点名不得组合的那个。
 * 这个错误能活下来，唯一原因就是没有任何人报错。
 *
 * 所以这里 **fail-closed**：路径解析不到就直接抛，让进程起不来。
 *
 * `name` 相对 patch 文件所在目录解析（cordis 的 `bareModuleBaseUrl` 语义），
 * 裸模块名（不以 `.` 开头）交给 Node 解析，不在这里判定。
 *
 * **`.js` 也接受同名 `.ts`**：源码是 TS，产物是 JS，patch 里写的一律是运行时
 * 路径（`.js`）。从 dist 启动时物理文件就是 `.js`；从源码启动（tsx / dev）时
 * tsx 会把 `.js` 解析到同名 `.ts`，此时物理上只有 `.ts`。只认 `.js` 会让
 * 从源码启动必然误报——而这一条的目的是抓「插件路径写错」，不是抓「你在跑源码」。
 */
export function assertOverlayPatchResolvable(
  patchFile: string,
  entries: readonly unknown[],
  fileExists: (p: string) => boolean,
): void {
  const bad: string[] = [];
  const visit = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object') return;
    const rec = entry as Record<string, unknown>;
    const inserted = rec['insert'];
    if (Array.isArray(inserted)) for (const child of inserted) visit(child);
    const name = rec['name'];
    if (typeof name !== 'string' || !name.startsWith('.')) return;
    const resolved = resolvePathRelativeTo(patchFile, name);
    const tsSibling = resolved.endsWith('.js')
      ? `${resolved.slice(0, -3)}.ts`
      : null;
    if (!fileExists(resolved) && !(tsSibling && fileExists(tsSibling))) {
      bad.push(`${String(rec['id'] ?? '<no id>')} → ${name}`);
    }
  };
  for (const entry of entries) visit(entry);
  if (bad.length > 0) {
    throw new Error(
      'boot: cordis overlay patch references files that do not exist ' +
        `(plugins would silently fall back to the factory implementation): ${bad.join(', ')}`,
    );
  }
}

/** patch 文件所在目录 + 相对路径。抽出来只为可单测。 */
export function resolvePathRelativeTo(patchFile: string, relative: string): string {
  const dir = patchFile.slice(0, Math.max(0, patchFile.lastIndexOf('/')));
  const segments = `${dir}/${relative}`.split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

/**
 * 进程内**唯一**的那棵插件树。
 *
 * 为什么要记忆化在这里而不是各自 memo：boot 一次要装 130+ 个插件、连 MCP
 * 服务器。2026-08-31 之前 `runtime-factory` 自己 memo 了一份（`bootOnce`），
 * 而 MCP 就绪度那条路走的是另一套 adapter 探测——同一件事两处各算一遍，
 * 且两边看到的工具面可能不一致。收敛到这里之后，「模型看得见什么」只有一个答案。
 */
let sharedCtx: Promise<Context> | null = null;

export function sharedEnterpriseRuntime(): Promise<Context> {
  if (sharedCtx === null) sharedCtx = bootEnterpriseRuntime();
  return sharedCtx;
}

/** 单台 MCP server 的就绪投影（蛇形字段，/ready 与诊断端点共用）。 */
export interface McpServerReadinessProjection {
  server_id: string;
  connection_status: 'connected' | 'unavailable';
  tools: string[];
}

export interface McpReadinessProjection {
  ready: boolean;
  serverCount: number;
  toolCount: number;
  servers: McpServerReadinessProjection[];
}

/** 插件树注册表里现有的全部工具名。 */
function registeredToolNames(ctx: Context): string[] {
  const tools = (ctx as unknown as { get(n: string): any }).get('tools');
  return tools === undefined || typeof tools.schemas !== 'function'
    ? []
    : tools.schemas().map((s: { name?: unknown }) => String(s?.name ?? ''));
}

/**
 * 启用的 MCP 配置清单 × 当前工具注册表 → 就绪投影（K8s 部署评审 K2，2026-09-19）。
 *
 * 出厂 `dsh-mcp-client` 不对外暴露逐台连接状态，它能观察到的事实只有「注册表里
 * 有没有这台的工具」：连上并完成 `tools/list` 才会注册；启动失败（默认
 * `failOnStartupError: false`）或重连预算耗尽后工具被注销。所以：
 *
 * - 已启用且有工具 → `connected`；
 * - 已启用但没有工具（连不上、引用的 env 缺失被跳过、预算耗尽）→ `unavailable`，
 *   **保留在清单里**，不能因为没工具就当成「没配置」；
 * - 任何一台 `unavailable` → `ready: false`（deployment.md 的 /ready 契约）。
 *
 * 已知盲区：重连期间出厂保留上一代工具，这段时间仍报 `connected`；一台真的
 * 只暴露零个工具的服务器会被报成 `unavailable`。
 */
export function projectMcpReadiness(
  toolNames: readonly string[],
  configuredServerIds: readonly string[],
): McpReadinessProjection {
  const byServer = new Map<string, string[]>();
  for (const name of toolNames) {
    if (!name.startsWith('mcp__')) continue;
    const rest = name.slice('mcp__'.length);
    const sep = rest.indexOf('__');
    if (sep <= 0) continue;
    const server = rest.slice(0, sep);
    const list = byServer.get(server) ?? [];
    list.push(rest.slice(sep + 2));
    byServer.set(server, list);
  }

  const ids = [...new Set([...configuredServerIds, ...byServer.keys()])].sort();
  const servers = ids.map((server_id): McpServerReadinessProjection => {
    const list = (byServer.get(server_id) ?? []).sort();
    return {
      server_id,
      connection_status: list.length > 0 ? 'connected' : 'unavailable',
      tools: list,
    };
  });

  return {
    ready: servers.every((server) => server.connection_status === 'connected'),
    serverCount: servers.length,
    toolCount: servers.reduce((n, s) => n + s.tools.length, 0),
    servers,
  };
}

/** `MCP_SERVERS_JSON` 里启用的 serverName（与 boot 叠进插件树的是同一份生成逻辑）。 */
export function configuredMcpServerIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return buildMcpPatchEntries(readMcpServersFromEnv(env)).map((entry) =>
    String((entry.config as { serverName?: unknown } | undefined)?.serverName ?? entry.id),
  );
}

/**
 * 起（或复用）插件树后，返回一个**每次调用都重读注册表**的同步投影函数。
 *
 * /ready 走这里：MCP 服务器恢复、重连预算耗尽、`tools/list_changed` 都直接反映，
 * 不再停留在启动那一刻的快照上；也不另起一套连接管理器——事实源仍是 DSH 注册表。
 */
export async function createMcpReadinessReader(
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => McpReadinessProjection> {
  const ctx = await sharedEnterpriseRuntime();
  const configured = configuredMcpServerIds(env);
  return () => projectMcpReadiness(registeredToolNames(ctx), configured);
}

/** 读一次 MCP 就绪度（ADR 0009 D9 §「/ready」/ 计划 H7.6）。 */
export async function readMcpReadiness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpReadinessProjection> {
  return (await createMcpReadinessReader(env))();
}

export async function bootEnterpriseRuntime(
  rpc: ExecRpcConfig = readProcessExecRpcConfig(),
): Promise<Context> {
  const { boot, loadOverlayPatches } = await import('@deepseek-ai/dsh-app-boot');
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const require = createRequire(import.meta.url);
  const basePatchFile = require.resolve('@deepseek-ai/dsh-base/cordis.patch.yml');
  const here = dirname(fileURLToPath(import.meta.url));
  const overlayFile = join(here, 'bundle/cordis.patch.yml');
  const emptyConfig = join(here, 'bundle/cordis.yml');
  const { existsSync } = await import('node:fs');
  const overlayPatches = loadOverlayPatches('dsh-runtime', overlayFile);
  // fail-closed：本包 patch 里引用不到的文件会让插件静默退回出厂实现。
  assertOverlayPatchResolvable(overlayFile, overlayPatches, existsSync);
  // MCP 按进程环境叠，不进提交的 YAML（镜像构建时 MCP_SERVERS_JSON 是空的）。
  const mcpPatches = buildMcpRuntimePatches();
  const patches = [
    ...loadOverlayPatches('dsh-runtime', basePatchFile),
    ...overlayPatches,
    // PatchEntry.insert 是 readonly；boot 要的 PatchOptions.insert 是可变数组。
    ...(mcpPatches as unknown as ReturnType<typeof loadOverlayPatches>),
  ];
  const bareModuleBaseUrl = pathToFileURL(join(here, '../')).href;
  void rpc;
  return boot('dsh-runtime', emptyConfig, patches, undefined, bareModuleBaseUrl);
}
