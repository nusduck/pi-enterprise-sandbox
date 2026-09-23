/**
 * Gated live integration: 随包 schema 清单与真实迁移结果一致，且核对器能挡住缺对象
 * （design §6.2 验收：「版本记录完整但删掉一个安全约束 / 后续表时必须拒绝启动」）。
 *
 * 第一条是**防漂移棘轮**：改了迁移却没重新生成 `contract/schema/schema-manifest.json`，
 * 这里就红。重新生成：`SCHEMA_SHADOW_DATABASE_URL=… npm run schema:manifest --prefix agent`。
 *
 * Requires TEST_MYSQL_URL（会回滚/重建迁移，务必指向一次性测试库）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const require = createRequire(import.meta.url);

function depsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const runLive = /^mysql2?:\/\//.test(TEST_MYSQL_URL) && depsAvailable();
const describeLive = runLive ? describe : describe.skip;

describe('schema manifest integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('schema manifest vs real migrations (TEST_MYSQL_URL)', () => {
  let knex;
  let verify;
  let migrate;

  const kindsOf = async () => {
    try {
      await verify.assertSchemaMatchesManifest(knex, { role: 'test' });
      return [];
    } catch (err) {
      assert.equal(err.code, 'SCHEMA_DRIFT', String(err));
      return err.drifts.map((d) => `${d.kind} ${d.object}`);
    }
  };

  before(async () => {
    const client = await import('../../src/infrastructure/mysql/client.js');
    migrate = await import('../../src/infrastructure/mysql/migrate.js');
    verify = await import('../../src/infrastructure/mysql/schema-verify.js');
    knex = client.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 2 } });
    await knex.raw('DROP TABLE IF EXISTS dba_scratch');
    await migrate.migrateRollbackAll(knex);
    await migrate.migrateLatest(knex);
  });

  after(async () => {
    if (!knex) return;
    await knex.raw('DROP TABLE IF EXISTS dba_scratch').catch(() => {});
    // 恢复成完整 schema，免得影响同库其它 live 测试。
    await migrate.migrateRollbackAll(knex).catch(() => {});
    await migrate.migrateLatest(knex).catch(() => {});
    await knex.destroy();
  });

  it('a freshly migrated database matches the bundled manifest exactly', async () => {
    assert.deepEqual(await kindsOf(), []);
  });

  it('a dropped append-only trigger is caught although knex_migrations is complete', async () => {
    const [[row]] = await knex.raw(
      "SELECT ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME = 'trg_messages_forbid_delete'",
    );
    await knex.raw('DROP TRIGGER trg_messages_forbid_delete');
    try {
      assert.deepEqual(await kindsOf(), ['missing_trigger trg_messages_forbid_delete']);
    } finally {
      await knex.raw(`CREATE TRIGGER trg_messages_forbid_delete BEFORE DELETE ON tbl_agsvc_messages FOR EACH ROW ${row.body}`);
    }
    assert.deepEqual(await kindsOf(), []);
  });

  it('a dropped later-migration column and a dropped unique key are both caught', async () => {
    await knex.raw('ALTER TABLE tbl_agsvc_cron_jobs DROP INDEX ind_agsvc_cj_i3');
    await knex.raw('ALTER TABLE tbl_agsvc_cron_jobs DROP COLUMN claim_token');
    try {
      const kinds = await kindsOf();
      assert.ok(kinds.includes('missing_column tbl_agsvc_cron_jobs.claim_token'), kinds.join(', '));
      assert.ok(kinds.includes('missing_index tbl_agsvc_cron_jobs.ind_agsvc_cj_i3'), kinds.join(', '));
    } finally {
      await knex.raw('ALTER TABLE tbl_agsvc_cron_jobs ADD COLUMN claim_token CHAR(26) NULL');
      await knex.raw('CREATE INDEX ind_agsvc_cj_i3 ON tbl_agsvc_cron_jobs (claim_token)');
    }
  });

  it('an unknown table and a missing migration record are rejected', async () => {
    await knex.raw('CREATE TABLE dba_scratch (id INT PRIMARY KEY)');
    const [last] = await knex('knex_migrations').orderBy('id', 'desc').limit(1);
    await knex('knex_migrations').where({ id: last.id }).del();
    try {
      const kinds = await kindsOf();
      assert.ok(kinds.includes('extra_table dba_scratch'), kinds.join(', '));
      assert.ok(kinds.includes('migrations knex_migrations'), kinds.join(', '));
    } finally {
      await knex.raw('DROP TABLE dba_scratch');
      await knex('knex_migrations').insert(last);
    }
  });
});
