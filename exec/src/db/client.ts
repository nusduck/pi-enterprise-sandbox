/**
 * exec 侧 MySQL 连接池——所有仓储共用的唯一建池入口。
 *
 * 为什么单独一层：`job-store-mysql.ts` 与 `quota-store.ts` 各自直接拿 `Pool`
 * 是可行的，但 `exec/src/db/` 作为后续 W3-A/B/C（内部端点、产物/数据集）
 * 共用的持久化底座，需要一个统一的创建/关闭/脱敏入口——这正是 Python 版
 * `sandbox/app/persistence/database.py` 里 `create_engine()` + `DATABASE_URL`
 * 那一坨的 TS 等价物。隔离点只有一个：**失败时必须 fail-closed 且不泄漏
 * DSN/密码**（硬约束 #1），调用方没配库就应直接起不来，而不是悄悄用内存
 * 回退——这会让生产环境在不知情的情况下丢数据。
 */

import { createPool, type Pool, type PoolOptions } from 'mysql2/promise';
import { redactPhysicalRoots } from '../fs/redact.js';

/**
 * 建池所需的最小配置。故意不暴露 `mysql2` 全部 `PoolOptions`——只收我们
 * 真正读的那几项，其余用 sensible 默认值，避免调用方往这里塞 `debug`
 * 之类的隐蔽开关、加大 review 负担。
 */
export interface ExecDbConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  /** 可选：连接池大小，默认 10。 */
  readonly connectionLimit?: number | undefined;
  /** 可选：物理根列表，供错误脱敏用；不传则不脱敏（但错误仍不含 DSN）。 */
  readonly physicalRoots?: readonly string[] | undefined;
}

/** 缺少必要配置时抛出的 fail-closed 错误。 */
export class ExecDbConfigError extends Error {
  override name = 'ExecDbConfigError';
}

/** MySQL prepared statements reject numeric `LIMIT ?` on some server builds. */
export function sqlLimit(limit: number, max = 1000): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new RangeError(`limit must be an integer from 1 to ${max}`);
  }
  return String(limit);
}

/**
 * 从环境变量解析配置。读取的键与 Python 版 `sandbox/config.py` 的
 * `DATABASE_URL` / `MYSQL_*` 保持概念一致，但**不复用 `DATABASE_URL` 的
 * DSN 解析**——那一串正则容易在 TS 侧抄错，且生产环境更倾向用拆开的
 * `EXEC_DB_*` 逐项注入（便于 K8s Secret）。两者都读：优先 `DATABASE_URL`，
 * 回退到 `EXEC_DB_*`，都没有就抛 `ExecDbConfigError`。
 */
export function readExecDbConfig(env: NodeJS.ProcessEnv = process.env): ExecDbConfig {
  const dsn = env['DATABASE_URL'] ?? env['EXEC_DATABASE_URL'];
  if (dsn !== undefined && dsn.trim() !== '') {
    const parsed = parseDsn(dsn);
    if (parsed !== null) return parsed;
    // DSN 形如 mysql://user:pass@host:port/db，解析失败就 fail-closed。
    throw new ExecDbConfigError('invalid DATABASE_URL');
  }

  const host = env['EXEC_DB_HOST'] ?? env['DB_HOST'] ?? env['MYSQL_HOST'];
  const user = env['EXEC_DB_USER'] ?? env['DB_USER'] ?? env['MYSQL_USER'];
  const password = env['EXEC_DB_PASSWORD'] ?? env['DB_PASSWORD'] ?? env['MYSQL_PASSWORD'];
  const database = env['EXEC_DB_DATABASE'] ?? env['DB_DATABASE'] ?? env['MYSQL_DATABASE'];
  const portRaw = env['EXEC_DB_PORT'] ?? env['DB_PORT'] ?? env['MYSQL_PORT'];

  if (!host || !user || password === undefined || !database) {
    throw new ExecDbConfigError(
      'missing exec DB config: set DATABASE_URL or EXEC_DB_HOST/USER/PASSWORD/DATABASE',
    );
  }

  const port = portRaw !== undefined && portRaw !== '' ? Number.parseInt(portRaw, 10) : 3306;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new ExecDbConfigError('invalid EXEC_DB_PORT');
  }

  return { host, port, user, password, database };
}

function parseDsn(dsn: string): ExecDbConfig | null {
  try {
    const url = new URL(dsn);
    if (
      url.protocol !== 'mysql:' &&
      url.protocol !== 'mysql2:' &&
      url.protocol !== 'mysql+pymysql:'
    ) {
      return null;
    }
    const host = url.hostname;
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = url.pathname.replace(/^\//, '');
    const port = url.port ? Number.parseInt(url.port, 10) : 3306;
    if (!host || !user || !database) return null;
    return { host, port, user, password, database };
  } catch {
    return null;
  }
}

/**
 * 建池。**所有仓储必须经此建池**，不要在 repositories 里各自 `createPool()`——
 * 否则连接数会按仓储数线性放大，且关闭时漏关某一个池会悬空连接。
 *
 * 错误脱敏：`mysql2` 抛出的 `Error.message` 里可能回显 host/user（取决于
 * 驱动版本），这里统一用 `redactPhysicalRoots()` 加一层兜底，且**永不**把
 * `password` 或完整 DSN 拼进错误文本——`toWireError()` 那一层也会再脱敏一次，
 * 这里是第一道防线。
 */
export function createExecDbPool(config: ExecDbConfig): Pool {
  const options: PoolOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit ?? 10,
    // 与 agent 侧 `knex` 配置对齐：utf8mb4 + 时区 UTC。
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    // 失败时不自动重连风暴——让上层（HTTP 启动探针）感知并 fail-closed。
    enableKeepAlive: true,
  };

  const pool = createPool(options);

  // 包装 `pool.execute` 的错误脱敏（可选的轻量 AOP，不改驱动行为）。
  const originalExecute = pool.execute.bind(pool) as Pool['execute'];
  (pool as unknown as { execute: Pool['execute'] }).execute = (async (
    sql: string,
    params?: unknown,
  ) => {
    try {
      return await (originalExecute as unknown as (s: string, p?: unknown) => Promise<unknown>)(sql, params);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const roots = config.physicalRoots ?? [];
      const redacted = roots.length > 0 ? redactPhysicalRoots(raw, roots) : raw;
      // 重抛一个不含 DSN 的错误，保留原 cause 供日志侧（脱敏后）排查。
      const wrapped = new Error(redacted);
      (wrapped as unknown as { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }) as Pool['execute'];

  return pool;
}

/** 关闭池。幂等：重复调用不抛。 */
export async function closeExecDbPool(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 关闭失败不泄漏物理路径，静默吞掉（进程退出前尽力而为）。
    void msg;
  }
}
