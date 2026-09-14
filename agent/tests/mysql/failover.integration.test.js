/**
 * Gated live integration: UPDRDB 双 Proxy 接线打到真实 MySQL（design §4.2 / §4.3，
 * 验收矩阵 T8 的本地部分）。
 *
 * 用「一个必然拒绝连接的端口 + 真库」模拟主 Proxy 故障：证明生产工厂
 * `createMysqlKnex()` 与 DSH 会话存储用的 `createFailoverMysqlPool()` 真的会切过去，
 * 且池扩出的每条连接会话时区都是 +00:00。本地 MySQL 全局时区是 SYSTEM，
 * 漏掉初始化时这里读到的就是 'SYSTEM'，断言能区分。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const require = createRequire(import.meta.url);

function mysqlDepsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const runLive = /^mysql2?:\/\//.test(TEST_MYSQL_URL) && mysqlDepsAvailable();
const describeLive = runLive ? describe : describe.skip;

const DEAD = { host: '127.0.0.1', port: 1 };
const DEAD_2 = { host: '127.0.0.1', port: 2 };

describe('updrdb failover integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('UPDRDB 建连接线（TEST_MYSQL_URL）', () => {
  const url = runLive ? new URL(TEST_MYSQL_URL) : null;
  const live = url ? { host: url.hostname, port: Number(url.port || 3306) } : null;

  async function load() {
    const client = await import('../../src/infrastructure/mysql/client.js');
    const failover = await import('../../src/infrastructure/mysql/failover.js');
    return { ...client, ...failover };
  }

  it('Knex：主 Proxy 不可达 → 切到可用端点；并发扩出的连接全部 +00:00', async () => {
    const { createMysqlKnex, destroyMysqlKnex } = await load();
    const knex = createMysqlKnex(TEST_MYSQL_URL, { endpoints: [DEAD, live], pool: { min: 0, max: 4 } });
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          knex.raw('SELECT SLEEP(0.2) AS s, @@session.time_zone AS tz, CONNECTION_ID() AS id'),
        ),
      );
      const rows = results.map(([r]) => r[0]);
      assert.deepEqual(rows.map((r) => r.tz), ['+00:00', '+00:00', '+00:00', '+00:00']);
      assert.equal(new Set(rows.map((r) => r.id)).size, 4, '四条并发语句应扩出四条物理连接');
      const [[drift]] = await knex.raw('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS d');
      assert.equal(Number(drift.d), 0, 'NOW() 必须与 UTC 一致');
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('Knex：两个端点都不可达 → 有界失败，不挂到 knex 默认 60s', async () => {
    const { createMysqlKnex, destroyMysqlKnex } = await load();
    const knex = createMysqlKnex(TEST_MYSQL_URL, { endpoints: [DEAD, DEAD_2], pool: { min: 0, max: 1 } });
    const started = Date.now();
    try {
      await assert.rejects(knex.raw('SELECT 1'), /all endpoints failed/);
      assert.ok(Date.now() - started < 12_000);
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('Knex：错误口令 → ER_ACCESS_DENIED_ERROR，不被当成 Proxy 故障', async () => {
    const { createMysqlKnex, destroyMysqlKnex } = await load();
    const bad = new URL(TEST_MYSQL_URL);
    bad.password = 'definitely-wrong';
    const knex = createMysqlKnex(bad.toString(), { endpoints: [live, live], pool: { min: 0, max: 1 } });
    try {
      await assert.rejects(knex.raw('SELECT 1'), (err) => {
        assert.equal(err.code, 'ER_ACCESS_DENIED_ERROR');
        assert.doesNotMatch(String(err.message), /definitely-wrong/);
        return true;
      });
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('DSH 裸池：主 Proxy 不可达 → 切换；持有连接跑事务；会话 +00:00', async () => {
    const { createFailoverMysqlPool } = await load();
    const pool = createFailoverMysqlPool({
      base: {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, ''),
        connectionLimit: 2,
        timezone: 'Z',
        dateStrings: true,
      },
      endpoints: [DEAD, live],
      role: 'agent-dsh-session-store',
    });
    try {
      const [rows] = await pool.execute('SELECT @@session.time_zone AS tz');
      assert.equal(rows[0].tz, '+00:00');
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[inTx]] = await conn.query('SELECT @@session.time_zone AS tz, NOW(3) = UTC_TIMESTAMP(3) AS utc');
        await conn.commit();
        assert.equal(inTx.tz, '+00:00');
        assert.equal(Number(inTx.utc), 1);
      } finally {
        conn.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('MysqlSessionStore 读取 UPDRDB_ENDPOINTS 并经故障切换池连库', async () => {
    const { readMysqlSessionStoreConfig, MysqlSessionStore } = await import(
      '../../src/runtime/providers/mysql-session-store.js'
    );
    const cfg = readMysqlSessionStoreConfig({
      AGENT_DATABASE_URL: TEST_MYSQL_URL,
      UPDRDB_ENDPOINTS: `${DEAD.host}:${DEAD.port},${live.host}:${live.port}`,
    });
    assert.deepEqual(cfg.endpoints, [DEAD, live]);
    const store = new MysqlSessionStore(cfg);
    try {
      // list() 需要 dsh_sessions 表；测试库未迁移时它会以缺表失败——那也证明已经切到真库。
      await store.list().catch((err) => {
        assert.match(String(err.message), /dsh_sessions|doesn't exist/);
      });
    } finally {
      await store.close();
    }
  });
});
