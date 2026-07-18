/**
 * Static regression: migration source must not declare the same column twice
 * within a single createTable builder (e.g. domain_outbox.published_at).
 * Also covers Sandbox execution-domain tables, InnoDB/utf8mb4, indexes,
 * agent↔sandbox logical refs (no cyclic FK), and no prohibited fallback.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_TABLES_CREATE_ORDER,
  SANDBOX_EXECUTION_DOMAIN_TABLES,
} from '../../src/infrastructure/mysql/schema-tables.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations/20260718000001_core_platform_schema.js',
);

/** Knex column builder methods that take a column name as first string arg. */
const COLUMN_BUILDER_RE =
  /\bt\.(?:specificType|string|text|integer|bigInteger|json|boolean|uuid|timestamp|dateTime|datetime|binary|float|decimal|double|increments)\(\s*['"]([a-zA-Z0-9_]+)['"]/g;

/**
 * Extract createTable('name', (t) => { ... }) bodies via brace matching.
 * @param {string} source
 * @returns {Array<{ table: string, body: string }>}
 */
export function extractCreateTableBodies(source) {
  const results = [];
  const startRe = /createTable\(\s*['"]([a-zA-Z0-9_]+)['"]\s*,\s*\(\s*t\s*\)\s*=>\s*\{/g;
  let match;
  while ((match = startRe.exec(source)) !== null) {
    const table = match[1];
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      i += 1;
    }
    const body = source.slice(match.index + match[0].length, i - 1);
    results.push({ table, body });
  }
  return results;
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function listColumnBuilderNames(body) {
  /** @type {string[]} */
  const names = [];
  // utcMs(t) expands to created_at + updated_at
  if (/\butcMs\s*\(\s*t\s*\)/.test(body)) {
    names.push('created_at', 'updated_at');
  }
  COLUMN_BUILDER_RE.lastIndex = 0;
  let m;
  while ((m = COLUMN_BUILDER_RE.exec(body)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
export function findDuplicateNames(names) {
  const seen = new Set();
  const dups = new Set();
  for (const n of names) {
    if (seen.has(n)) dups.add(n);
    else seen.add(n);
  }
  return [...dups].sort();
}

describe('migration static column uniqueness', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');

  it('parses all createTable blocks', () => {
    const tables = extractCreateTableBodies(source);
    assert.ok(tables.length >= 18, `expected many tables, got ${tables.length}`);
    assert.ok(tables.some((t) => t.table === 'domain_outbox'));
    assert.ok(tables.some((t) => t.table === 'messages'));
    assert.ok(tables.some((t) => t.table === 'runs'));
    assert.ok(tables.some((t) => t.table === 'sandbox_sessions'));
    assert.ok(tables.some((t) => t.table === 'sandbox_executions'));
    assert.ok(tables.some((t) => t.table === 'sandbox_audit_events'));
  });

  it('has no duplicate column builders per table (covers published_at)', () => {
    const tables = extractCreateTableBodies(source);
    /** @type {Record<string, string[]>} */
    const failures = {};
    for (const { table, body } of tables) {
      const names = listColumnBuilderNames(body);
      const dups = findDuplicateNames(names);
      if (dups.length) failures[table] = dups;
    }
    assert.deepEqual(
      failures,
      {},
      `duplicate column builders: ${JSON.stringify(failures)}`,
    );

    const outbox = tables.find((t) => t.table === 'domain_outbox');
    assert.ok(outbox);
    const outboxCols = listColumnBuilderNames(outbox.body);
    const publishedCount = outboxCols.filter((c) => c === 'published_at').length;
    assert.equal(
      publishedCount,
      1,
      `domain_outbox.published_at must appear exactly once, got ${publishedCount}`,
    );
  });

  it('artifacts uk_artifact_file uses full-path hash under InnoDB 3072-byte limit', () => {
    const tables = extractCreateTableBodies(source);
    const art = tables.find((t) => t.table === 'artifacts');
    assert.ok(art, 'artifacts table required');
    // Must keep full relative_path column (plan §8.15) — not slash path limit.
    assert.match(art.body, /relative_path['"]\s*,\s*1024/);
    // Unique must index relative_path_hash (full-path digest), not raw relative_path.
    assert.match(art.body, /relative_path_hash/);
    assert.match(art.body, /GENERATED ALWAYS AS \(LOWER\(SHA2\(`relative_path`, 256\)\)\)/);
    assert.match(art.body, /uk_artifact_file/);
    assert.match(
      art.body,
      /\.unique\(\s*\[\s*['"]run_id['"]\s*,\s*['"]relative_path_hash['"]\s*,\s*['"]sha256['"]\s*\]/,
    );
    assert.doesNotMatch(
      art.body,
      /\.unique\(\s*\[\s*['"]run_id['"]\s*,\s*['"]relative_path['"]\s*,\s*['"]sha256['"]\s*\]/,
      'uk_artifact_file must not unique raw relative_path column',
    );
    // Worst-case InnoDB utf8mb4 index byte estimate for the unique key parts.
    const runIdBytes = 26 * 4; // CHAR(26) utf8mb4
    const pathHashBytes = 64; // ascii CHAR(64)
    const shaBytes = 64; // ascii CHAR(64) after migration
    const total = runIdBytes + pathHashBytes + shaBytes;
    assert.ok(total <= 3072, `uk_artifact_file estimate ${total} exceeds 3072`);
    // Contrast: old raw path key would fail.
    const legacy = runIdBytes + 1024 * 4 + 64 * 4;
    assert.ok(legacy > 3072, 'legacy key should exceed limit (regression oracle)');
  });

  it('defines stable message append-only triggers and drops them in down()', () => {
    assert.match(source, /MESSAGES_FORBID_UPDATE_TRIGGER\s*=\s*'trg_messages_forbid_update'/);
    assert.match(source, /MESSAGES_FORBID_DELETE_TRIGGER\s*=\s*'trg_messages_forbid_delete'/);
    assert.match(source, /BEFORE UPDATE ON messages/);
    assert.match(source, /BEFORE DELETE ON messages/);
    assert.match(source, /DROP TRIGGER IF EXISTS \$\{MESSAGES_FORBID_UPDATE_TRIGGER\}/);
    assert.match(source, /DROP TRIGGER IF EXISTS \$\{MESSAGES_FORBID_DELETE_TRIGGER\}/);
    // down drops triggers before tables
    const downIdx = source.indexOf('export async function down');
    const dropUpdate = source.indexOf('DROP TRIGGER IF EXISTS', downIdx);
    const dropMessages = source.indexOf("'messages'", downIdx);
    assert.ok(downIdx > 0 && dropUpdate > downIdx);
    assert.ok(
      dropUpdate < dropMessages,
      'down() must DROP message triggers before dropping messages table',
    );
  });
});

describe('migration static InnoDB/utf8mb4 + Sandbox domain', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');
  const tables = extractCreateTableBodies(source);
  const byName = Object.fromEntries(tables.map((t) => [t.table, t.body]));

  it('every createTable sets InnoDB + utf8mb4 + unicode_ci', () => {
    for (const { table, body } of tables) {
      assert.match(body, /t\.engine\(\s*['"]InnoDB['"]\s*\)/, `${table} engine`);
      assert.match(body, /t\.charset\(\s*['"]utf8mb4['"]\s*\)/, `${table} charset`);
      assert.match(
        body,
        /t\.collate\(\s*['"]utf8mb4_unicode_ci['"]\s*\)/,
        `${table} collate`,
      );
    }
  });

  it('includes Sandbox execution-domain tables in create order list', () => {
    for (const t of SANDBOX_EXECUTION_DOMAIN_TABLES) {
      assert.ok(
        CORE_TABLES_CREATE_ORDER.includes(t),
        `CORE_TABLES_CREATE_ORDER missing ${t}`,
      );
      assert.ok(byName[t], `migration missing createTable(${t})`);
    }
    // Create order: sandbox_sessions before children that FK it
    const ss = CORE_TABLES_CREATE_ORDER.indexOf('sandbox_sessions');
    const pe = CORE_TABLES_CREATE_ORDER.indexOf('process_executions');
    const se = CORE_TABLES_CREATE_ORDER.indexOf('sandbox_executions');
    assert.ok(ss >= 0 && pe > ss && se > ss);
  });

  it('process_executions has org_id/user_id ownership + useful indexes', () => {
    const body = byName.process_executions;
    assert.ok(body);
    const cols = listColumnBuilderNames(body);
    assert.ok(cols.includes('org_id'));
    assert.ok(cols.includes('user_id'));
    assert.ok(cols.includes('sandbox_session_id'));
    assert.match(body, /idx_process_executions_owner/);
    assert.match(body, /idx_process_executions_session/);
    assert.match(body, /idx_process_executions_run/);
    assert.match(body, /foreign\(\s*['"]org_id['"]\s*\)\.references\(/);
    assert.match(body, /['"]organizations\.org_id['"]/);
    assert.match(body, /foreign\(\s*['"]user_id['"]\s*\)\.references\(/);
    assert.match(body, /['"]users\.user_id['"]/);
    assert.match(body, /foreign\(\s*['"]sandbox_session_id['"]\s*\)\.references\(/);
    assert.match(body, /['"]sandbox_sessions\.sandbox_session_id['"]/);
  });

  it('sandbox_sessions has tenant ownership, lifecycle fields, and indexes', () => {
    const body = byName.sandbox_sessions;
    assert.ok(body);
    const cols = listColumnBuilderNames(body);
    for (const c of [
      'sandbox_session_id',
      'org_id',
      'user_id',
      'agent_session_id',
      'workspace_id',
      'status',
      'created_at',
      'updated_at',
      'closed_at',
    ]) {
      assert.ok(cols.includes(c), `sandbox_sessions missing ${c}`);
    }
    assert.match(body, /idx_sandbox_sessions_owner/);
    assert.match(body, /idx_sandbox_sessions_status/);
    assert.match(body, /uk_sandbox_sessions_agent_session_id/);
    assert.match(body, /uk_sandbox_sessions_workspace_id/);
  });

  it('sandbox_executions and sandbox_audit_events have ownership + indexes', () => {
    const execBody = byName.sandbox_executions;
    const auditBody = byName.sandbox_audit_events;
    assert.ok(execBody && auditBody);
    const execCols = listColumnBuilderNames(execBody);
    assert.ok(execCols.includes('org_id') && execCols.includes('user_id'));
    assert.ok(execCols.includes('kind') && execCols.includes('status'));
    assert.match(execBody, /idx_sandbox_executions_owner/);
    assert.match(execBody, /idx_sandbox_executions_session/);
    const auditCols = listColumnBuilderNames(auditBody);
    assert.ok(auditCols.includes('org_id') && auditCols.includes('user_id'));
    assert.ok(auditCols.includes('event_type'));
    assert.match(auditBody, /idx_sandbox_audit_owner/);
    assert.match(auditBody, /idx_sandbox_audit_trace/);
  });

  it('enforces 1:1 ownership uniques on agent_sessions and sandbox_sessions', () => {
    const agentBody = byName.agent_sessions;
    const sbxBody = byName.sandbox_sessions;
    assert.ok(agentBody && sbxBody);
    assert.match(agentBody, /uk_agent_sessions_workspace_id/);
    assert.match(agentBody, /uk_agent_sessions_sandbox_session_id/);
    assert.match(sbxBody, /uk_sandbox_sessions_agent_session_id/);
    assert.match(sbxBody, /uk_sandbox_sessions_workspace_id/);
    // Unique replaces non-unique index on the same columns
    assert.doesNotMatch(agentBody, /idx_agent_sessions_sandbox_session/);
    assert.doesNotMatch(sbxBody, /idx_sandbox_sessions_agent_session/);
  });

  it('avoids cyclic FK between agent_sessions and sandbox_sessions', () => {
    const agentBody = byName.agent_sessions;
    const sbxBody = byName.sandbox_sessions;
    assert.ok(agentBody && sbxBody);
    // agent_sessions has sandbox_session_id column + unique, but no FK to sandbox_sessions
    assert.match(agentBody, /sandbox_session_id/);
    assert.match(agentBody, /uk_agent_sessions_sandbox_session_id/);
    assert.doesNotMatch(
      agentBody,
      /foreign\(\s*['"]sandbox_session_id['"]\s*\)/,
    );
    // sandbox_sessions has agent_session_id column + unique, but no FK to agent_sessions
    assert.match(sbxBody, /agent_session_id/);
    assert.match(sbxBody, /uk_sandbox_sessions_agent_session_id/);
    assert.doesNotMatch(
      sbxBody,
      /foreign\(\s*['"]agent_session_id['"]\s*\)/,
    );
    // Header documents the relationship
    assert.match(source, /logical unique reference/i);
    assert.match(source, /no cyclic FK|avoids agent↔sandbox creation cycle/i);
  });

  it('prohibits SQLite / memory fallback patterns in migration source', () => {
    assert.doesNotMatch(source, /sqlite/i);
    assert.doesNotMatch(source, /:memory:/i);
    assert.doesNotMatch(source, /better-sqlite/i);
    assert.doesNotMatch(source, /CREATE TABLE IF NOT EXISTS/i);
  });

  it('uses string primary constraint name (no object indexName → as indexName)', () => {
    // Composite primary second arg must be a string — object options become
    // illegal "as indexName" SQL under Knex MySQL create-table primaryKeys().
    // Use [^\]] so we do not span from one .primary([...]) into a later .unique([...], {.
    assert.doesNotMatch(
      source,
      /\.primary\s*\(\s*\[[^\]]*\]\s*,\s*\{/,
      'primary must not use options object as second arg',
    );
    assert.match(
      source,
      /\.primary\(\s*\[[^\]]*\]\s*,\s*['"]pk_idempotency_records['"]\s*,?\s*\)/,
    );
    assert.match(source, /withPartialDdlCleanup/);
    assert.match(source, /tracker\.createTable/);
    assert.match(source, /tracker\.createTrigger/);
  });

  it('down() drops sandbox tables in FK-safe order', () => {
    const downIdx = source.indexOf('export async function down');
    const down = source.slice(downIdx);
    const auditIdx = down.indexOf("'sandbox_audit_events'");
    const execIdx = down.indexOf("'sandbox_executions'");
    const procIdx = down.indexOf("'process_executions'");
    const sessIdx = down.indexOf("'sandbox_sessions'");
    assert.ok(auditIdx > 0 && execIdx > 0 && procIdx > 0 && sessIdx > 0);
    // Children before parent sandbox_sessions
    assert.ok(auditIdx < sessIdx);
    assert.ok(execIdx < sessIdx);
    assert.ok(procIdx < sessIdx);
  });
});
