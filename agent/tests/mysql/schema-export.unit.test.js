/**
 * 发布包 SQL 的渲染与解析（不连库）：记账行在段尾、含分号的语句加 DELIMITER、
 * 解析能原样还原语句、非法迁移名拒绝渲染。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReleaseSql,
  renderBookkeepingSql,
  renderSegmentSql,
} from '../../src/infrastructure/mysql/schema-export.js';

const TRIGGER = "CREATE TRIGGER trg_x BEFORE UPDATE ON tbl_agsvc_messages FOR EACH ROW SIGNAL SQLSTATE '45000'\n  SET MESSAGE_TEXT = 'append-only'";
const PROC_LIKE = 'CREATE TRIGGER trg_y BEFORE DELETE ON t FOR EACH ROW BEGIN SET @a = 1; SET @b = 2; END';

describe('schema release SQL', () => {
  it('renders statements, then the bookkeeping insert last', () => {
    const sql = renderSegmentSql({
      migration: '20260718000001_core_platform_schema.js',
      statements: ['create table `a` (`id` int)', TRIGGER],
    });
    const statements = parseReleaseSql(sql);
    assert.equal(statements.length, 3);
    assert.equal(statements[0], 'create table `a` (`id` int)');
    assert.equal(statements[1], TRIGGER);
    assert.match(statements[2], /^INSERT INTO knex_migrations \(name, batch, migration_time\) SELECT '20260718000001_core_platform_schema\.js'/);
    assert.ok(sql.lastIndexOf('INSERT INTO knex_migrations') > sql.lastIndexOf('CREATE TRIGGER'));
    assert.doesNotMatch(sql, /DELIMITER/, '无分号正文不需要换分隔符');
  });

  it('wraps a body containing semicolons in DELIMITER for the mysql client and parses it back intact', () => {
    const sql = renderSegmentSql({ migration: '20260912000001_claim_without_skip_locked.js', statements: [PROC_LIKE] });
    assert.match(sql, /DELIMITER \$\$\nCREATE TRIGGER trg_y[\s\S]*END\$\$\nDELIMITER ;/);
    assert.equal(parseReleaseSql(sql)[0], PROC_LIKE);
  });

  it('bookkeeping file carries the captured knex DDL only', () => {
    const sql = renderBookkeepingSql(['create table `knex_migrations` (`id` int)', 'insert into `knex_migrations_lock` (`is_locked`) values (0)']);
    assert.deepEqual(parseReleaseSql(sql), ['create table `knex_migrations` (`id` int)', 'insert into `knex_migrations_lock` (`is_locked`) values (0)']);
  });

  it('refuses a migration name that could inject SQL into the bookkeeping insert', () => {
    assert.throws(
      () => renderSegmentSql({ migration: "x'); DROP TABLE tbl_agsvc_runs; --.js", statements: [] }),
      /unexpected migration name/,
    );
  });
});
