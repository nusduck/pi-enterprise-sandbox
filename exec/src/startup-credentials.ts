/**
 * exec / sandbox-mcp 启动取密（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）。
 *
 * - exec 只取 UPDRDB 口令。replay Redis 已无消费方（`SANDBOX_INTERNAL_REDIS_URL` 没有
 *   任何代码读取），不为它取密。
 * - sandbox-mcp 只取服务 Redis 口令；它是对外 facade，拿不到 UPDRDB 口令。
 *
 * 连接配置里带口令直接拒绝，`DBPM_URL` 缺失直接拒绝——没有环境变量口令回退。
 */

import {
  assertUrlWithoutPassword,
  DbpmConfigError,
  fetchDbpmCredentials,
  readDbpmSettings,
  type FetchDbpmCredentialsOptions,
} from '@pi/contract/dbpm-config.js';
import { ExecDbConfigError, type ExecDbConfig } from './db/client.js';

type FetchOptions = Omit<FetchDbpmCredentialsOptions, 'process'>;

/**
 * 取 exec 的 UPDRDB 口令。数据库根本没配时返回 `undefined`，由装配层按部署环境决定
 * 是拒绝启动（production）还是使用内存仓储（开发）——那里不涉及口令。
 */
export async function resolveExecDbPassword(
  env: NodeJS.ProcessEnv,
  readConfig: (env: NodeJS.ProcessEnv) => ExecDbConfig,
  opts: FetchOptions = {},
): Promise<string | undefined> {
  let cfg: ExecDbConfig;
  try {
    cfg = readConfig(env);
  } catch (err) {
    if (err instanceof ExecDbConfigError) return undefined;
    throw err;
  }
  assertExecDbConfigWithoutPassword(cfg);
  const settings = readDbpmSettings(env, ['updrdb']);
  if (cfg.user !== settings.entries.updrdb?.userName) {
    throw new DbpmConfigError('exec database user does not match the DBPM credential user');
  }
  const credentials = await fetchDbpmCredentials(settings, ['updrdb'], { ...opts, process: 'exec' });
  return credentials.updrdb;
}

/** 装配层与取密层共用：配置里出现口令即拒绝。 */
export function assertExecDbConfigWithoutPassword(cfg: ExecDbConfig): void {
  if (cfg.password !== '') {
    throw new DbpmConfigError(
      'exec database config must not embed a password; credentials come from DBPM',
    );
  }
}

/** 取 sandbox-mcp 的服务 Redis 口令。 */
export async function resolveMcpRedisPassword(
  env: NodeJS.ProcessEnv,
  redisUrl: string,
  opts: FetchOptions = {},
): Promise<string> {
  assertUrlWithoutPassword(redisUrl, 'SANDBOX_MCP_REDIS_URL');
  const settings = readDbpmSettings(env, ['redis']);
  const credentials = await fetchDbpmCredentials(settings, ['redis'], { ...opts, process: 'sandbox-mcp' });
  if (credentials.redis === undefined) {
    throw new DbpmConfigError('DBPM redis credential missing');
  }
  return credentials.redis;
}
