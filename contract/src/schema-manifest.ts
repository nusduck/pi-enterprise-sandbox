/**
 * Schema manifest：迁移产出的数据库结构「规范」，以及运行时的只读核对（design
 * `updrdb-dbpm-deployment.md` §6，ADR 0011 D6）。
 *
 * 为什么需要：生产没有 DDL 权限，建表改由 DBA 手工执行导出脚本。`knex_migrations`
 * 里记录齐全不代表对象真的在、真的对——漏一个 append-only 触发器、唯一键或后加列，
 * 版本表看不出来。所以 Agent / Worker / exec 在对外服务、消费任务、孤儿回收之前，
 * 都要按本清单核对真实元数据，不一致即拒绝启动。
 *
 * 为什么放 contract/：两侧用不同驱动（Knex / mysql2），但「查什么、怎么归一化、怎么比」
 * 必须是同一份。这里只有 SQL 字符串与纯函数，不依赖驱动；执行查询留在各包。
 *
 * 权威仍是 Agent 的 Knex migrations：清单由 CLI 在空影子库上跑完迁移后从真实
 * `information_schema` 生成（`npm run schema:manifest --prefix agent`），不手写。
 *
 * 归一化只抹掉 MySQL 5.7 / 8.0 的**表示差异**（整数显示宽度、`DEFAULT_GENERATED` 标记），
 * 不放过语义差异。触发器比较目标表、事件、时机与正文，不比较 definer / sql_mode
 * （DBA 执行时合法地不同）。元数据读不到等同对象缺失——看不见不算没有差异。
 */

import { readFileSync } from 'node:fs';

export const SCHEMA_MANIFEST_VERSION = 1;

export interface ColumnSpec {
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly extra: string;
  readonly charset: string | null;
  readonly collation: string | null;
  readonly generation: string | null;
}

export interface IndexSpec {
  readonly unique: boolean;
  readonly type: string;
  /** 列名；有前缀长度时写成 `col(191)`。 */
  readonly columns: readonly string[];
}

export interface ForeignKeySpec {
  readonly columns: readonly string[];
  readonly referencedTable: string;
  readonly referencedColumns: readonly string[];
  readonly onUpdate: string;
  readonly onDelete: string;
}

export interface TableSpec {
  readonly engine: string;
  readonly collation: string;
  readonly columns: Readonly<Record<string, ColumnSpec>>;
  readonly indexes: Readonly<Record<string, IndexSpec>>;
  readonly foreignKeys: Readonly<Record<string, ForeignKeySpec>>;
}

export interface TriggerSpec {
  readonly table: string;
  readonly event: string;
  readonly timing: string;
  readonly body: string;
}

export interface SchemaManifest {
  readonly version: number;
  /** 已应用迁移，按执行顺序。 */
  readonly migrations: readonly string[];
  /** 允许存在但不在清单里的表（发布包显式列出；默认空）。 */
  readonly allowedExtraTables: readonly string[];
  readonly tables: Readonly<Record<string, TableSpec>>;
  readonly triggers: Readonly<Record<string, TriggerSpec>>;
}

/** 核对用的元数据查询。都只看当前库（`DATABASE()`），无参数；列名用小写别名，屏蔽大小写差异。 */
export const SCHEMA_METADATA_QUERIES = Object.freeze({
  tables:
    "SELECT TABLE_NAME AS table_name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'",
  columns:
    'SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, GENERATION_EXPRESSION AS generation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
  indexes:
    'SELECT TABLE_NAME AS table_name, INDEX_NAME AS index_name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS column_name, SUB_PART AS sub_part, INDEX_TYPE AS index_type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()',
  foreignKeys:
    'SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name, k.COLUMN_NAME AS column_name, k.ORDINAL_POSITION AS seq, k.REFERENCED_TABLE_NAME AS referenced_table, k.REFERENCED_COLUMN_NAME AS referenced_column, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL',
  triggers:
    'SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()',
});

export type SchemaMetadataRows = {
  readonly [K in keyof typeof SCHEMA_METADATA_QUERIES]: readonly Record<string, unknown>[];
};

/** 迁移记账表不存在时由调用方传 `null`（→ 报「迁移记录缺失」，不是崩溃）。 */
export const SCHEMA_MIGRATIONS_QUERY = 'SELECT name AS name FROM knex_migrations ORDER BY id';

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function nullableStr(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** 5.7 显示 `bigint(20)`，8.0 显示 `bigint`；`tinyint(1)` 两边都保留（布尔语义）。 */
export function normalizeColumnType(columnType: string): string {
  const lower = columnType.trim().toLowerCase().replace(/\s+/g, ' ');
  return lower
    .replace(/^(smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1')
    .replace(/^tinyint\((?!1\))\d+\)/, 'tinyint');
}

/** 8.0 给表达式默认值加 `DEFAULT_GENERATED`，5.7 没有。 */
export function normalizeExtra(extra: string): string {
  return extra
    .replace(/\bDEFAULT_GENERATED\b/gi, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * InnoDB 里 `NO ACTION` 与 `RESTRICT` 语义相同（都立即检查）。5.7 对默认外键报
 * `RESTRICT`，8.0 报 `NO ACTION`——表示差异，统一成 `RESTRICT`；`CASCADE` / `SET NULL` 照常区分。
 */
export function normalizeReferentialAction(action: string): string {
  const upper = action.trim().toUpperCase().replace(/\s+/g, ' ');
  return upper === 'NO ACTION' ? 'RESTRICT' : upper;
}

export function normalizeTriggerBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

function sortedRecord<T>(entries: Iterable<[string, T]>): Record<string, T> {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 把元数据查询结果组装成清单。`migrations` 为 `null` 表示记账表不存在。 */
export function buildSchemaManifest(
  rows: SchemaMetadataRows,
  migrations: readonly string[] | null,
  opts: { readonly allowedExtraTables?: readonly string[] } = {},
): SchemaManifest {
  type MutableTable = {
    engine: string;
    collation: string;
    columns: Map<string, ColumnSpec>;
    indexes: Map<string, { unique: boolean; type: string; parts: [number, string][] }>;
    foreignKeys: Map<string, { referencedTable: string; onUpdate: string; onDelete: string; parts: [number, string, string][] }>;
  };
  const tables = new Map<string, MutableTable>();
  const table = (name: string): MutableTable => {
    let t = tables.get(name);
    if (t === undefined) {
      t = { engine: '', collation: '', columns: new Map(), indexes: new Map(), foreignKeys: new Map() };
      tables.set(name, t);
    }
    return t;
  };

  for (const r of rows.tables) {
    const t = table(str(r['table_name']));
    t.engine = str(r['engine']);
    t.collation = str(r['collation']);
  }
  for (const r of rows.columns) {
    if (!tables.has(str(r['table_name']))) continue; // 视图等非基表
    table(str(r['table_name'])).columns.set(str(r['column_name']), {
      type: normalizeColumnType(str(r['column_type'])),
      nullable: str(r['is_nullable']).toUpperCase() === 'YES',
      default: nullableStr(r['column_default']),
      extra: normalizeExtra(str(r['extra'])),
      charset: nullableStr(r['charset']),
      collation: nullableStr(r['collation']),
      generation: str(r['generation']) === '' ? null : str(r['generation']),
    });
  }
  for (const r of rows.indexes) {
    if (!tables.has(str(r['table_name']))) continue;
    const t = table(str(r['table_name']));
    const name = str(r['index_name']);
    let index = t.indexes.get(name);
    if (index === undefined) {
      index = { unique: Number(r['non_unique']) === 0, type: str(r['index_type']), parts: [] };
      t.indexes.set(name, index);
    }
    const sub = r['sub_part'];
    const column = str(r['column_name']);
    index.parts.push([Number(r['seq']), sub === null || sub === undefined ? column : `${column}(${Number(sub)})`]);
  }
  for (const r of rows.foreignKeys) {
    if (!tables.has(str(r['table_name']))) continue;
    const t = table(str(r['table_name']));
    const name = str(r['constraint_name']);
    let fk = t.foreignKeys.get(name);
    if (fk === undefined) {
      fk = {
        referencedTable: str(r['referenced_table']),
        onUpdate: normalizeReferentialAction(str(r['on_update'])),
        onDelete: normalizeReferentialAction(str(r['on_delete'])),
        parts: [],
      };
      t.foreignKeys.set(name, fk);
    }
    fk.parts.push([Number(r['seq']), str(r['column_name']), str(r['referenced_column'])]);
  }

  const byPosition = <P extends [number, ...string[]]>(parts: P[]): P[] => [...parts].sort((a, b) => a[0] - b[0]);

  return {
    version: SCHEMA_MANIFEST_VERSION,
    migrations: migrations === null ? [] : [...migrations],
    allowedExtraTables: [...(opts.allowedExtraTables ?? [])].sort(),
    tables: sortedRecord(
      [...tables].map(([name, t]): [string, TableSpec] => [
        name,
        {
          engine: t.engine,
          collation: t.collation,
          columns: sortedRecord(t.columns),
          indexes: sortedRecord(
            [...t.indexes].map(([n, i]): [string, IndexSpec] => [
              n,
              { unique: i.unique, type: i.type, columns: byPosition(i.parts).map((p) => p[1]) },
            ]),
          ),
          foreignKeys: sortedRecord(
            [...t.foreignKeys].map(([n, f]): [string, ForeignKeySpec] => {
              const parts = byPosition(f.parts);
              return [
                n,
                {
                  columns: parts.map((p) => p[1]),
                  referencedTable: f.referencedTable,
                  referencedColumns: parts.map((p) => p[2]),
                  onUpdate: f.onUpdate,
                  onDelete: f.onDelete,
                },
              ];
            }),
          ),
        },
      ]),
    ),
    triggers: sortedRecord(
      rows.triggers.map((r): [string, TriggerSpec] => [
        str(r['trigger_name']),
        {
          table: str(r['table_name']),
          event: str(r['event']).toUpperCase(),
          timing: str(r['timing']).toUpperCase(),
          body: normalizeTriggerBody(str(r['body'])),
        },
      ]),
    ),
  };
}

export type SchemaDriftKind =
  | 'migrations'
  | 'missing_table'
  | 'extra_table'
  | 'table'
  | 'missing_column'
  | 'extra_column'
  | 'column'
  | 'missing_index'
  | 'extra_index'
  | 'index'
  | 'missing_foreign_key'
  | 'extra_foreign_key'
  | 'foreign_key'
  | 'missing_trigger'
  | 'extra_trigger'
  | 'trigger';

export interface SchemaDrift {
  readonly kind: SchemaDriftKind;
  /** `table`、`table.column`、`table.index` 或触发器名。 */
  readonly object: string;
  readonly detail: string;
}

/**
 * Knex 自己的记账表：只核对**存在**，不比列/索引。它们由 Knex（或导出脚本）按驱动默认建，
 * 列定义随实例参数变化——实测 5.7（`explicit_defaults_for_timestamp=OFF`）给
 * `migration_time` 自动加 `NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE …`，8.0 不加。
 * 迁移是否齐全由 `migrations` 逐条核对，不依赖这些列。
 */
export const SCHEMA_BOOKKEEPING_TABLES: ReadonlySet<string> = new Set(['knex_migrations', 'knex_migrations_lock']);

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeDiff(expected: Record<string, unknown>, actual: Record<string, unknown>): string {
  return Object.keys(expected)
    .filter((key) => !same(expected[key], actual[key]))
    .map((key) => `${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(actual[key])}`)
    .join('; ');
}

function diffNamed<T extends object>(
  drifts: SchemaDrift[],
  prefix: string,
  expected: Readonly<Record<string, T>>,
  actual: Readonly<Record<string, T>>,
  kinds: { readonly missing: SchemaDriftKind; readonly extra: SchemaDriftKind; readonly changed: SchemaDriftKind },
): void {
  for (const [name, spec] of Object.entries(expected)) {
    const got = actual[name];
    const object = `${prefix}${name}`;
    if (got === undefined) drifts.push({ kind: kinds.missing, object, detail: 'not present' });
    else if (!same(spec, got)) {
      drifts.push({
        kind: kinds.changed,
        object,
        detail: describeDiff(spec as Record<string, unknown>, got as Record<string, unknown>),
      });
    }
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) drifts.push({ kind: kinds.extra, object: `${prefix}${name}`, detail: 'not in manifest' });
  }
}

/** 返回全部差异；空数组表示一致。 */
export function diffSchemaManifest(expected: SchemaManifest, actual: SchemaManifest): SchemaDrift[] {
  const drifts: SchemaDrift[] = [];
  if (!same(expected.migrations, actual.migrations)) {
    const missing = expected.migrations.filter((m) => !actual.migrations.includes(m));
    const unknown = actual.migrations.filter((m) => !expected.migrations.includes(m));
    drifts.push({
      kind: 'migrations',
      object: 'knex_migrations',
      detail:
        missing.length === 0 && unknown.length === 0
          ? 'recorded order differs from manifest'
          : `missing [${missing.join(', ')}]; unknown [${unknown.join(', ')}]`,
    });
  }

  const allowed = new Set(expected.allowedExtraTables);
  for (const [name, spec] of Object.entries(expected.tables)) {
    const got = actual.tables[name];
    if (got === undefined) {
      drifts.push({ kind: 'missing_table', object: name, detail: 'not present' });
      continue;
    }
    if (SCHEMA_BOOKKEEPING_TABLES.has(name)) continue;
    if (spec.engine !== got.engine || spec.collation !== got.collation) {
      drifts.push({
        kind: 'table',
        object: name,
        detail: describeDiff({ engine: spec.engine, collation: spec.collation }, { engine: got.engine, collation: got.collation }),
      });
    }
    diffNamed(drifts, `${name}.`, spec.columns, got.columns, { missing: 'missing_column', extra: 'extra_column', changed: 'column' });
    diffNamed(drifts, `${name}.`, spec.indexes, got.indexes, { missing: 'missing_index', extra: 'extra_index', changed: 'index' });
    diffNamed(drifts, `${name}.`, spec.foreignKeys, got.foreignKeys, {
      missing: 'missing_foreign_key',
      extra: 'extra_foreign_key',
      changed: 'foreign_key',
    });
  }
  for (const name of Object.keys(actual.tables)) {
    if (!(name in expected.tables) && !allowed.has(name)) {
      drifts.push({ kind: 'extra_table', object: name, detail: 'not in manifest' });
    }
  }
  diffNamed(drifts, '', expected.triggers, actual.triggers, { missing: 'missing_trigger', extra: 'extra_trigger', changed: 'trigger' });
  return drifts;
}

export class SchemaDriftError extends Error {
  override name = 'SchemaDriftError';
  readonly code = 'SCHEMA_DRIFT';
  readonly drifts: readonly SchemaDrift[];

  constructor(role: string, drifts: readonly SchemaDrift[]) {
    const shown = drifts.slice(0, 10).map((d) => `${d.kind} ${d.object}`).join(', ');
    const more = drifts.length > 10 ? ` (+${drifts.length - 10} more)` : '';
    super(`${role}: database schema does not match the release manifest — ${shown}${more}`);
    this.drifts = Object.freeze([...drifts]);
  }
}

/** 随包分发的清单路径（src 与 dist 都在 contract/ 下一层）。 */
export const BUNDLED_SCHEMA_MANIFEST_URL = new URL('../schema/schema-manifest.json', import.meta.url);

/** 读取并做最小形状校验。清单缺失或损坏时抛错——没有清单就不能证明 schema 正确。 */
export function loadSchemaManifest(url: URL = BUNDLED_SCHEMA_MANIFEST_URL): SchemaManifest {
  const parsed = JSON.parse(readFileSync(url, 'utf8')) as Partial<SchemaManifest>;
  if (
    parsed.version !== SCHEMA_MANIFEST_VERSION ||
    !Array.isArray(parsed.migrations) ||
    parsed.migrations.length === 0 ||
    typeof parsed.tables !== 'object' ||
    parsed.tables === null ||
    typeof parsed.triggers !== 'object' ||
    parsed.triggers === null
  ) {
    throw new Error('schema manifest is missing or malformed');
  }
  return { allowedExtraTables: [], ...parsed } as SchemaManifest;
}
