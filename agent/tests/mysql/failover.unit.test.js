/**
 * Agent 侧 UPDRDB 建连接线（design §4.2 / §4.3）：Knex 自定义 client 与 DSH 裸池。
 *
 * 用假驱动验证规则本身：切端点、粘主、不串端点、口令不可枚举、会话初始化等待
 * 完成且失败即致命、预算有界、语句发出后不重发。真库行为见
 * `failover.integration.test.js`。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointConfigError, FailoverError } from '@dsh/contract/endpoint-failover.js';
import { createMysqlKnex, destroyMysqlKnex, loadKnexModule } from '../../src/infrastructure/mysql/client.js';
import {
  MysqlSessionInitError,
  SESSION_UTC_SQL,
  classifyMysqlConnectError,
  createFailoverKnexClient,
  createFailoverMysqlPool,
  readUpdrdbEndpoints,
} from '../../src/infrastructure/mysql/failover.js';

const A = { host: 'proxy-a', port: 3306 };
const B = { host: 'proxy-b', port: 3307 };
const DSN = 'mysql://app:dev-pass@dsn-host:3306/agent';

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * 回调式假驱动。`behave(settings, step)` 返回：undefined 成功、Error 失败、'hang' 挂住。
 * step 是 'connect' 或发出的 SQL。
 */
function fakeRawDriver(behave = () => undefined) {
  const created = [];
  return {
    created,
    createConnection(settings) {
      const conn = {
        settings,
        sent: [],
        destroyed: false,
        on() {
          return conn;
        },
        removeAllListeners() {
          return conn;
        },
        destroy() {
          conn.destroyed = true;
        },
        connect(cb) {
          const outcome = behave(settings, 'connect');
          if (outcome === 'hang') return;
          setImmediate(() => cb(outcome ?? null));
        },
        query(sql, cb) {
          conn.sent.push(sql);
          const outcome = behave(settings, sql);
          if (outcome === 'hang') return;
          setImmediate(() => cb(outcome ?? null, sql.startsWith('select version()') ? [{ version: '5.7.44' }] : []));
        },
      };
      created.push(conn);
      return conn;
    },
  };
}

function knexWith(clientOpts) {
  const knex = loadKnexModule();
  return knex({ client: createFailoverKnexClient(clientOpts), connection: DSN, pool: { min: 0, max: 8 } });
}

describe('Knex 故障切换 client', () => {
  it('第一个 Proxy 拒绝连接 → 连第二个，发 UTC 初始化，口令保持不可枚举', async () => {
    const driver = fakeRawDriver((s, step) => (s.host === A.host && step === 'connect' ? codeError('ECONNREFUSED') : undefined));
    const knex = knexWith({ endpoints: [A, B], role: 't', driver });
    try {
      const conn = await knex.client.acquireRawConnection();
      assert.equal(conn.settings.host, B.host);
      assert.equal(conn.settings.port, B.port);
      assert.equal(conn.settings.connectTimeout, 3_000);
      assert.equal(conn.settings.password, 'dev-pass', '派生 settings 必须带着口令');
      assert.equal(Object.keys(conn.settings).includes('password'), false, '口令不能进入可枚举快照');
      assert.deepEqual(conn.sent, ['select version() as version', SESSION_UTC_SQL]);

      await knex.client.acquireRawConnection();
      assert.deepEqual(driver.created.map((c) => c.settings.host), [A.host, B.host, B.host], '粘住 B，不再试 A');
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('并发建连不串端点，也不改写实例共享的 connectionSettings', async () => {
    const driver = fakeRawDriver((s, step) => (s.host === A.host && step === 'connect' ? codeError('ECONNREFUSED') : undefined));
    const knex = knexWith({ endpoints: [A, B], role: 't', driver });
    try {
      const conns = await Promise.all(Array.from({ length: 6 }, () => knex.client.acquireRawConnection()));
      for (const conn of conns) {
        assert.equal(conn.settings.host, B.host);
        assert.notEqual(conn.settings, knex.client.connectionSettings);
      }
      assert.equal(knex.client.connectionSettings.host, 'dsn-host');
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('会话初始化失败是致命错误：销毁连接，不试下一个 Proxy', async () => {
    const driver = fakeRawDriver((_s, step) => (step === SESSION_UTC_SQL ? codeError('ER_UNKNOWN_TIME_ZONE') : undefined));
    const knex = knexWith({ endpoints: [A, B], role: 't', driver });
    try {
      await assert.rejects(knex.client.acquireRawConnection(), (err) => err instanceof MysqlSessionInitError);
      assert.equal(driver.created.length, 1);
      assert.equal(driver.created[0].destroyed, true);
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('认证失败是致命错误，不拉黑、不换 Proxy', async () => {
    const driver = fakeRawDriver((_s, step) => (step === 'connect' ? codeError('ER_ACCESS_DENIED_ERROR') : undefined));
    const knex = knexWith({ endpoints: [A, B], role: 't', driver });
    try {
      await assert.rejects(knex.client.acquireRawConnection(), (err) => err.code === 'ER_ACCESS_DENIED_ERROR');
      assert.equal(driver.created.length, 1);
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('握手挂死：总预算内失败并销毁未交付的连接', async () => {
    const driver = fakeRawDriver((_s, step) => (step === 'connect' ? 'hang' : undefined));
    const knex = knexWith({ endpoints: [A, B], role: 'agent-knex', driver, budgetMs: 80 });
    try {
      const started = Date.now();
      await assert.rejects(
        knex.client.acquireRawConnection(),
        (err) => err instanceof FailoverError && err.code === 'BUDGET_EXHAUSTED',
      );
      assert.ok(Date.now() - started < 1_000);
      assert.equal(driver.created[0].destroyed, true);
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('createMysqlKnex 不给 endpoints 时连 DSN 的 host:port，给了就用端点', async () => {
    const single = fakeRawDriver();
    const k1 = createMysqlKnex(DSN, { driver: single, pool: { max: 1 } });
    const multi = fakeRawDriver();
    const k2 = createMysqlKnex(DSN, { driver: multi, endpoints: [A, B], pool: { max: 1 } });
    try {
      await k1.client.acquireRawConnection();
      await k2.client.acquireRawConnection();
      assert.equal(single.created[0].settings.host, 'dsn-host');
      assert.equal(single.created[0].settings.port, 3306);
      assert.equal(multi.created[0].settings.host, A.host);
      assert.equal(k1.client.config.pool.afterCreate, undefined, '会话初始化在建连内完成，不再依赖 afterCreate');
    } finally {
      await destroyMysqlKnex(k1);
      await destroyMysqlKnex(k2);
    }
  });
});

/** mysql2/promise 风格的假驱动：每端点一个池、一条底层连接。 */
function fakePoolDriver(behave = {}) {
  const pools = [];
  return {
    pools,
    createPool(options) {
      const host = String(options.host);
      const state = { options, checkouts: 0, ended: false, core: { sent: [], released: 0, destroyed: false } };
      pools.push(state);
      const run = async (sql) => {
        state.core.sent.push(sql);
        const err = behave.query?.(host, sql);
        if (err) throw err;
        return [[{ ok: 1 }], []];
      };
      return {
        async getConnection() {
          state.checkouts += 1;
          const err = behave.checkout?.(host);
          if (err) throw err;
          return {
            connection: state.core,
            query: run,
            execute: run,
            beginTransaction: async () => run('BEGIN'),
            commit: async () => run('COMMIT'),
            rollback: async () => run('ROLLBACK'),
            release: () => {
              state.core.released += 1;
            },
            destroy: () => {
              state.core.destroyed = true;
            },
          };
        },
        async end() {
          state.ended = true;
        },
      };
    },
  };
}

const poolBase = { user: 'app', password: 'dev-pass', database: 'agent' };

describe('DSH 裸池故障切换', () => {
  it('第一个 Proxy 拒绝 → 第二个；底层连接只初始化一次；事务在同一连接上', async () => {
    const driver = fakePoolDriver({ checkout: (host) => (host === A.host ? codeError('ECONNREFUSED') : undefined) });
    const pool = createFailoverMysqlPool({ base: poolBase, endpoints: [A, B], role: 't', driver });
    await pool.execute('SELECT 1');
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.execute('INSERT 1');
    await conn.commit();
    conn.release();
    const b = driver.pools[1];
    assert.equal(driver.pools[0].checkouts, 1);
    assert.deepEqual(b.core.sent, [SESSION_UTC_SQL, 'SELECT 1', 'BEGIN', 'INSERT 1', 'COMMIT']);
    assert.equal(b.core.released, 2);
    assert.equal(b.options.password, 'dev-pass');
    await pool.end();
  });

  it('会话初始化失败销毁连接并致命；语句失败不重发、连接照常归还', async () => {
    const initFail = fakePoolDriver({ query: (_h, sql) => (sql === SESSION_UTC_SQL ? codeError('ER_UNKNOWN_TIME_ZONE') : undefined) });
    const p1 = createFailoverMysqlPool({ base: poolBase, endpoints: [A, B], role: 't', driver: initFail });
    await assert.rejects(p1.execute('SELECT 1'), (err) => err instanceof MysqlSessionInitError);
    assert.equal(initFail.pools[0].core.destroyed, true);
    assert.equal(initFail.pools[1].checkouts, 0);

    const lost = fakePoolDriver({ query: (_h, sql) => (sql === 'UPDATE' ? codeError('PROTOCOL_CONNECTION_LOST') : undefined) });
    const p2 = createFailoverMysqlPool({ base: poolBase, endpoints: [A, B], role: 't', driver: lost });
    await assert.rejects(p2.execute('UPDATE'), (err) => err.code === 'PROTOCOL_CONNECTION_LOST');
    assert.equal(lost.pools[0].core.released, 1);
    assert.equal(lost.pools[1].checkouts, 0, '已发出的语句不换端点重放');
    await p1.end();
    await p2.end();
  });

  it('end 关闭全部端点池并拒绝后续使用', async () => {
    const driver = fakePoolDriver();
    const pool = createFailoverMysqlPool({ base: poolBase, endpoints: [A, B], role: 't', driver });
    await pool.end();
    assert.deepEqual(driver.pools.map((p) => p.ended), [true, true]);
    await assert.rejects(pool.getConnection(), /closed/);
  });
});

describe('配置与错误分类', () => {
  it('readUpdrdbEndpoints：未设置返回 undefined，格式错误直接抛', () => {
    assert.equal(readUpdrdbEndpoints({}), undefined);
    assert.deepEqual(readUpdrdbEndpoints({ UPDRDB_ENDPOINTS: 'proxy-a:3306,proxy-b:3307' }), [A, B]);
    assert.throws(() => readUpdrdbEndpoints({ UPDRDB_ENDPOINTS: 'proxy-a:3306' }), EndpointConfigError);
  });

  it('classifyMysqlConnectError', () => {
    assert.equal(classifyMysqlConnectError(codeError('ECONNREFUSED')), 'network');
    assert.equal(classifyMysqlConnectError(codeError('ER_CON_COUNT_ERROR')), 'network');
    assert.equal(classifyMysqlConnectError(codeError('ER_ACCESS_DENIED_ERROR')), 'fatal');
    assert.equal(classifyMysqlConnectError(codeError('ER_BAD_DB_ERROR')), 'fatal');
    assert.equal(classifyMysqlConnectError(new MysqlSessionInitError(codeError('ECONNRESET'))), 'fatal');
  });
});
