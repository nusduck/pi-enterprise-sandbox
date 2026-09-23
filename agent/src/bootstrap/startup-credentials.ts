/**
 * Agent / Agent Worker 启动取密（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）。
 *
 * 顺序：校验配置 → 校验连接串不夹口令、用户名与 DBPM 条目一致 → 按需向 DBPM 取
 * UPDRDB / 服务 Redis 口令 → 交给容器建连。任何一步失败都让启动失败。
 *
 * **没有环境变量口令回退**：连接串里带口令直接拒绝；`DBPM_URL` 缺失直接拒绝。
 * 口令只存在于返回值（容器内存），不写 `process.env`、不打印。
 */

import {
  assertUrlUser,
  assertUrlWithoutPassword,
  fetchDbpmCredentials,
  readDbpmSettings,
  type DbpmCredentialRole,
  type FetchDbpmCredentialsOptions,
} from '@dsh/contract/dbpm-config.js';
import { resolveMysqlUrlFromEnv, resolveRedisUrlFromEnv } from './container-env.js';

export interface AgentCredentials {
  readonly mysql?: string | undefined;
  readonly redis?: string | undefined;
}

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

export async function resolveAgentCredentials(
  env: EnvLike,
  need: { readonly mysql: boolean; readonly redis: boolean },
  opts: Omit<FetchDbpmCredentialsOptions, 'process'> = {},
): Promise<AgentCredentials> {
  const roles: DbpmCredentialRole[] = [];
  if (need.mysql) roles.push('updrdb');
  if (need.redis) roles.push('redis');
  if (roles.length === 0) return {};

  const settings = readDbpmSettings(env, roles);
  if (need.mysql) {
    const url = resolveMysqlUrlFromEnv(env) ?? '';
    assertUrlWithoutPassword(url, 'AGENT_DATABASE_URL');
    assertUrlUser(url, 'AGENT_DATABASE_URL', settings.entries.updrdb?.userName ?? '');
  }
  if (need.redis) {
    assertUrlWithoutPassword(resolveRedisUrlFromEnv(env) ?? '', 'AGENT_REDIS_URL');
  }

  const credentials = await fetchDbpmCredentials(settings, roles, { ...opts, process: 'agent' });
  return { mysql: credentials.updrdb, redis: credentials.redis };
}
