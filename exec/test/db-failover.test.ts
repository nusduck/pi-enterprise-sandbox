/**
 * exec 建池的端点故障切换与 UTC 会话初始化（design §4.2 / §4.3）。
 *
 * 前半段用假驱动验证规则；后半段设置 `TEST_MYSQL_URL` 时连真库，证明生产
 * 工厂 `createExecDbPool()` 在第一个 Proxy 不可达时真的切到第二个，且交付的
 * 连接会话时区是 +00:00。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FailoverError } from '@dsh/contract/endpoint-failover.js';
import type { PoolConnection } from 'mysql2/promise';

import { createExecDbPool, closeExecDbPool, SESSION_UTC_SQL } from '../src/db/client.js';
import {
  classifyMysqlConnectError,
  MysqlSessionInitError,
  type EndpointPoolDriver,
} from '../src/db/failover-pool.js';

const A = { host: 'proxy-a', port: 3306 };
const B = { host: 'proxy-b', port: 3307 };

function codeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

interface FakeCore {
  sent: string[];
  released: number;
  destroyed: boolean;
}

interface FakePool {
  options: Record<string, unknown>;
  checkouts: number;
  ended: boolean;
  core: FakeCore;
}

/** 每个端点一个假池、一条底层连接；`behave` 按端点注入故障。 */
function fakeDriver(behave: {
  checkout?: (host: string) => Error | undefined;
  query?: (host: string, sql: string) => Error | undefined;
}): EndpointPoolDriver & { pools: FakePool[] } {
  const pools: FakePool[] = [];
  return {
    pools,
    createPool(options) {
      const host = String(options['host']);
      const state: FakePool = {
        options,
        checkouts: 0,
        ended: false,
        core: { sent: [], released: 0, destroyed: false },
      };
      pools.push(state);
      const run = async (sql: string) => {
        state.core.sent.push(sql);
        const err = behave.query?.(host, sql);
        if (err) throw err;
        return [[{ tz: '+00:00' }], []];
      };
      return {
        async getConnection() {
          state.checkouts += 1;
          const err = behave.checkout?.(host);
          if (err) throw err;
          // mysql2/promise 每次 checkout 新建包装对象，底层连接不变。
          return {
            connection: state.core,
            query: run,
            execute: run,
            release: () => {
              state.core.released += 1;
            },
            destroy: () => {
              state.core.destroyed = true;
            },
          } as unknown as PoolConnection;
        },
        async end() {
          state.ended = true;
        },
      };
    },
  };
}

const config = { host: 'dsn-host', port: 3306, user: 'u', password: 'dev-pass', database: 'd', endpoints: [A, B] };

describe('createExecDbPool 端点故障切换', () => {
  it('第一个 Proxy 拒绝连接时切到第二个，每条底层连接只初始化一次', async () => {
    const driver = fakeDriver({ checkout: (host) => (host === A.host ? codeError('ECONNREFUSED') : undefined) });
    const pool = createExecDbPool(config, { driver });
    await pool.execute('SELECT 1');
    await pool.execute('SELECT 2');
    const [a, b] = driver.pools;
    assert.equal(a?.checkouts, 1, '拉黑后不再尝试 A');
    assert.deepEqual(b?.core.sent, [SESSION_UTC_SQL, 'SELECT 1', 'SELECT 2']);
    assert.equal(b?.core.released, 2);
    assert.equal(b?.options['host'], B.host);
    assert.equal(b?.options['port'], B.port);
    assert.equal(b?.options['connectTimeout'], 3_000);
    assert.equal(b?.options['timezone'], 'Z');
    await closeExecDbPool(pool);
  });

  it('未配 endpoints 时只建 DSN 单端点池', async () => {
    const driver = fakeDriver({});
    const { endpoints: _ignored, ...single } = config;
    const pool = createExecDbPool(single, { driver });
    await pool.execute('SELECT 1');
    assert.equal(driver.pools.length, 1);
    assert.equal(driver.pools[0]?.options['host'], 'dsn-host');
    await closeExecDbPool(pool);
  });

  it('会话初始化失败：销毁连接、不交付、不换端点', async () => {
    const driver = fakeDriver({
      query: (host, sql) => (host === A.host && sql === SESSION_UTC_SQL ? codeError('ER_UNKNOWN_TIME_ZONE') : undefined),
    });
    const pool = createExecDbPool(config, { driver });
    await assert.rejects(pool.getConnection(), (err) => err instanceof MysqlSessionInitError);
    assert.equal(driver.pools[0]?.core.destroyed, true);
    assert.deepEqual(driver.pools[0]?.core.sent, [SESSION_UTC_SQL]);
    assert.equal(driver.pools[1]?.checkouts, 0);
    await closeExecDbPool(pool);
  });

  it('认证失败是致命错误，不拉黑、不尝试另一个 Proxy', async () => {
    const driver = fakeDriver({ checkout: () => codeError('ER_ACCESS_DENIED_ERROR') });
    const pool = createExecDbPool(config, { driver });
    await assert.rejects(pool.execute('SELECT 1'), /ER_ACCESS_DENIED_ERROR/);
    assert.equal(driver.pools[1]?.checkouts, 0);
    await closeExecDbPool(pool);
  });

  it('语句发出后连接断开：不在另一个 Proxy 重发，连接仍归还', async () => {
    const driver = fakeDriver({
      query: (_host, sql) => (sql === 'UPDATE t SET x = 1' ? codeError('PROTOCOL_CONNECTION_LOST') : undefined),
    });
    const pool = createExecDbPool(config, { driver });
    await assert.rejects(pool.execute('UPDATE t SET x = 1'));
    assert.equal(driver.pools[0]?.core.released, 1);
    assert.equal(driver.pools[1]?.checkouts, 0, '已发出的写语句绝不换端点重放');
    await closeExecDbPool(pool);
  });

  it('两个 Proxy 都不可达：有界失败并只报代号', async () => {
    const driver = fakeDriver({ checkout: () => codeError('ECONNREFUSED') });
    const pool = createExecDbPool(config, { driver });
    await assert.rejects(pool.getConnection(), (err) => {
      assert.ok(err instanceof FailoverError);
      assert.equal(err.code, 'ALL_ENDPOINTS_FAILED');
      assert.doesNotMatch(err.message, /proxy-a|dev-pass/);
      return true;
    });
    await closeExecDbPool(pool);
  });

  it('end 关闭所有端点池，之后拒绝再取连接', async () => {
    const driver = fakeDriver({});
    const pool = createExecDbPool(config, { driver });
    await pool.end();
    assert.deepEqual(driver.pools.map((p) => p.ended), [true, true]);
    await assert.rejects(pool.getConnection(), /closed/);
  });

  it('classifyMysqlConnectError 区分网络故障与致命错误', () => {
    assert.equal(classifyMysqlConnectError(codeError('ECONNREFUSED')), 'network');
    assert.equal(classifyMysqlConnectError(codeError('PROTOCOL_CONNECTION_LOST')), 'network');
    assert.equal(classifyMysqlConnectError(codeError('ER_ACCESS_DENIED_ERROR')), 'fatal');
    assert.equal(classifyMysqlConnectError(new MysqlSessionInitError(codeError('ECONNRESET'))), 'fatal');
  });
});

const TEST_MYSQL_URL = (process.env['TEST_MYSQL_URL'] ?? '').trim();
const describeLive = /^mysql2?:\/\//.test(TEST_MYSQL_URL) ? describe : describe.skip;

describeLive('createExecDbPool 真库（TEST_MYSQL_URL）', () => {
  const url = new URL(TEST_MYSQL_URL);
  const live = { host: url.hostname, port: Number(url.port || 3306) };
  const base = {
    host: live.host,
    port: live.port,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: 3,
  };

  it('第一个 Proxy 不可达 → 切到可用端点；并发扩出的连接会话时区都是 +00:00', async () => {
    const pool = createExecDbPool({ ...base, endpoints: [{ host: '127.0.0.1', port: 1 }, live] });
    try {
      const results = await Promise.all(
        [0, 1, 2].map(() => pool.execute('SELECT SLEEP(0.2) AS s, @@session.time_zone AS tz, CONNECTION_ID() AS id')),
      );
      const rows = results.map(([r]) => (r as Array<{ tz: string; id: number }>)[0]);
      assert.deepEqual(rows.map((r) => r?.tz), ['+00:00', '+00:00', '+00:00']);
      assert.equal(new Set(rows.map((r) => r?.id)).size, 3, '三条并发语句应当扩出三条物理连接');
    } finally {
      await closeExecDbPool(pool);
    }
  });

  it('两个端点都不可达：在预算内失败，不挂死', async () => {
    const pool = createExecDbPool({
      ...base,
      endpoints: [
        { host: '127.0.0.1', port: 1 },
        { host: '127.0.0.1', port: 2 },
      ],
    });
    const started = Date.now();
    try {
      await assert.rejects(pool.execute('SELECT 1'), /all endpoints failed/);
      assert.ok(Date.now() - started < 12_000);
    } finally {
      await closeExecDbPool(pool);
    }
  });

  it('错误口令是致命错误：ER_ACCESS_DENIED_ERROR，不伪装成 Proxy 故障', async () => {
    const pool = createExecDbPool({ ...base, password: 'definitely-wrong', endpoints: [live, live] });
    try {
      await assert.rejects(pool.execute('SELECT 1'), (err: unknown) => {
        const cause = (err as { cause?: { code?: string } }).cause;
        assert.equal(cause?.code, 'ER_ACCESS_DENIED_ERROR');
        assert.doesNotMatch(String((err as Error).message), /definitely-wrong/);
        return true;
      });
    } finally {
      await closeExecDbPool(pool);
    }
  });
});
