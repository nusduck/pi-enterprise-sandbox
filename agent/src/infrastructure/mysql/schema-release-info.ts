/**
 * 发布包 `release.json` 的形状（design §6.1：起止迁移、迁移文件 hash、分段 SQL hash、
 * 清单 hash、验证/恢复说明）。单独成文件，导出器与重放器共用，也便于 DBA 侧工具读取。
 */

export const SCHEMA_RELEASE_FORMAT = 1;

export interface SchemaReleaseSegment {
  readonly name: string;
  readonly file: string;
  readonly migrationSha256: string;
  readonly sqlSha256: string;
}

export interface SchemaReleaseInfo {
  readonly format: number;
  readonly fromMigration: string | null;
  readonly toMigration: string | null;
  readonly bookkeepingFile: string | null;
  readonly bookkeepingSha256: string | null;
  readonly segments: readonly SchemaReleaseSegment[];
  readonly manifestFile: 'schema-manifest.json';
  readonly manifestSha256: string;
  readonly generatedWith: { readonly mysqlVersion: string };
  readonly instructions: readonly string[];
}

export function buildRelease(input: {
  readonly fromMigration: string | null;
  readonly bookkeepingFile: string | null;
  readonly bookkeepingSha256: string | null;
  readonly segments: readonly SchemaReleaseSegment[];
  readonly manifestSha256: string;
  readonly mysqlVersion: string;
}): SchemaReleaseInfo {
  return {
    format: SCHEMA_RELEASE_FORMAT,
    fromMigration: input.fromMigration,
    toMigration: input.segments.at(-1)?.name ?? input.fromMigration,
    bookkeepingFile: input.bookkeepingFile,
    bookkeepingSha256: input.bookkeepingSha256,
    segments: input.segments,
    manifestFile: 'schema-manifest.json',
    manifestSha256: input.manifestSha256,
    generatedWith: { mysqlVersion: input.mysqlVersion },
    instructions: [
      'Execute files in listed order with the mysql client: bookkeepingFile (first install only), then each segment.',
      'Stop at the first error. Never use --force. Never insert knex_migrations rows by hand.',
      'After the last segment, verify with `npm run schema:verify --prefix agent` (read-only) before starting services.',
      'On a failed segment follow docs/runbooks/mysql-partial-migration-recovery.md.',
    ],
  };
}
