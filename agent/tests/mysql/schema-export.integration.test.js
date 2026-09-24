/**
 * Gated live integration: 手工 DDL 发布包（design §6.1 / §6.2，验收矩阵 T4）。
 *
 * - 首装：空影子库导出 → 在另一个空库逐段重放 → 与随包清单零差异；
 * - 增量：从基线导出新增段 → 在基线库重放 → 零差异；
 * - 中途失败：首个错误即停，失败段不记账，后续段不执行。
 *
 * Requires TEST_SCHEMA_SHADOW_URL 与 TEST_SCHEMA_REPLAY_URL，库名必须分别含 `shadow` / `replay`
 * （测试会清空它们）。
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SHADOW = (process.env.TEST_SCHEMA_SHADOW_URL || '').trim();
const REPLAY = (process.env.TEST_SCHEMA_REPLAY_URL || '').trim();
const dbName = (url) => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
};
const runLive = /shadow/.test(dbName(SHADOW)) && /replay/.test(dbName(REPLAY));
const describeLive = runLive ? describe : describe.skip;

describe('schema export integration gate', () => {
  it('documents skip when the dedicated shadow/replay databases are not configured', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('schema release export and replay (TEST_SCHEMA_SHADOW_URL / TEST_SCHEMA_REPLAY_URL)', () => {
  let client;
  let exporter;
  let verify;
  let migrationsDir;
  let shadow;
  let replay;
  const dirs = [];

  async function reset(knex, name) {
    assert.match(name, /shadow|replay/, 'refusing to wipe a database that is not a dedicated shadow/replay db');
    await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
    const [rows] = await knex.raw('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    for (const { t } of rows) await knex.raw(`DROP TABLE \`${t}\``);
    await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
  }

  const drifts = async (knex) => {
    const { diffSchemaManifest, loadSchemaManifest } = await import('@dsh/contract/schema-manifest.js');
    return diffSchemaManifest(loadSchemaManifest(), await verify.introspectSchema(knex)).map((d) => `${d.kind} ${d.object}`);
  };

  const tmp = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'schema-release-'));
    dirs.push(d);
    return d;
  };

  beforeEach(async () => {
    client ??= await import('../../src/infrastructure/mysql/client.js');
    exporter ??= await import('../../src/infrastructure/mysql/schema-export.js');
    verify ??= await import('../../src/infrastructure/mysql/schema-verify.js');
    migrationsDir ??= client.migrationsDirectory();
    shadow ??= client.createMysqlKnex(SHADOW, { pool: { min: 0, max: 1 } });
    replay ??= client.createMysqlKnex(REPLAY, { pool: { min: 0, max: 1 } });
    await reset(shadow, dbName(SHADOW));
    await reset(replay, dbName(REPLAY));
  });

  after(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    await shadow?.destroy();
    await replay?.destroy();
  });

  const writeRelease = async (exported, fromMigration) => {
    const dir = tmp();
    const manifestJson = readFileSync(new URL('../../../contract/schema/schema-manifest.json', import.meta.url), 'utf8');
    exporter.writeSchemaRelease(dir, exported, { manifestJson, migrationsDirectory: migrationsDir, fromMigration, mysqlVersion: 'test' });
    return dir;
  };

  it('first install: export on an empty shadow, replay on an empty database, zero drift', async () => {
    const exported = await exporter.exportMigrationSql(shadow, { migrationsDirectory: migrationsDir });
    const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.js')).sort();
    assert.deepEqual(exported.segments.map((s) => s.migration), all);
    assert.ok(exported.bookkeeping.some((s) => /create table `knex_migrations`/.test(s)));
    const business = exported.segments.flatMap((s) => s.statements);
    assert.equal(business.filter((s) => /^\s*CREATE TRIGGER/i.test(s)).length, 4);
    assert.equal(business.filter((s) => /knex_migrations|information_schema|^\s*(select|begin|commit)/i.test(s)).length, 0);
    assert.deepEqual(await drifts(shadow), [], 'exported shadow must equal the bundled manifest');

    const dir = await writeRelease(exported);
    const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'));
    assert.equal(release.segments.length, all.length);
    assert.equal(release.fromMigration, null);

    await exporter.replaySchemaRelease(replay, dir);
    assert.deepEqual(await drifts(replay), []);
    const [names] = await replay.raw('SELECT name FROM knex_migrations ORDER BY id');
    assert.deepEqual(names.map((r) => r.name), all);
  });

  it('incremental: export after a baseline, replay on the baseline database, zero drift', async () => {
    const all = readdirSync(migrationsDir).filter((f) => f.endsWith('.js')).sort();
    const baseline = all.at(-2);
    const cfg = { directory: migrationsDir, tableName: 'knex_migrations', extension: 'js', loadExtensions: ['.js'] };
    for (let i = 0; i < all.length - 1; i += 1) await replay.migrate.up(cfg);

    const exported = await exporter.exportMigrationSql(shadow, { migrationsDirectory: migrationsDir, fromMigration: baseline });
    assert.deepEqual(exported.bookkeeping, []);
    assert.deepEqual(exported.segments.map((s) => s.migration), [all.at(-1)]);

    const dir = await writeRelease(exported, baseline);
    await exporter.replaySchemaRelease(replay, dir);
    assert.deepEqual(await drifts(replay), []);
  });

  it('a failing segment stops the run and is not recorded', async () => {
    const exported = await exporter.exportMigrationSql(shadow, { migrationsDirectory: migrationsDir });
    const dir = await writeRelease(exported);
    const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8'));
    const victim = release.segments[1];
    const file = path.join(dir, victim.file);
    const broken = readFileSync(file, 'utf8').replace('-- 记账：', '-- @statement\nALTER TABLE `no_such_table` ADD COLUMN `x` INT;\n-- 记账：');
    writeFileSync(file, broken);
    victim.sqlSha256 = (await import('node:crypto')).createHash('sha256').update(broken).digest('hex');
    writeFileSync(path.join(dir, 'release.json'), JSON.stringify(release));

    await assert.rejects(exporter.replaySchemaRelease(replay, dir), (err) => {
      assert.equal(err.file, victim.file);
      assert.match(err.message, /stopped before later segments/);
      return true;
    });
    const [names] = await replay.raw('SELECT name FROM knex_migrations ORDER BY id');
    assert.deepEqual(names.map((r) => r.name), [release.segments[0].name], '失败段与后续段都不能被记账');
  });

  it('refuses to export from a non-empty shadow database', async () => {
    await shadow.raw('CREATE TABLE stray (id INT PRIMARY KEY)');
    await assert.rejects(exporter.exportMigrationSql(shadow, { migrationsDirectory: migrationsDir }), /not empty/);
  });
});
