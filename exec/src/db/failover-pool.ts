/**
 * exec 侧 UPDRDB 双 Proxy 建连：每端点一个 mysql2 池 + 按端点故障切换的 acquire
 * （design `updrdb-dbpm-deployment.md` §4.2 / §4.3，ADR 0011 D5 / D7）。
 *
 * 粘主/拉黑/预算的纯策略在 `@dsh/contract/endpoint-failover`；驱动接线按 design 留在
 * 各包，所以 Agent 的 `infrastructure/mysql/failover.ts` 有一份同构实现。两边规则
 * 必须一致：只在 acquire 阶段换端点，业务 SQL 发出后不重发；会话初始化在交付
 * 连接前完成，失败即丢弃连接并按致命错误抛出。
 */

import { createRequire } from 'node:module';
import type { Pool, PoolConnection } from 'mysql2/promise';

import {
  acquireWithFailover,
  EndpointSelector,
  isNetworkError,
  parseEndpointList,
  type ConnectFailureKind,
  type Endpoint,
} from '@dsh/contract/endpoint-failover.js';

const require = createRequire(import.meta.url);

/** 每条物理连接交付前必须执行的会话初始化语句。 */
export const SESSION_UTC_SQL = "SET SESSION time_zone = '+00:00'";
export const MYSQL_CONNECT_TIMEOUT_MS = 3_000;
export const MYSQL_ACQUIRE_BUDGET_MS = 10_000;

export class MysqlSessionInitError extends Error {
  override name = 'MysqlSessionInitError';
  readonly code = 'SESSION_INIT_FAILED';

  constructor(cause: unknown) {
    super('MySQL session initialization failed (time_zone)', { cause });
  }
}

const MYSQL_NETWORK_CODES: ReadonlySet<string> = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CON_COUNT_ERROR',
]);

/** 网络不可达 → 换端点；认证失败、会话初始化失败等 → 立即失败。 */
export function classifyMysqlConnectError(err: unknown): ConnectFailureKind {
  if (err instanceof MysqlSessionInitError) return 'fatal';
  if (isNetworkError(err)) return 'network';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MYSQL_NETWORK_CODES.has(code) ? 'network' : 'fatal';
}

/** `UPDRDB_ENDPOINTS` 未设置返回 `undefined`（沿用 DSN 单端点）；格式错直接抛。 */
export function readUpdrdbEndpoints(env: NodeJS.ProcessEnv = process.env): Endpoint[] | undefined {
  const raw = String(env['UPDRDB_ENDPOINTS'] ?? '').trim();
  if (raw === '') return undefined;
  return parseEndpointList(raw, { name: 'UPDRDB_ENDPOINTS', count: 2 });
}

/**
 * exec 仓储实际需要的池接口。比 mysql2 `Pool` 窄：没有 `on`、`pool` 等
 * 会绕开故障切换的入口。
 */
export interface ExecDbPool {
  readonly execute: Pool['execute'];
  readonly query: Pool['query'];
  getConnection(): Promise<PoolConnection>;
  end(): Promise<void>;
}

interface EndpointPool {
  getConnection(): Promise<PoolConnection>;
  end(): Promise<void>;
}

export interface EndpointPoolDriver {
  createPool(options: Record<string, unknown>): EndpointPool;
}

export interface FailoverPoolOptions {
  /** mysql2 池选项；host/port 由端点覆盖。 */
  readonly base: Record<string, unknown>;
  readonly endpoints: readonly Endpoint[];
  readonly role: string;
  readonly blacklistMs?: number | undefined;
  readonly budgetMs?: number | undefined;
  /** 仅测试：替换 `mysql2/promise`。 */
  readonly driver?: EndpointPoolDriver | undefined;
}

function destroyQuietly(conn: { destroy(): void }): void {
  try {
    conn.destroy();
  } catch {
    // 连接可能已经关了。
  }
}

export function createFailoverPool(opts: FailoverPoolOptions): ExecDbPool {
  const driver = opts.driver ?? (require('mysql2/promise') as EndpointPoolDriver);
  const pools = opts.endpoints.map((endpoint) =>
    driver.createPool({
      ...opts.base,
      host: endpoint.host,
      port: endpoint.port,
      connectTimeout: MYSQL_CONNECT_TIMEOUT_MS,
    }),
  );
  const selector = new EndpointSelector(
    opts.endpoints,
    opts.blacklistMs === undefined ? {} : { blacklistMs: opts.blacklistMs },
  );
  // mysql2/promise 每次 checkout 都新建包装对象；底层 `connection` 才是同一条会话。
  const initialized = new WeakSet<object>();
  let closed = false;

  const getConnection = async (): Promise<PoolConnection> => {
    if (closed) throw new Error(`${opts.role}: pool is closed`);
    return acquireWithFailover(
      selector,
      async ({ index }) => {
        const pool = pools[index];
        if (pool === undefined) throw new RangeError(`endpoint pool ${index} missing`);
        const conn = await pool.getConnection();
        if (!initialized.has(conn.connection)) {
          try {
            await conn.query(SESSION_UTC_SQL);
          } catch (err) {
            destroyQuietly(conn);
            throw new MysqlSessionInitError(err);
          }
          initialized.add(conn.connection);
        }
        return conn;
      },
      {
        role: opts.role,
        budgetMs: opts.budgetMs ?? MYSQL_ACQUIRE_BUDGET_MS,
        classify: classifyMysqlConnectError,
        dispose: (late) => late.release(),
      },
    );
  };

  const runOnce = async (method: 'execute' | 'query', sql: unknown, values: unknown): Promise<unknown> => {
    const conn = await getConnection();
    try {
      const call = conn[method] as (s: unknown, v?: unknown) => Promise<unknown>;
      return values === undefined ? await call.call(conn, sql) : await call.call(conn, sql, values);
    } finally {
      conn.release();
    }
  };

  return {
    execute: ((sql: unknown, values?: unknown) => runOnce('execute', sql, values)) as Pool['execute'],
    query: ((sql: unknown, values?: unknown) => runOnce('query', sql, values)) as Pool['query'],
    getConnection,
    async end() {
      closed = true;
      const results = await Promise.allSettled(pools.map((pool) => pool.end()));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    },
  };
}
