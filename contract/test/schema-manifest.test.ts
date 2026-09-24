/**
 * `schema-manifest.ts` 的测试：5.7 / 8.0 表示差异被抹平、语义差异不被放过，
 * 以及缺对象、多对象、迁移记录不一致都能被报出来。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSchemaManifest,
  diffSchemaManifest,
  loadSchemaManifest,
  normalizeColumnType,
  normalizeExtra,
  normalizeReferentialAction,
  SchemaDriftError,
  type SchemaMetadataRows,
} from '../src/schema-manifest.js';

function rows(version: '5.7' | '8.0'): SchemaMetadataRows {
  const int = version === '5.7' ? 'bigint(20) unsigned' : 'bigint unsigned';
  const extra = version === '5.7' ? '' : 'DEFAULT_GENERATED';
  // 实测：同一条默认外键，5.7 报 RESTRICT，8.0 报 NO ACTION。
  const fkRule = version === '5.7' ? 'RESTRICT' : 'NO ACTION';
  return {
    tables: [
      { table_name: 'messages', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' },
      { table_name: 'conversations', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' },
    ],
    columns: [
      { table_name: 'messages', column_name: 'id', column_type: int, is_nullable: 'NO', column_default: null, extra: 'auto_increment', charset: null, collation: null, generation: '' },
      { table_name: 'messages', column_name: 'created_at', column_type: 'datetime(3)', is_nullable: 'NO', column_default: 'CURRENT_TIMESTAMP(3)', extra, charset: null, collation: null, generation: '' },
      { table_name: 'messages', column_name: 'is_final', column_type: 'tinyint(1)', is_nullable: 'NO', column_default: '0', extra: '', charset: null, collation: null, generation: '' },
      { table_name: 'messages', column_name: 'conversation_id', column_type: 'char(26)', is_nullable: 'NO', column_default: null, extra: '', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', generation: '' },
      { table_name: 'conversations', column_name: 'conversation_id', column_type: 'char(26)', is_nullable: 'NO', column_default: null, extra: '', charset: 'utf8mb4', collation: 'utf8mb4_unicode_ci', generation: '' },
    ],
    indexes: [
      { table_name: 'messages', index_name: 'PRIMARY', non_unique: 0, seq: 1, column_name: 'id', sub_part: null, index_type: 'BTREE' },
      { table_name: 'messages', index_name: 'uk_conv', non_unique: 0, seq: 2, column_name: 'created_at', sub_part: null, index_type: 'BTREE' },
      { table_name: 'messages', index_name: 'uk_conv', non_unique: 0, seq: 1, column_name: 'conversation_id', sub_part: 20, index_type: 'BTREE' },
    ],
    foreignKeys: [
      { table_name: 'messages', constraint_name: 'messages_conversation_id_foreign', column_name: 'conversation_id', seq: 1, referenced_table: 'conversations', referenced_column: 'conversation_id', on_update: fkRule, on_delete: fkRule },
    ],
    triggers: [
      { trigger_name: 'trg_messages_forbid_update', table_name: 'messages', event: 'UPDATE', timing: 'BEFORE', body: "SIGNAL SQLSTATE '45000'\n      SET MESSAGE_TEXT = 'messages is append-only'" },
    ],
  };
}

const MIGRATIONS = ['20260718000001_core_platform_schema.js', '20260912000001_claim_without_skip_locked.js'];

describe('normalization', () => {
  it('drops integer display width but keeps tinyint(1)', () => {
    assert.equal(normalizeColumnType('bigint(20) unsigned'), 'bigint unsigned');
    assert.equal(normalizeColumnType('int(11)'), 'int');
    assert.equal(normalizeColumnType('tinyint(1)'), 'tinyint(1)');
    assert.equal(normalizeColumnType('tinyint(4)'), 'tinyint');
    assert.equal(normalizeColumnType('varchar(64)'), 'varchar(64)');
    assert.equal(normalizeExtra('DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)'), 'on update current_timestamp(3)');
    assert.equal(normalizeReferentialAction('NO ACTION'), 'RESTRICT');
    assert.equal(normalizeReferentialAction('cascade'), 'CASCADE');
    assert.equal(normalizeReferentialAction('SET NULL'), 'SET NULL');
  });

  it('a 5.7 schema and the same schema on 8.0 produce identical manifests', () => {
    const m57 = buildSchemaManifest(rows('5.7'), MIGRATIONS);
    const m80 = buildSchemaManifest(rows('8.0'), MIGRATIONS);
    assert.deepEqual(m57, m80);
    assert.deepEqual(diffSchemaManifest(m57, m80), []);
    assert.deepEqual(m57.tables['messages']?.indexes['uk_conv']?.columns, ['conversation_id(20)', 'created_at']);
    assert.equal(m57.triggers['trg_messages_forbid_update']?.body, "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'messages is append-only'");
  });
});

describe('diffSchemaManifest', () => {
  const expected = buildSchemaManifest(rows('5.7'), MIGRATIONS);

  const mutate = (fn: (r: { -readonly [K in keyof SchemaMetadataRows]: Record<string, unknown>[] }) => void) => {
    const r = structuredClone(rows('5.7')) as { -readonly [K in keyof SchemaMetadataRows]: Record<string, unknown>[] };
    fn(r);
    return r;
  };

  it('reports a missing append-only trigger even when the migration records are complete', () => {
    const actual = buildSchemaManifest(mutate((r) => (r.triggers = [])), MIGRATIONS);
    assert.deepEqual(diffSchemaManifest(expected, actual), [
      { kind: 'missing_trigger', object: 'trg_messages_forbid_update', detail: 'not present' },
    ]);
  });

  it('reports a changed trigger body, a missing column, a lost unique key and a changed FK action', () => {
    const actual = buildSchemaManifest(
      mutate((r) => {
        r.triggers[0]!['body'] = 'BEGIN END';
        r.columns = r.columns.filter((c) => c['column_name'] !== 'is_final');
        r.indexes = r.indexes.filter((i) => i['index_name'] !== 'uk_conv');
        r.foreignKeys[0]!['on_delete'] = 'CASCADE';
      }),
      MIGRATIONS,
    );
    const kinds = diffSchemaManifest(expected, actual).map((d) => `${d.kind} ${d.object}`);
    assert.deepEqual(kinds.sort(), [
      'foreign_key messages.messages_conversation_id_foreign',
      'missing_column messages.is_final',
      'missing_index messages.uk_conv',
      'trigger trg_messages_forbid_update',
    ]);
  });

  it('reports a semantic column change (nullability, type) — normalization does not hide it', () => {
    const actual = buildSchemaManifest(
      mutate((r) => {
        r.columns[3]!['is_nullable'] = 'YES';
        r.columns[3]!['column_type'] = 'char(36)';
      }),
      MIGRATIONS,
    );
    const [drift] = diffSchemaManifest(expected, actual);
    assert.equal(drift?.kind, 'column');
    assert.match(drift?.detail ?? '', /type: expected "char\(26\)", got "char\(36\)"; nullable/);
  });

  it('rejects unknown tables unless the release lists them', () => {
    const actual = buildSchemaManifest(
      mutate((r) => r.tables.push({ table_name: 'dba_scratch', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' })),
      MIGRATIONS,
    );
    assert.deepEqual(diffSchemaManifest(expected, actual).map((d) => d.kind), ['extra_table']);
    const allowing = buildSchemaManifest(rows('5.7'), MIGRATIONS, { allowedExtraTables: ['dba_scratch'] });
    assert.deepEqual(diffSchemaManifest(allowing, actual), []);
  });

  it('reports missing, unknown and reordered migration records', () => {
    const missing = buildSchemaManifest(rows('5.7'), MIGRATIONS.slice(0, 1));
    assert.match(diffSchemaManifest(expected, missing)[0]?.detail ?? '', /missing \[20260912000001/);
    const none = buildSchemaManifest(rows('5.7'), null);
    assert.equal(diffSchemaManifest(expected, none)[0]?.kind, 'migrations');
    const reordered = buildSchemaManifest(rows('5.7'), [...MIGRATIONS].reverse());
    assert.match(diffSchemaManifest(expected, reordered)[0]?.detail ?? '', /order differs/);
  });

  it('knex bookkeeping tables are checked for presence only, not column definitions', () => {
    const withBookkeeping = (nullable: 'NO' | 'YES', dflt: string | null) =>
      mutate((r) => {
        r.tables.push({ table_name: 'knex_migrations', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci' });
        r.columns.push({ table_name: 'knex_migrations', column_name: 'migration_time', column_type: 'timestamp', is_nullable: nullable, column_default: dflt, extra: '', charset: null, collation: null, generation: '' });
      });
    const base = buildSchemaManifest(withBookkeeping('NO', 'CURRENT_TIMESTAMP'), MIGRATIONS);
    // 8.0（explicit_defaults_for_timestamp=ON）上同一张表的列定义不同——不算漂移。
    assert.deepEqual(diffSchemaManifest(base, buildSchemaManifest(withBookkeeping('YES', null), MIGRATIONS)), []);
    // 但记账表缺失照样报。
    assert.deepEqual(diffSchemaManifest(base, buildSchemaManifest(rows('5.7'), MIGRATIONS)).map((d) => d.kind), ['missing_table']);
  });

  it('SchemaDriftError names the role and caps the listed objects', () => {
    const drifts = Array.from({ length: 12 }, (_, i) => ({ kind: 'missing_table' as const, object: `t${i}`, detail: '' }));
    const err = new SchemaDriftError('agent-http', drifts);
    assert.match(err.message, /^agent-http: database schema does not match/);
    assert.match(err.message, /\(\+2 more\)$/);
    assert.equal(err.code, 'SCHEMA_DRIFT');
  });
});

describe('bundled manifest', () => {
  it('is present and well-formed (generated from real migrations, not hand-written)', () => {
    const manifest = loadSchemaManifest();
    assert.ok(manifest.migrations.length >= 27);
    assert.ok(Object.keys(manifest.tables).includes('knex_migrations'));
    for (const name of ['trg_messages_forbid_update', 'trg_messages_forbid_delete', 'trg_agent_session_snapshots_forbid_update', 'trg_agent_session_snapshots_forbid_delete']) {
      assert.ok(manifest.triggers[name], `manifest must pin ${name}`);
    }
  });
});
