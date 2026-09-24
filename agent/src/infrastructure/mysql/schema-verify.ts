/**
 * Agent / Agent Worker 启动前的 schema 核对（design §6.2，ADR 0011 D6）。
 *
 * 生产不自动迁移：DBA 按导出脚本建表。这里用 Knex 跑 contract 里的只读元数据查询，
 * 与随镜像分发的清单比对；有任何差异（缺表/列/索引/外键/触发器、多出未知对象、
 * 迁移记录不一致）都抛 `SchemaDriftError`，让进程在对外服务或消费任务之前退出。
 *
 * 只读：不 CREATE、不 ALTER、不补记版本。
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

type KnexLike = { raw: (sql: string) => Promise<unknown> };

function rowsOf(result: unknown): Record<string, unknown>[] {
  // mysql2 dialect: [rows, fields]
  const rows = Array.isArray(result) ? result[0] : result;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function isMissingTable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ER_NO_SUCH_TABLE';
}

/** 读当前库的真实结构，组装成与清单同形的对象。 */
export async function introspectSchema(knex: KnexLike): Promise<SchemaManifest> {
  // 逐条执行：启动核对只占一条连接，与 exec 侧一致。
  const entries: (readonly [string, Record<string, unknown>[]])[] = [];
  for (const [key, sql] of Object.entries(SCHEMA_METADATA_QUERIES)) {
    entries.push([key, rowsOf(await knex.raw(sql))] as const);
  }
  let migrations: string[] | null;
  try {
    migrations = rowsOf(await knex.raw(SCHEMA_MIGRATIONS_QUERY)).map((r) => String(r['name']));
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    migrations = null;
  }
  return buildSchemaManifest(Object.fromEntries(entries) as unknown as SchemaMetadataRows, migrations);
}

/**
 * 核对不通过即抛 `SchemaDriftError`。
 * `manifest` 仅供测试注入；生产读随包清单。
 */
export async function assertSchemaMatchesManifest(
  knex: KnexLike,
  opts: { readonly role: string; readonly manifest?: SchemaManifest | undefined },
): Promise<void> {
  const expected = opts.manifest ?? loadSchemaManifest();
  const drifts = diffSchemaManifest(expected, await introspectSchema(knex));
  if (drifts.length > 0) throw new SchemaDriftError(opts.role, drifts);
}
