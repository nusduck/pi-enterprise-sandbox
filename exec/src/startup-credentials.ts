/**
 * exec 启动取密（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）。
 *
 * exec 只取 UPDRDB 口令。replay Redis 已无消费方（`SANDBOX_INTERNAL_REDIS_URL` 没有
 * 任何代码读取），不为它取密。sandbox-mcp 的取密在 `mcp/startup-credentials.ts`：
 * facade 入口不能依赖本文件引入的 `db/` 模块。
 *
 * 连接配置里带口令直接拒绝，`DBPM_URL` 缺失直接拒绝——没有环境变量口令回退。
 */

import {
  DbpmConfigError,
  fetchDbpmCredentials,
  readDbpmSettings,
  type FetchDbpmCredentialsOptions,
} from '@dsh/contract/dbpm-config.js';
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
