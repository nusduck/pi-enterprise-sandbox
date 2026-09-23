/**
 * UPDRDB 双 Proxy 的 mysql2 / Knex 建连接线（design `updrdb-dbpm-deployment.md`
 * §4.2 / §4.3，ADR 0011 D5 / D7）。
 *
 * 为什么在这里而不在 contract/：粘主/拉黑/预算是纯策略，已放进
 * `@dsh/contract/endpoint-failover`；「怎样建一条 mysql2 连接、哪些驱动错误算网络
 * 故障、会话怎样初始化」依赖驱动行为，按 design 留在各包基础设施层。Agent 的
 * Knex 与 DSH 会话存储的裸池共用本文件；exec 另有一份同构实现（不同包）。
 *
 * 两个接入点：
 * - **Knex**：按实例继承 `knex/lib/dialects/mysql2` 并覆写 `acquireRawConnection()`。
 *   只提供函数式 `connection` 捕获不到握手失败，不足以做故障切换。端点组装成
 *   局部 settings，**不写 `this.connectionSettings`**（实例共享字段，并发建连会串
 *   端点）；knex 把 `password` 设为不可枚举，展开复制会静默丢口令，必须补回。
 * - **裸 mysql2**：每端点一个池，先显式 acquire 再在该连接上执行完整操作；选择器
 *   只参与 acquire，不在 `.execute()` 之后重发。
 *
 * 会话初始化（`SET SESSION time_zone = '+00:00'`）与建连视为同一个操作：Knex 在
 * `acquireRawConnection()` 内等待完成；裸池在交付连接前按底层连接做一次。失败即
 * 丢弃连接并按致命错误抛出，不换端点、不交付。
 *
 * 业务 SQL 一旦发出不自动重试——包括 commit 响应丢失，可能已经提交。
 */

import { createRequire } from 'node:module';

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
/** 单次 TCP/握手上限（design §4.2）。 */
export const MYSQL_CONNECT_TIMEOUT_MS = 3_000;
/** 一次 acquire 的总预算：全部端点尝试 + 会话初始化（design §4.2）。 */
export const MYSQL_ACQUIRE_BUDGET_MS = 10_000;

/** 会话初始化失败。永远是致命错误：换端点救不了一条初始化失败的会话。 */
export class MysqlSessionInitError extends Error {
  override name = 'MysqlSessionInitError';
  readonly code = 'SESSION_INIT_FAILED';

  constructor(cause: unknown) {
    super('MySQL session initialization failed (time_zone)', { cause });
  }
}

/** mysql2 自身抛出、含义等同「这个端点现在不可达」的错误码。 */
const MYSQL_NETWORK_CODES: ReadonlySet<string> = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CON_COUNT_ERROR',
]);

/**
 * 网络不可达 → 换端点；认证失败、库不存在、会话初始化失败等 → 立即失败。
 * 把认证错误当网络故障，会让一个错口令伪装成「两个 Proxy 都不通」。
 */
export function classifyMysqlConnectError(err: unknown): ConnectFailureKind {
  if (err instanceof MysqlSessionInitError) return 'fatal';
  if (isNetworkError(err)) return 'network';
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && MYSQL_NETWORK_CODES.has(code) ? 'network' : 'fatal';
}

/**
 * 读 `UPDRDB_ENDPOINTS`（两个 Proxy 的 `host:port`）。未设置返回 `undefined`，
 * 由调用方使用 DSN 里的 host:port 单端点——开发环境的 compose MySQL 就是这样。
 * 设置了但格式不对直接抛错，不回退到 DSN。
 */
export function readUpdrdbEndpoints(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Endpoint[] | undefined {
  const raw = String(env['UPDRDB_ENDPOINTS'] ?? '').trim();
  if (raw === '') return undefined;
  return parseEndpointList(raw, { name: 'UPDRDB_ENDPOINTS', count: 2 });
}

// ---------------------------------------------------------------------------
// Knex
// ---------------------------------------------------------------------------

/** knex mysql2 方言交给 `createConnection()` 的回调式连接里我们用到的部分。 */
export interface RawMysqlConnection {
  on(event: 'error', listener: (err: unknown) => void): unknown;
  connect(callback: (err?: unknown) => void): void;
  query(sql: string, callback: (err?: unknown) => void): unknown;
  destroy(): void;
  removeAllListeners(): unknown;
  __knex__disposed?: unknown;
}

export interface RawMysqlDriver {
  createConnection(settings: Record<string, unknown>): RawMysqlConnection;
}

interface KnexMysql2ClientInstance {
  connectionSettings: Record<string, unknown>;
  driver: RawMysqlDriver;
  logger: { warn(message: string): void };
  checkVersion(connection: RawMysqlConnection): Promise<unknown>;
  _driver(): RawMysqlDriver;
}

type KnexMysql2ClientCtor = new (config: unknown) => KnexMysql2ClientInstance;

export interface FailoverKnexClientOptions {
  /** 不传则使用 DSN 里的 host:port 单端点。 */
  readonly endpoints?: readonly Endpoint[] | undefined;
  /** DBPM 下发的口令；给了就覆盖 DSN 里的（DSN 本身不应带口令）。 */
  readonly password?: string | undefined;
  readonly role: string;
  readonly blacklistMs?: number | undefined;
  readonly budgetMs?: number | undefined;
  /** 仅测试：替换 mysql2 驱动。 */
  readonly driver?: RawMysqlDriver | undefined;
}

function destroyQuietly(connection: { destroy(): void } | undefined): void {
  try {
    connection?.destroy();
  } catch {
    // 连接可能已经关了。
  }
}

function sessionSettings(
  base: Record<string, unknown>,
  endpoint: Endpoint,
  password: string | undefined,
): Record<string, unknown> {
  const configured = Number(base['connectTimeout']);
  const settings: Record<string, unknown> = {
    ...base,
    host: endpoint.host,
    port: endpoint.port,
    connectTimeout:
      Number.isFinite(configured) && configured > 0
        ? Math.min(configured, MYSQL_CONNECT_TIMEOUT_MS)
        : MYSQL_CONNECT_TIMEOUT_MS,
  };
  // 展开复制拿不到不可枚举的 password；补回时保持不可枚举，别让口令进入快照/日志。
  Object.defineProperty(settings, 'password', {
    enumerable: false,
    value: password ?? base['password'],
  });
  return settings;
}

/**
 * 返回一个 knex `client` 构造函数：继承 mysql2 方言，只覆写建连。
 *
 * 每次调用得到一个新类（闭包持有各自的选择器），所以不同 Knex 实例互不影响，
 * 不需要全局 patch。
 */
export function createFailoverKnexClient(opts: FailoverKnexClientOptions): KnexMysql2ClientCtor {
  const Base = require('knex/lib/dialects/mysql2/index.js') as KnexMysql2ClientCtor;
  let selector: EndpointSelector | undefined;

  return class FailoverMysql2Client extends Base {
    override _driver(): RawMysqlDriver {
      return opts.driver ?? super._driver();
    }

    acquireRawConnection(): Promise<RawMysqlConnection> {
      const base = this.connectionSettings;
      selector ??= new EndpointSelector(
        opts.endpoints ?? [{ host: String(base['host'] ?? ''), port: Number(base['port'] ?? 3306) }],
        opts.blacklistMs === undefined ? {} : { blacklistMs: opts.blacklistMs },
      );
      return acquireWithFailover<RawMysqlConnection>(
        selector,
        ({ endpoint, signal }) =>
          this.connectEndpoint(sessionSettings(base, endpoint, opts.password), signal),
        {
          role: opts.role,
          budgetMs: opts.budgetMs ?? MYSQL_ACQUIRE_BUDGET_MS,
          classify: classifyMysqlConnectError,
          dispose: destroyQuietly,
        },
      );
    }

    /** 建连 → 版本探测（保留上游行为）→ 会话初始化 → 交付。 */
    connectEndpoint(settings: Record<string, unknown>, signal: AbortSignal): Promise<RawMysqlConnection> {
      return new Promise<RawMysqlConnection>((resolve, reject) => {
        const connection = this.driver.createConnection(settings);
        let settled = false;
        const fail = (err: unknown, destroy: boolean): void => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          if (destroy) destroyQuietly(connection);
          else connection.removeAllListeners();
          reject(err);
        };
        const onAbort = (): void => fail(Object.assign(new Error('connect aborted'), { code: 'ETIMEDOUT' }), true);
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });

        connection.on('error', (err) => {
          connection.__knex__disposed = err;
        });
        connection.connect((err) => {
          if (settled) return;
          if (err) {
            fail(err, false);
            return;
          }
          void (async () => {
            try {
              await this.checkVersion(connection);
            } catch {
              // 与上游一致：探测失败只告警并按最新版本处理。不带错误正文，避免回显连接信息。
              this.logger.warn('Knex: Unable to detect MySQL/MariaDB version. Assuming latest version.');
            }
            try {
              await new Promise<void>((done, failInit) =>
                connection.query(SESSION_UTC_SQL, (initErr) => (initErr ? failInit(initErr) : done())),
              );
            } catch (initErr) {
              fail(new MysqlSessionInitError(initErr), true);
              return;
            }
            if (settled) {
              destroyQuietly(connection);
              return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(connection);
          })();
        });
      });
    }
  };
}

// ---------------------------------------------------------------------------
// 裸 mysql2 池（mysql2/promise）
// ---------------------------------------------------------------------------

export interface FailoverPoolConnection {
  readonly connection: object;
  query(sql: string, values?: unknown): Promise<any>;
  execute(sql: string, values?: unknown): Promise<any>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}

export interface EndpointPool {
  getConnection(): Promise<FailoverPoolConnection>;
  end(): Promise<void>;
}

export interface EndpointPoolDriver {
  createPool(options: Record<string, unknown>): EndpointPool;
}

export interface FailoverMysqlPool {
  execute(sql: string, values?: unknown): Promise<any>;
  query(sql: string, values?: unknown): Promise<any>;
  getConnection(): Promise<FailoverPoolConnection>;
  end(): Promise<void>;
}

export interface FailoverMysqlPoolOptions {
  /** mysql2 池选项（user/password/database/charset…）；host/port 由端点覆盖。 */
  readonly base: Record<string, unknown>;
  readonly endpoints: readonly Endpoint[];
  readonly role: string;
  readonly blacklistMs?: number | undefined;
  readonly budgetMs?: number | undefined;
  /** 仅测试：替换 `mysql2/promise`。 */
  readonly driver?: EndpointPoolDriver | undefined;
}

function loadMysql2Promise(): EndpointPoolDriver {
  try {
    return require('mysql2/promise') as EndpointPoolDriver;
  } catch {
    throw new Error('mysql2 not installed: pool creation requires mysql2');
  }
}

/**
 * 每端点一个 mysql2 池，外面包一层按端点故障切换的 acquire。
 *
 * `execute` / `query` 是「acquire → 在该连接上执行一次 → release」的便捷形式；
 * 需要事务的调用方用 `getConnection()` 自己持有连接。两者都不会在语句发出后换端点重发。
 */
export function createFailoverMysqlPool(opts: FailoverMysqlPoolOptions): FailoverMysqlPool {
  const driver = opts.driver ?? loadMysql2Promise();
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
  // 以底层连接为键：mysql2/promise 每次 checkout 都新建包装对象，底层连接才是同一条会话。
  const initialized = new WeakSet<object>();
  let closed = false;

  const getConnection = async (): Promise<FailoverPoolConnection> => {
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

  const runOnce = async (method: 'execute' | 'query', sql: string, values: unknown): Promise<any> => {
    const conn = await getConnection();
    try {
      return values === undefined ? await conn[method](sql) : await conn[method](sql, values);
    } finally {
      conn.release();
    }
  };

  return {
    execute: (sql, values) => runOnce('execute', sql, values),
    query: (sql, values) => runOnce('query', sql, values),
    getConnection,
    async end() {
      closed = true;
      const results = await Promise.allSettled(pools.map((pool) => pool.end()));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed !== undefined) throw failed.reason;
    },
  };
}
