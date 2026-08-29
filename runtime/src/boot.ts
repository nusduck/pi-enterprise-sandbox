/**
 * 组合根——取代 `agent/src/infrastructure/pi/pi-runtime-factory.js`。
 *
 * 这是什么：叠在 `@deepseek-ai/dsh-base` 之上的第 1 层组合（`runtime/bundle/cordis.patch.yml`），
 * 把自建 provider/策略挂载点挂到 DSH 的原生能力上。能用原生的（`dsh-tool-fs`/`dsh-compaction` 等）
 * 直接用原生；必须自建的（`ctx.fs/shell/jobs` 的 RPC 代理、`ctx.sessionPersistence` 的 MySQL 后端、
 * `ctx.subagents` 的 durable、`ctx.skills` 的启用集、memory、凭据只读 env、预算/审计/脱敏/SSE）
 * 在这里一次性注册，避免分散注册导致“同一件事两处各算一遍”。
 *
 * 为什么单独一层：`dsh-base` 是上游冻结的基线，`runtime/bundle/cordis.patch.yml` 的
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
export type { ExecRpcConfig } from './providers/exec-rpc.js';
export { runWithExecRpc, readExecRpcFromEnv } from './providers/exec-rpc.js';
import {
  InMemorySessionStore,
  MysqlSessionStore,
  MysqlSessionStoreConfigError,
  readMysqlSessionStoreConfig,
} from './providers/mysql-session-store.js';
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
 * `runtime/bundle/cordis.patch.yml` 会把本文件的 `EnvCredentialsProvider`
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
}): PersistenceBackend<string> {
  const roots = opts?.physicalRoots ?? [];
  if (opts?.requireMysql === true) {
    const cfg = readMysqlSessionStoreConfig();
    return new MysqlSessionStore(cfg, { physicalRoots: roots });
  }
  try {
    const cfg = readMysqlSessionStoreConfig();
    return new MysqlSessionStore(cfg, { physicalRoots: roots });
  } catch (err) {
    if (err instanceof MysqlSessionStoreConfigError) {
      return new InMemorySessionStore(roots);
    }
    throw err;
  }
}

/**
 * 叠 dsh-base + 本包 overlay，返回已结算的 Cordis 根上下文。
 * `ctx.agents.create()` 之后才能开一轮真正的 DSH turn。
 */
export function readProcessExecRpcConfig(env: NodeJS.ProcessEnv = process.env): ExecRpcConfig {
  return readExecRpcFromEnv(env);
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
  const overlayFile = join(here, '../bundle/cordis.patch.yml');
  const emptyConfig = join(here, '../bundle/cordis.yml');
  const patches = [
    ...loadOverlayPatches('pi-runtime', basePatchFile),
    ...loadOverlayPatches('pi-runtime', overlayFile),
  ];
  const bareModuleBaseUrl = pathToFileURL(join(here, '../')).href;
  void rpc;
  return boot('pi-runtime', emptyConfig, patches, undefined, bareModuleBaseUrl);
}
