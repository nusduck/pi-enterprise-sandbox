import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMysqlKnex,
  destroyMysqlKnex,
  normalizeMysqlConnectionUrl,
} from '../../src/infrastructure/mysql/client.js';
import { toMysqlDateTime } from '../../src/infrastructure/mysql/row-mappers.js';
import {
  TraceSpanRepository,
  runRootSpanId,
} from '../../src/infrastructure/mysql/repositories/trace-span-repository.js';
import { createFakeKnex, createFakeState } from './fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TRACE = 'a'.repeat(32);

describe('mysql client value boundary', () => {
  it('forces UTC dates and raw JSON strings while preserving other DSN options', () => {
    const normalized = normalizeMysqlConnectionUrl(
      'mysql2://user:p%40ss@db.example:3307/agent' +
        '?charset=utf8mb4&connectTimeout=5000' +
        '&ssl=%7B%22rejectUnauthorized%22%3Atrue%7D' +
        '&timezone=local&dateStrings=false&jsonStrings=false',
    );
    const parsed = new URL(normalized);

    assert.equal(parsed.protocol, 'mysql:');
    assert.equal(parsed.searchParams.get('timezone'), 'Z');
    assert.equal(parsed.searchParams.get('dateStrings'), 'true');
    assert.equal(parsed.searchParams.get('jsonStrings'), 'true');
    assert.equal(parsed.searchParams.get('charset'), 'utf8mb4');
    assert.equal(parsed.searchParams.get('connectTimeout'), '5000');
    assert.deepEqual(JSON.parse(parsed.searchParams.get('ssl')), {
      rejectUnauthorized: true,
    });
  });

  it('passes the forced options through knex mysql2 config without connecting', async () => {
    const knex = createMysqlKnex(
      'mysql://user:pass@127.0.0.1:1/agent?connectTimeout=17&decimalNumbers=true',
      { pool: { min: 0, max: 1 } },
    );
    try {
      assert.equal(knex.client.config.connection.timezone, 'Z');
      assert.equal(knex.client.config.connection.dateStrings, true);
      assert.equal(knex.client.config.connection.jsonStrings, true);
      assert.equal(knex.client.config.connection.connectTimeout, 17);
      assert.equal(knex.client.config.connection.decimalNumbers, true);
    } finally {
      await destroyMysqlKnex(knex);
    }
  });

  it('treats MySQL DATETIME strings as UTC when writing them back', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      assert.equal(
        toMysqlDateTime('2026-07-18 19:36:59.479'),
        '2026-07-18 19:36:59.479',
      );
    } finally {
      if (originalTz == null) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('keeps trace timestamps stable across repeated materialization', async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const state = createFakeState();
      const knex = createFakeKnex(state);
      state.tables.trace_spans = [];
      const repo = new TraceSpanRepository(knex, {
        now: () => new Date('2026-07-18T19:37:00.000Z'),
      });
      const run = {
        runId: RUN,
        traceId: TRACE,
        conversationId: CONV,
        agentSessionId: SESS,
        status: 'RUNNING',
        source: 'web',
        queueName: 'runs',
        attempt: 0,
        createdAt: '2026-07-18T19:36:59.479Z',
      };
      const scope = { orgId: ORG, userId: USER };

      await repo.materializeRunFacts(run, scope);
      const firstStartedAt = state.tables.trace_spans[0].started_at;
      await repo.materializeRunFacts(run, scope);

      assert.equal(firstStartedAt, '2026-07-18 19:36:59.479');
      assert.equal(state.tables.trace_spans.length, 1);
      assert.equal(state.tables.trace_spans[0].started_at, firstStartedAt);

      await repo.upsert({
        ...scope,
        traceId: TRACE,
        spanId: runRootSpanId(TRACE, RUN),
        runId: RUN,
        status: 'ok',
        finishedAt: '2026-07-18T19:37:00.479Z',
      });
      assert.equal(state.tables.trace_spans[0].duration_ms, 1_000);
    } finally {
      if (originalTz == null) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('mysql 会话 UTC 初始化接线', () => {
  // 行为细节（等待完成、失败致命、切端点）在 failover.unit.test.js；这里只钉住
  // 生产工厂确实换成了故障切换 client，而不是回到只挂 afterCreate 的旧形态。
  it('工厂使用故障切换 client，会话初始化不依赖 afterCreate', async () => {
    const knex = createMysqlKnex('mysql://u:p@127.0.0.1:3306/db', { pool: { max: 1 } });
    try {
      assert.equal(knex.client.constructor.name, 'FailoverMysql2Client');
      assert.equal(knex.client.config.pool.afterCreate, undefined);
      assert.equal(knex.client.driverName, 'mysql2');
    } finally {
      await destroyMysqlKnex(knex);
    }
  });
});
