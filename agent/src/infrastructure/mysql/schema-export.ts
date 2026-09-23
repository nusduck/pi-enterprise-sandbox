/**
 * 手工 DDL 发布包：从 Knex migrations 导出按迁移分段的 SQL，并能在另一个库上重放核对
 * （design `updrdb-dbpm-deployment.md` §6.1 / §6.2，ADR 0011 D6）。
 *
 * 为什么是「在影子库上真跑一遍迁移，捕获 query 事件」：migrations 仍是唯一权威，
 * 导出的 SQL 就是驱动实际发给服务端的语句，不手写第二份。捕获时区分三类：
 * - 业务 DDL/DML（CREATE/ALTER/DROP/SET/INSERT/…）→ 进入该迁移的段；
 * - Knex 自身的记账与锁（`knex_migrations*`）、`information_schema` 探测、事务控制 → 丢弃；
 * - 首次运行时 Knex 建记账表的语句 → 单独的 `0000` 段，只在首装包里出现。
 *
 * 每段最后一行才写 `knex_migrations` 记账：DBA 用 mysql 客户端逐段执行，首个错误即停，
 * 失败段不会被记成已完成（MySQL DDL 不能靠外层事务回滚，见部分迁移恢复 runbook）。
 *
 * 局限（写进发布说明）：迁移若按数据分支（例如 `hasTable` 判断），导出结果是**空影子库**
 * 上走过的那条分支；只适用于首装或从声明的基线增量，不能拿去改一个状态未知的库。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildRelease, type SchemaReleaseInfo } from './schema-release-info.js';

type Knex = import('knex').Knex;

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+\.js$/;
const STATEMENT_MARKER = '-- @statement';
const KEEP = /^(create|alter|drop|rename|truncate|set|insert|update|delete|replace)\b/i;

export interface ExportedSegment {
  readonly migration: string;
  readonly statements: readonly string[];
}

export interface MigrationSqlExport {
  /** 首装时建 Knex 记账表的语句；增量导出为空。 */
  readonly bookkeeping: readonly string[];
  readonly segments: readonly ExportedSegment[];
}

function migrationConfig(directory: string) {
  return { directory, tableName: 'knex_migrations', extension: 'js', loadExtensions: ['.js'] };
}

async function tableCount(knex: Knex): Promise<number> {
  const [[row]] = (await knex.raw(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()',
  )) as unknown as [[{ n: number }]];
  return Number(row.n);
}

function pendingName(listed: unknown): string | undefined {
  const pending = (listed as [unknown, Array<{ file?: string; name?: string } | string>])[1] ?? [];
  const first = pending[0];
  if (first === undefined) return undefined;
  return typeof first === 'string' ? first : (first.file ?? first.name);
}

/**
 * 在**空影子库**上跑迁移并捕获语句。`fromMigration` 给定时，先不捕获地迁到该基线
 * （含它），之后的迁移才导出。
 */
export async function exportMigrationSql(
  knex: Knex,
  opts: { readonly migrationsDirectory: string; readonly fromMigration?: string | undefined },
): Promise<MigrationSqlExport> {
  if ((await tableCount(knex)) !== 0) {
    throw new Error('shadow database is not empty; export from a fresh, dedicated database');
  }
  const cfg = migrationConfig(opts.migrationsDirectory);
  let phase: 'baseline' | 'bookkeeping' | string = opts.fromMigration ? 'baseline' : 'bookkeeping';
  const bookkeeping: string[] = [];
  // 按迁移顺序收集；只追加当前段，不需要按键查找，所以用数组而不是 Map。
  const segments: { migration: string; statements: string[] }[] = [];
  let current: string[] | null = null;

  const listener = (q: { sql?: unknown; bindings?: unknown }) => {
    if (phase === 'baseline' || typeof q.sql !== 'string') return;
    const sql = q.sql.trim();
    const bindings = Array.isArray(q.bindings) ? q.bindings : [];
    const formatted = bindings.length > 0 ? knex.raw(sql, bindings).toQuery() : sql;
    const isBookkeeping = /`?knex_migrations(_lock)?`?/.test(sql);
    if (phase === 'bookkeeping') {
      // 首次 list/up 前后 Knex 建表并初始化锁行；其余都是只读探测。
      if (isBookkeeping && /^(create table|insert into)/i.test(sql)) bookkeeping.push(formatted);
      return;
    }
    if (isBookkeeping || /information_schema/i.test(sql) || !KEEP.test(sql)) return;
    current?.push(formatted);
  };
  knex.on('query', listener);

  try {
    if (opts.fromMigration) {
      for (;;) {
        const next = pendingName(await knex.migrate.list(cfg));
        if (next === undefined) throw new Error(`baseline migration ${opts.fromMigration} not found`);
        await knex.migrate.up(cfg);
        if (next === opts.fromMigration) break;
      }
    } else {
      // 让 Knex 建记账表（首次 list 就会建），捕获进 bookkeeping 段。
      await knex.migrate.list(cfg);
    }

    for (;;) {
      const next = pendingName(await knex.migrate.list(cfg));
      if (next === undefined) break;
      if (!MIGRATION_NAME.test(next)) throw new Error(`unexpected migration file name: ${next}`);
      phase = next;
      current = [];
      segments.push({ migration: next, statements: current });
      const [, ran] = (await knex.migrate.up(cfg)) as unknown as [number, string[]];
      if (!ran.includes(next)) throw new Error(`migration ${next} did not run`);
    }
  } finally {
    knex.removeListener('query', listener);
  }

  if (!opts.fromMigration && bookkeeping.length === 0) {
    throw new Error('did not capture knex bookkeeping DDL');
  }
  return { bookkeeping, segments };
}

function statementBlock(statement: string): string {
  const body = statement.trim().replace(/;\s*$/, '');
  // 触发器/存储过程正文里有分号时，mysql 客户端需要换分隔符；服务端驱动不认 DELIMITER。
  return body.includes(';')
    ? `${STATEMENT_MARKER}\nDELIMITER $$\n${body}$$\nDELIMITER ;\n`
    : `${STATEMENT_MARKER}\n${body};\n`;
}

export function renderBookkeepingSql(statements: readonly string[]): string {
  return [
    '-- dsh-enterprise-sandbox schema release: Knex bookkeeping tables (first install only)',
    '-- 执行：mysql <db> < 本文件；首个错误即停，禁止 --force。',
    ...statements.map(statementBlock),
  ].join('\n');
}

export function renderSegmentSql(segment: ExportedSegment): string {
  if (!MIGRATION_NAME.test(segment.migration)) {
    throw new Error(`refusing to render unexpected migration name: ${segment.migration}`);
  }
  return [
    `-- dsh-enterprise-sandbox schema release segment: ${segment.migration}`,
    `-- statements: ${segment.statements.length}`,
    '-- 执行：mysql <db> < 本文件；首个错误即停，禁止 --force。失败时不要补记版本，按',
    '-- docs/runbooks/mysql-partial-migration-recovery.md 判断继续或清理范围。',
    ...segment.statements.map(statementBlock),
    '-- 记账：只有上面每条语句都成功才会执行到这里。',
    statementBlock(
      `INSERT INTO knex_migrations (name, batch, migration_time) SELECT '${segment.migration}', COALESCE(MAX(batch), 0) + 1, CURRENT_TIMESTAMP FROM knex_migrations`,
    ),
  ].join('\n');
}

/** 解析本模块渲染的 SQL 文件，得到逐条语句（去掉注释、DELIMITER 与结尾分隔符）。 */
export function parseReleaseSql(text: string): string[] {
  return text
    .split(`${STATEMENT_MARKER}\n`)
    .slice(1)
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !/^DELIMITER\b/.test(line) && !/^--/.test(line))
        .join('\n')
        .trim()
        .replace(/(\$\$|;)$/, '')
        .trim(),
    )
    .filter((s) => s !== '');
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 写发布包：分段 SQL + 清单副本 + release.json。返回 release 信息。 */
export function writeSchemaRelease(
  dir: string,
  exported: MigrationSqlExport,
  opts: {
    readonly manifestJson: string;
    readonly migrationsDirectory: string;
    readonly fromMigration?: string | undefined;
    readonly mysqlVersion: string;
  },
): SchemaReleaseInfo {
  mkdirSync(dir, { recursive: true });
  const allMigrations = readdirSync(opts.migrationsDirectory).filter((f) => f.endsWith('.js')).sort();
  const files: { name: string; file: string; migrationSha256: string; sqlSha256: string }[] = [];

  let bookkeepingFile: string | null = null;
  if (exported.bookkeeping.length > 0) {
    bookkeepingFile = '0000_knex_bookkeeping.sql';
    writeFileSync(path.join(dir, bookkeepingFile), renderBookkeepingSql(exported.bookkeeping));
  }
  for (const segment of exported.segments) {
    const position = allMigrations.indexOf(segment.migration) + 1;
    if (position === 0) throw new Error(`migration ${segment.migration} is not in the migrations directory`);
    const file = `${String(position).padStart(4, '0')}_${segment.migration.replace(/\.js$/, '')}.sql`;
    const sql = renderSegmentSql(segment);
    writeFileSync(path.join(dir, file), sql);
    files.push({
      name: segment.migration,
      file,
      migrationSha256: sha256(readFileSync(path.join(opts.migrationsDirectory, segment.migration))),
      sqlSha256: sha256(sql),
    });
  }
  writeFileSync(path.join(dir, 'schema-manifest.json'), opts.manifestJson);
  const release = buildRelease({
    fromMigration: opts.fromMigration ?? null,
    bookkeepingFile,
    bookkeepingSha256: bookkeepingFile ? sha256(readFileSync(path.join(dir, bookkeepingFile))) : null,
    segments: files,
    manifestSha256: sha256(opts.manifestJson),
    mysqlVersion: opts.mysqlVersion,
  });
  writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

/**
 * 按发布包逐段执行（开发/验收用；DBA 用 mysql 客户端）。首个错误即抛出，后续段不执行。
 * 首装包要求空库；增量包要求库里最后一条迁移记录恰好是 `fromMigration`。
 */
export async function replaySchemaRelease(knex: Knex, dir: string): Promise<SchemaReleaseInfo> {
  const release = JSON.parse(readFileSync(path.join(dir, 'release.json'), 'utf8')) as SchemaReleaseInfo;
  if (release.fromMigration === null) {
    if ((await tableCount(knex)) !== 0) throw new Error('first-install release requires an empty database');
  } else {
    const [rows] = (await knex.raw('SELECT name FROM knex_migrations ORDER BY id DESC LIMIT 1')) as unknown as [
      Array<{ name: string }>,
    ];
    if (rows[0]?.name !== release.fromMigration) {
      throw new Error(`incremental release expects baseline ${release.fromMigration}`);
    }
  }
  const ordered = [
    ...(release.bookkeepingFile ? [{ file: release.bookkeepingFile, sqlSha256: release.bookkeepingSha256 ?? '' }] : []),
    ...release.segments,
  ];
  for (const entry of ordered) {
    const text = readFileSync(path.join(dir, entry.file), 'utf8');
    if (sha256(text) !== entry.sqlSha256) throw new Error(`${entry.file} does not match release.json sha256`);
    for (const statement of parseReleaseSql(text)) {
      try {
        await knex.raw(statement);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        throw Object.assign(new Error(`${entry.file} failed (${String(code ?? 'error')}); stopped before later segments`), {
          cause: err,
          file: entry.file,
        });
      }
    }
  }
  return release;
}
