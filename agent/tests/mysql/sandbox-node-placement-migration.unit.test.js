/**
 * Static unit tests for migration 20260805000001 (Sandbox node registry +
 * workspace placement expand).
 *
 * The placement columns are the load-bearing part of Sandbox multi-pod
 * operation, so their shape is asserted statically: additive + nullable on
 * existing tables, one new table, no FK back to `sandbox_nodes` (scale-down
 * removes node rows while history rows must survive), and index names that
 * runtime queries depend on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDX_SANDBOX_NODES_LIVENESS,
  IDX_SANDBOX_SESSIONS_NODE,
  IDX_PROCESS_EXECUTIONS_NODE,
  IDX_TOOL_EXECUTIONS_LEASE,
  NODE_ID_LENGTH,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260805000001_sandbox_node_placement.js';
import {
  PLACEMENT_TABLES,
} from '../../src/infrastructure/mysql/schema-tables.js';
import { CREATE_TABLE_MIGRATION_SENTINELS } from '../../src/infrastructure/mysql/migrate-orphan-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations',
);
const MIGRATION_FILE = '20260805000001_sandbox_node_placement.js';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);

/**
 * Slice one `alterTable('<table>', ...)` block out of the migration source.
 * @param {string} source
 * @param {string} table
 * @param {number} [occurrence] 0-based
 * @returns {string}
 */
function alterBlock(source, table, occurrence = 0) {
  const re = new RegExp(`alterTable\\(\\s*['"]${table}['"]`, 'g');
  let match;
  let seen = -1;
  while ((match = re.exec(source)) !== null) {
    seen += 1;
    if (seen === occurrence) {
      const next = source.indexOf('alterTable(', match.index + 10);
      return source.slice(match.index, next > 0 ? next : undefined);
    }
  }
  return '';
}

describe('20260805000001_sandbox_node_placement migration static', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');

  it('is listed among migrations and exports up/down + index names', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.includes(MIGRATION_FILE));
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
    assert.equal(IDX_SANDBOX_NODES_LIVENESS, 'idx_sandbox_nodes_liveness');
    assert.equal(IDX_SANDBOX_SESSIONS_NODE, 'idx_sandbox_sessions_node');
    assert.equal(IDX_PROCESS_EXECUTIONS_NODE, 'idx_process_executions_node');
    assert.equal(IDX_TOOL_EXECUTIONS_LEASE, 'idx_tool_executions_lease');
    assert.equal(NODE_ID_LENGTH, 64);
  });

  it('sorts after every pre-existing migration', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.js'))
      .sort();
    assert.equal(
      files[files.length - 1],
      MIGRATION_FILE,
      'placement migration must run last',
    );
  });

  it('creates sandbox_nodes with InnoDB/utf8mb4 and a liveness index', () => {
    assert.match(source, /createTable\(\s*['"]sandbox_nodes['"]/);
    const start = source.indexOf("createTable('sandbox_nodes'");
    const block = source.slice(start, source.indexOf('alterTable(', start));
    assert.match(block, /t\.engine\(\s*['"]InnoDB['"]\s*\)/);
    assert.match(block, /t\.charset\(\s*['"]utf8mb4['"]\s*\)/);
    assert.match(block, /t\.collate\(\s*['"]utf8mb4_unicode_ci['"]\s*\)/);
    for (const col of [
      'node_id',
      'address',
      'status',
      'generation',
      'started_at',
      'heartbeat_at',
      'created_at',
      'updated_at',
    ]) {
      assert.match(
        block,
        new RegExp(`['"]${col}['"]`),
        `sandbox_nodes missing ${col}`,
      );
    }
    assert.match(block, /\.primary\(\)/);
    // Placement candidate scan is (status, heartbeat_at) — order matters.
    assert.match(
      block,
      /index\(\s*\[\s*['"]status['"]\s*,\s*['"]heartbeat_at['"]\s*\]/,
    );
  });

  it('registers sandbox_nodes in the orphan gate and table groups', () => {
    assert.deepEqual([...PLACEMENT_TABLES], ['sandbox_nodes']);
    const sentinel = CREATE_TABLE_MIGRATION_SENTINELS.find(
      (s) => s.migrationName === MIGRATION_FILE,
    );
    assert.ok(sentinel, 'placement migration needs an orphan-gate sentinel');
    assert.deepEqual([...sentinel.tables], ['sandbox_nodes']);
  });

  it('adds nullable placement columns only (expand)', () => {
    const cases = [
      ['sandbox_sessions', ['node_id']],
      ['process_executions', ['node_id', 'node_generation']],
      ['artifacts', ['storage_node_id']],
      ['tool_executions', ['owner_node_id', 'lease_expires_at']],
    ];
    for (const [table, cols] of cases) {
      const block = alterBlock(source, table);
      assert.ok(block, `missing alterTable(${table})`);
      for (const col of cols) {
        assert.match(
          block,
          new RegExp(`['"]${col}['"][\\s\\S]{0,80}?\\.nullable\\s*\\(`),
          `${table}.${col} must be added as .nullable()`,
        );
      }
    }
  });

  it('declares placement lookup indexes with stable names', () => {
    assert.match(
      alterBlock(source, 'sandbox_sessions', 1),
      /index\(\s*\[\s*['"]node_id['"]\s*,\s*['"]status['"]\s*\][\s\S]*?IDX_SANDBOX_SESSIONS_NODE/,
    );
    assert.match(
      alterBlock(source, 'process_executions', 1),
      /index\(\s*\[\s*['"]node_id['"]\s*,\s*['"]status['"]\s*\][\s\S]*?IDX_PROCESS_EXECUTIONS_NODE/,
    );
    assert.match(
      alterBlock(source, 'tool_executions', 1),
      /index\(\s*\[\s*['"]status['"]\s*,\s*['"]lease_expires_at['"]\s*\][\s\S]*?IDX_TOOL_EXECUTIONS_LEASE/,
    );
  });

  it('never FKs placement columns to sandbox_nodes', () => {
    // Scale-down deletes node rows; sessions/processes rows are history and
    // must outlive the node they ran on.
    assert.doesNotMatch(source, /foreign\(/);
    assert.doesNotMatch(source, /references\(/);
  });

  it('has no backfill, NOT NULL expand, ENUM, or core-migration rewrite', () => {
    const upIdx = source.indexOf('export async function up');
    const downIdx = source.indexOf('export async function down');
    assert.ok(upIdx >= 0 && downIdx > upIdx);
    const upBody = source.slice(upIdx, downIdx);

    assert.doesNotMatch(upBody, /\bUPDATE\b/i);
    assert.doesNotMatch(upBody, /\bbackfill\b/i);
    assert.doesNotMatch(upBody, /\bENUM\s*\(/i);
    assert.doesNotMatch(source, /20260718000001/);
    assert.doesNotMatch(source, /sqlite/i);
    assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS/i);

    // notNullable() is legal only inside the new table, never on an alterTable.
    const createStart = upBody.indexOf("createTable('sandbox_nodes'");
    const firstAlter = upBody.indexOf('alterTable(');
    assert.ok(createStart >= 0 && firstAlter > createStart);
    const alterSection = upBody.slice(firstAlter);
    assert.doesNotMatch(
      alterSection,
      /\.notNullable\s*\(/,
      'expand columns on existing tables must stay nullable',
    );
  });

  it('down drops indexes before columns and the table last', () => {
    const downIdx = source.indexOf('export async function down');
    const downBody = source.slice(downIdx);

    const dropLeaseIdx = downBody.indexOf('IDX_TOOL_EXECUTIONS_LEASE');
    const dropLeaseCol = downBody.indexOf("dropColumn('lease_expires_at')");
    assert.ok(dropLeaseIdx >= 0 && dropLeaseCol > dropLeaseIdx);

    const dropProcIdx = downBody.indexOf('IDX_PROCESS_EXECUTIONS_NODE');
    const dropProcCol = downBody.indexOf("dropColumn('node_generation')");
    assert.ok(dropProcIdx >= 0 && dropProcCol > dropProcIdx);

    // Both process_executions and sandbox_sessions drop a `node_id`; the
    // sandbox_sessions one is last because its table is dropped from last.
    const dropSessIdx = downBody.indexOf('IDX_SANDBOX_SESSIONS_NODE');
    const dropSessCol = downBody.lastIndexOf("dropColumn('node_id')");
    assert.ok(dropSessIdx >= 0 && dropSessCol > dropSessIdx);

    const dropTable = downBody.indexOf("dropTableIfExists('sandbox_nodes')");
    assert.ok(dropTable > dropSessCol, 'sandbox_nodes dropped last');
  });

  it('migration module parses under node (syntax)', async () => {
    const mod = await import(
      '../../src/infrastructure/mysql/migrations/20260805000001_sandbox_node_placement.js'
    );
    assert.equal(typeof mod.up, 'function');
    assert.equal(typeof mod.down, 'function');
  });
});
