/**
 * DBPM 取密的配置与启动顺序约束（design `updrdb-dbpm-deployment.md` §7，ADR 0011 D10）。
 *
 * 为什么和 `dbpm.ts` 分开：那边只管「按协议取一个口令」；这里管「一个进程该取哪几个、
 * 配置从哪来、连接串里不许夹口令」。Agent、Agent Worker、exec、sandbox-mcp 四个入口
 * 共用同一套规则，所以放契约包；这里不读驱动、不建连接。
 *
 * 规则：
 * - **没有环境变量口令回退**。`DBPM_URL` 或角色条目缺失即拒绝启动；连接串里带口令
 *   也拒绝启动——否则「忘了接 DBPM」会被一个能用的明文口令悄悄掩盖。
 * - 每个进程只声明自己需要的角色；sandbox-mcp 只取 Redis，拿不到 UPDRDB 口令。
 * - 数据库连接串的用户名必须与 DBPM 条目的用户名一致，不静默覆盖。
 * - 口令只返回给调用方的内存，不写 `process.env`、不落盘、不打印。
 */

import {
  EndpointConfigError,
  parseEndpointList,
  type Endpoint,
} from './endpoint-failover.js';
import { fetchDbpmPassword, type DbpmEntry, type FetchDbpmPasswordOptions } from './dbpm.js';

/** 目前有消费方的两类凭据。replay Redis 已无消费方，不在此列。 */
export type DbpmCredentialRole = 'updrdb' | 'redis';

export class DbpmConfigError extends Error {
  override name = 'DbpmConfigError';
}

const ROLE_ENV: Readonly<Record<DbpmCredentialRole, { readonly db: string; readonly user: string }>> = {
  updrdb: { db: 'DBPM_DB_NAME', user: 'DBPM_DB_USER_NAME' },
  redis: { db: 'DBPM_REDIS_DB_NAME', user: 'DBPM_REDIS_DB_USER_NAME' },
};

export interface DbpmSettings {
  readonly endpoints: readonly Endpoint[];
  readonly entries: Readonly<Partial<Record<DbpmCredentialRole, DbpmEntry>>>;
}

type EnvLike = Readonly<Record<string, string | undefined>>;

/** 读 `DBPM_URL`（恰好两个 host:port）与所需角色的条目。缺任何一项都抛 `DbpmConfigError`。 */
export function readDbpmSettings(env: EnvLike, roles: readonly DbpmCredentialRole[]): DbpmSettings {
  let endpoints: Endpoint[];
  try {
    endpoints = parseEndpointList(env['DBPM_URL'], { name: 'DBPM_URL', count: 2 });
  } catch (err) {
    throw new DbpmConfigError(
      err instanceof EndpointConfigError ? err.message : 'DBPM_URL is invalid',
    );
  }
  const entries: Partial<Record<DbpmCredentialRole, DbpmEntry>> = {};
  for (const role of roles) {
    const names = ROLE_ENV[role];
    const dbName = String(env[names.db] ?? '').trim();
    const userName = String(env[names.user] ?? '').trim();
    const missing = [dbName === '' ? names.db : null, userName === '' ? names.user : null].filter(Boolean);
    if (missing.length > 0) {
      throw new DbpmConfigError(`${missing.join(' and ')} required for DBPM ${role} credentials`);
    }
    entries[role] = { dbName, userName };
  }
  return { endpoints, entries };
}

function parseUrl(raw: string, name: string): URL {
  try {
    return new URL(raw);
  } catch {
    // 不回显原串：它可能恰好就是带口令的那个。
    throw new DbpmConfigError(`${name} is not a valid URL`);
  }
}

/**
 * 连接串里不许带口令：凭据只来自 DBPM。命中时的错误不含口令，也不含原串。
 */
export function assertUrlWithoutPassword(raw: string, name: string): void {
  if (parseUrl(raw, name).password !== '') {
    throw new DbpmConfigError(`${name} must not embed a password; credentials come from DBPM`);
  }
}

/** 数据库连接串的用户名必须与 DBPM 条目一致。 */
export function assertUrlUser(raw: string, name: string, expectedUser: string): void {
  const user = decodeURIComponent(parseUrl(raw, name).username);
  if (user !== expectedUser) {
    throw new DbpmConfigError(`${name} user does not match the DBPM credential user`);
  }
}

export type DbpmCredentials = Readonly<Partial<Record<DbpmCredentialRole, string>>>;

export interface FetchDbpmCredentialsOptions extends Omit<FetchDbpmPasswordOptions, 'role'> {
  /** 出现在错误里的进程名，例如 `agent-http`。 */
  readonly process: string;
  /** 仅测试：替换单次取密实现。 */
  readonly fetchPassword?: typeof fetchDbpmPassword;
}

/**
 * 按角色依次取密。任何一个失败都整体失败（调用方应拒绝启动），已取到的口令随返回值丢弃。
 */
export async function fetchDbpmCredentials(
  settings: DbpmSettings,
  roles: readonly DbpmCredentialRole[],
  opts: FetchDbpmCredentialsOptions,
): Promise<DbpmCredentials> {
  const fetchPassword = opts.fetchPassword ?? fetchDbpmPassword;
  const { process: processName, fetchPassword: _ignored, ...limits } = opts;
  const credentials: Partial<Record<DbpmCredentialRole, string>> = {};
  for (const role of roles) {
    const entry = settings.entries[role];
    if (entry === undefined) {
      throw new DbpmConfigError(`DBPM ${role} entry is not configured`);
    }
    credentials[role] = await fetchPassword(settings.endpoints, entry, {
      ...limits,
      role: `${processName}-${role}`,
    });
  }
  return credentials;
}
