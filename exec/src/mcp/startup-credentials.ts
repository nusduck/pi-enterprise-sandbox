/**
 * sandbox-mcp 启动取密（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）。
 *
 * facade 只取服务 Redis 口令；它是对外进程，拿不到 UPDRDB 口令。
 *
 * 单独成文件而不是和 exec 的取密放在一起：facade 入口的 import 图里不能出现
 * `db/`、`mysql2` 等执行面模块（slim 镜像不带它们，`mcp-import-boundary` 测试守着）。
 */

import {
  assertUrlWithoutPassword,
  DbpmConfigError,
  fetchDbpmCredentials,
  readDbpmSettings,
  type FetchDbpmCredentialsOptions,
} from '@dsh/contract/dbpm-config.js';

type FetchOptions = Omit<FetchDbpmCredentialsOptions, 'process'>;

/** 取 sandbox-mcp 的服务 Redis 口令。连接串里带口令或 `DBPM_URL` 缺失直接拒绝。 */
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
