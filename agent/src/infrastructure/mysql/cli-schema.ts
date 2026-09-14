#!/usr/bin/env node
/**
 * CLI：schema 清单与手工 DDL 发布包（design §6，ADR 0011 D6）。
 *
 *   npm run schema:manifest --prefix agent                    空影子库跑迁移 → 生成清单
 *   npm run schema:sql      --prefix agent -- --out DIR [--from MIGRATION]
 *                                                             空影子库导出分段 SQL 发布包
 *   npm run schema:replay   --prefix agent -- --dir DIR        在重放库执行发布包并核对清单
 *   npm run schema:verify   --prefix agent                    用清单核对一个库（只读）
 *
 * 地址：影子库 `SCHEMA_SHADOW_DATABASE_URL`、重放库 `SCHEMA_REPLAY_DATABASE_URL`、
 * 核对库 `SCHEMA_VERIFY_DATABASE_URL`（其次 `TEST_MYSQL_URL`）。都是带口令的完整 DSN——
 * 这是开发/DBA 工具，不是应用服务，不走 DBPM；影子库与重放库需要 DDL 权限，只给一次性库。
 *
 * 影子库非空直接拒绝：从一个已经漂移的库生成清单/脚本，等于把漂移写成规范。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLED_SCHEMA_MANIFEST_URL,
  diffSchemaManifest,
  loadSchemaManifest,
  type SchemaManifest,
} from '@pi/contract/schema-manifest.js';

import { createMysqlKnex, destroyMysqlKnex, migrationsDirectory } from './client.js';
import { migrateLatest } from './migrate.js';
import { exportMigrationSql, replaySchemaRelease, writeSchemaRelease } from './schema-export.js';
import { introspectSchema } from './schema-verify.js';

// 经 contract 包定位：tsx 跑源码与镜像里跑 dist 时目录深度不同，相对本文件的路径会错。
const DEFAULT_MANIFEST = fileURLToPath(BUNDLED_SCHEMA_MANIFEST_URL);

type Knex = import('knex').Knex;

/**
 * 取 DSN。`<NAME>_PASSWORD`（例如 `SCHEMA_VERIFY_PASSWORD`）存在时覆盖 URL 里的口令：
 * 脚本可以把口令单独传入，不必自己做 URL 编码（口令含 `@`、`:` 时拼 URL 会连不上）。
 */
function requireUrl(names: readonly string[]): string {
  for (const name of names) {
    const value = String(process.env[name] ?? '').trim();
    if (value === '') continue;
    const password = process.env[name.replace(/_DATABASE_URL$|_URL$/, '_PASSWORD')];
    if (password === undefined || password === '') return value;
    const url = new URL(value);
    url.password = encodeURIComponent(password);
    return url.toString();
  }
  throw new Error(`set ${names.join(' or ')}`);
}

function arg(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 迁移文件的 sha256，便于核对产物出自哪一版迁移。 */
export function migrationFileHashes(): Record<string, string> {
  const dir = migrationsDirectory();
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => [f, createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex')]),
  );
}

async function withKnex<T>(url: string, fn: (knex: Knex) => Promise<T>): Promise<T> {
  const knex = createMysqlKnex(url, { pool: { min: 0, max: 1 } });
  try {
    return await fn(knex);
  } finally {
    await destroyMysqlKnex(knex);
  }
}

async function mysqlVersion(knex: Knex): Promise<string> {
  const [[row]] = (await knex.raw('SELECT VERSION() AS v')) as unknown as [[{ v: string }]];
  return String(row.v);
}

function assertMatchesBundled(actual: SchemaManifest, context: string): void {
  const drifts = diffSchemaManifest(loadSchemaManifest(), actual);
  if (drifts.length > 0) {
    throw new Error(
      `${context} does not match the bundled manifest (${drifts.length} drift(s), e.g. ${drifts[0]?.kind} ${drifts[0]?.object}); regenerate it with schema:manifest`,
    );
  }
}

async function generateManifest(out: string): Promise<void> {
  await withKnex(requireUrl(['SCHEMA_SHADOW_DATABASE_URL']), async (knex) => {
    const [[{ n }]] = (await knex.raw(
      'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
    )) as unknown as [[{ n: number }]];
    if (Number(n) !== 0) {
      throw new Error('shadow database is not empty; generate the manifest from a fresh, dedicated database');
    }
    await migrateLatest(knex);
    const manifest = await introspectSchema(knex);
    if (JSON.stringify(manifest.migrations) !== JSON.stringify(Object.keys(migrationFileHashes()))) {
      throw new Error('applied migrations do not match the migrations directory');
    }
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify({ ok: true, out, migrations: manifest.migrations.length, tables: Object.keys(manifest.tables).length, triggers: Object.keys(manifest.triggers).length }));
  });
}

async function exportSql(out: string, fromMigration: string | undefined): Promise<void> {
  await withKnex(requireUrl(['SCHEMA_SHADOW_DATABASE_URL']), async (knex) => {
    const exported = await exportMigrationSql(knex, { migrationsDirectory: migrationsDirectory(), fromMigration });
    // 导出后的影子库就是发布的目标状态：必须与随包清单一致，否则清单过期。
    assertMatchesBundled(await introspectSchema(knex), 'exported schema');
    const release = writeSchemaRelease(out, exported, {
      manifestJson: readFileSync(DEFAULT_MANIFEST, 'utf8'),
      migrationsDirectory: migrationsDirectory(),
      fromMigration,
      mysqlVersion: await mysqlVersion(knex),
    });
    console.log(JSON.stringify({ ok: true, out, fromMigration: release.fromMigration, toMigration: release.toMigration, segments: release.segments.length, bookkeeping: release.bookkeepingFile !== null }));
  });
}

async function replay(dir: string): Promise<void> {
  await withKnex(requireUrl(['SCHEMA_REPLAY_DATABASE_URL']), async (knex) => {
    const release = await replaySchemaRelease(knex, dir);
    assertMatchesBundled(await introspectSchema(knex), 'replayed schema');
    console.log(JSON.stringify({ ok: true, dir, toMigration: release.toMigration, drifts: 0 }));
  });
}

async function verify(): Promise<void> {
  await withKnex(requireUrl(['SCHEMA_VERIFY_DATABASE_URL', 'TEST_MYSQL_URL']), async (knex) => {
    const drifts = diffSchemaManifest(loadSchemaManifest(), await introspectSchema(knex));
    console.log(JSON.stringify({ ok: drifts.length === 0, drifts }, null, 2));
    if (drifts.length > 0) process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'manifest') await generateManifest(path.resolve(arg(args, '--out') ?? DEFAULT_MANIFEST));
  else if (cmd === 'sql') {
    const out = arg(args, '--out');
    if (!out) throw new Error('schema:sql requires --out DIR');
    await exportSql(path.resolve(out), arg(args, '--from'));
  } else if (cmd === 'replay') {
    const dir = arg(args, '--dir');
    if (!dir) throw new Error('schema:replay requires --dir DIR');
    await replay(path.resolve(dir));
  } else if (cmd === 'verify') await verify();
  else {
    console.error('usage: cli-schema.ts manifest [--out FILE] | sql --out DIR [--from MIGRATION] | replay --dir DIR | verify');
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
