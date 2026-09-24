/**
 * exec 启动前的 schema 核对（design §6.2，ADR 0011 D6）。
 *
 * 迁移权威在 Agent；exec 只运行通用只读核对器：用 mysql2 跑 contract 里的元数据查询，
 * 与随镜像分发的清单比对，不一致即抛 `SchemaDriftError`。调用方必须在孤儿回收与
 * listen 之前调用——孤儿回收会写 `exec_jobs`，结构不对时不能先动账本。
 */

import {
  buildSchemaManifest,
  diffSchemaManifest,
  loadSchemaManifest,
  SCHEMA_METADATA_QUERIES,
  SCHEMA_MIGRATIONS_QUERY,
  SchemaDriftError,
  type SchemaManifest,
  type SchemaMetadataRows,
} from '@dsh/contract/schema-manifest.js';

import type { ExecDbPool } from './failover-pool.js';

type QueryPool = Pick<ExecDbPool, 'query'>;

async function rows(pool: QueryPool, sql: string): Promise<Record<string, unknown>[]> {
  const [result] = (await pool.query(sql)) as unknown as [unknown];
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

export async function introspectSchema(pool: QueryPool): Promise<SchemaManifest> {
  // 逐条执行：启动核对只占一条连接，连不上时也只有一次失败的建连。
  const entries: (readonly [string, Record<string, unknown>[]])[] = [];
  for (const [key, sql] of Object.entries(SCHEMA_METADATA_QUERIES)) {
    entries.push([key, await rows(pool, sql)] as const);
  }
  let migrations: string[] | null;
  try {
    migrations = (await rows(pool, SCHEMA_MIGRATIONS_QUERY)).map((r) => String(r['name']));
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code !== 'ER_NO_SUCH_TABLE') throw err;
    migrations = null;
  }
  return buildSchemaManifest(Object.fromEntries(entries) as unknown as SchemaMetadataRows, migrations);
}

export async function assertSchemaMatchesManifest(
  pool: QueryPool,
  opts: { readonly role?: string; readonly manifest?: SchemaManifest | undefined } = {},
): Promise<void> {
  const expected = opts.manifest ?? loadSchemaManifest();
  const drifts = diffSchemaManifest(expected, await introspectSchema(pool));
  if (drifts.length > 0) throw new SchemaDriftError(opts.role ?? 'exec', drifts);
}
