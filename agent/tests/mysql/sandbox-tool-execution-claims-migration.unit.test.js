/**
 * PR-07B batch 2A1: static unit tests for migration 000008
 * (sandbox tool-execution claim expand — nullable columns only).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UK_SANDBOX_EXECUTION_RUN_TOOL_CALL,
  UK_SANDBOX_EXECUTION_TOOL_EXECUTION,
  FK_SANDBOX_EXECUTION_TOOL_EXECUTION,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260718000008_sandbox_tool_execution_claims.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations',
);
const MIGRATION_FILE = '20260718000008_sandbox_tool_execution_claims.js';
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);

describe('20260718000008_sandbox_tool_execution_claims migration static', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');

  it('is listed among migrations and exports up/down + constraint names', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.includes(MIGRATION_FILE));
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
    assert.equal(
      UK_SANDBOX_EXECUTION_RUN_TOOL_CALL,
      'uk_sandbox_execution_run_tool_call',
    );
    assert.equal(
      UK_SANDBOX_EXECUTION_TOOL_EXECUTION,
      'uk_sandbox_execution_tool_execution',
    );
    assert.equal(
      FK_SANDBOX_EXECUTION_TOOL_EXECUTION,
      'fk_sandbox_execution_tool_execution',
    );
  });

  it('adds nullable claim columns on tool_executions (expand-only)', () => {
    assert.match(source, /alterTable\(\s*['"]tool_executions['"]/);
    assert.match(source, /request_hash['"]?\s*,\s*['"]CHAR\(64\)['"]/);
    assert.match(
      source,
      /request_hash_version['"]?\s*,\s*['"]SMALLINT UNSIGNED['"]/,
    );
    assert.match(source, /bigInteger\(\s*['"]execution_fence_token['"]/);
    // All three appear with .nullable() in the tool_executions alter block.
    const teStart = source.indexOf("alterTable('tool_executions'");
    const teAlt = source.indexOf('alterTable("tool_executions"');
    const start = teStart >= 0 ? teStart : teAlt;
    assert.ok(start >= 0);
    const nextAlter = source.indexOf('alterTable(', start + 10);
    const block = source.slice(start, nextAlter > start ? nextAlter : undefined);
    assert.match(block, /request_hash[\s\S]*?\.nullable\(\)/);
    assert.match(block, /request_hash_version[\s\S]*?\.nullable\(\)/);
    assert.match(block, /execution_fence_token[\s\S]*?\.nullable\(\)/);
  });

  it('adds nullable claim columns on sandbox_executions', () => {
    assert.match(source, /alterTable\(\s*['"]sandbox_executions['"]/);
    assert.match(source, /tool_execution_id['"]?\s*,\s*['"]CHAR\(26\)['"]/);
    assert.match(source, /string\(\s*['"]tool_call_id['"]\s*,\s*255\s*\)/);
    assert.match(source, /request_hash['"]?\s*,\s*['"]CHAR\(64\)['"]/);
    assert.match(
      source,
      /request_hash_version['"]?\s*,\s*['"]SMALLINT UNSIGNED['"]/,
    );
    assert.match(source, /bigInteger\(\s*['"]execution_fence_token['"]/);
  });

  it('declares exact unique + FK names on sandbox_executions', () => {
    assert.match(
      source,
      /uk_sandbox_execution_run_tool_call|UK_SANDBOX_EXECUTION_RUN_TOOL_CALL/,
    );
    assert.match(
      source,
      /uk_sandbox_execution_tool_execution|UK_SANDBOX_EXECUTION_TOOL_EXECUTION/,
    );
    assert.match(
      source,
      /fk_sandbox_execution_tool_execution|FK_SANDBOX_EXECUTION_TOOL_EXECUTION/,
    );
    assert.equal(
      UK_SANDBOX_EXECUTION_RUN_TOOL_CALL,
      'uk_sandbox_execution_run_tool_call',
    );
    assert.equal(
      UK_SANDBOX_EXECUTION_TOOL_EXECUTION,
      'uk_sandbox_execution_tool_execution',
    );
    assert.equal(
      FK_SANDBOX_EXECUTION_TOOL_EXECUTION,
      'fk_sandbox_execution_tool_execution',
    );
    assert.match(
      source,
      /unique\(\s*\[\s*['"]run_id['"]\s*,\s*['"]tool_call_id['"]\s*\]/,
    );
    assert.match(source, /unique\(\s*\[\s*['"]tool_execution_id['"]\s*\]/);
    assert.match(
      source,
      /foreign\(\s*['"]tool_execution_id['"][\s\S]*?references\(\s*['"]tool_execution_id['"]\s*\)[\s\S]*?inTable\(\s*['"]tool_executions['"]\s*\)/,
    );
  });

  it('down drops FK → uniques → sandbox columns → agent columns', () => {
    const downIdx = source.indexOf('export async function down');
    assert.ok(downIdx > 0);
    const downBody = source.slice(downIdx);

    const fk = downBody.search(/dropForeign/);
    const u1 = downBody.search(/dropUnique/);
    const u2 = downBody.indexOf('dropUnique', u1 + 1);
    const dropSandboxCols = downBody.indexOf(
      "dropColumn('execution_fence_token')",
    );
    const dropSandboxColsAlt = downBody.indexOf(
      'dropColumn("execution_fence_token")',
    );
    const dropSe =
      dropSandboxCols >= 0 ? dropSandboxCols : dropSandboxColsAlt;
    // tool_executions alter is the last alterTable in down
    const teDrop = downBody.lastIndexOf("alterTable('tool_executions'");
    const teDropAlt = downBody.lastIndexOf('alterTable("tool_executions"');
    const teIdx = Math.max(teDrop, teDropAlt);

    assert.ok(fk >= 0, 'down must dropForeign');
    assert.ok(u1 >= 0 && u2 > u1, 'down must drop both uniques');
    assert.ok(dropSe > u2, 'sandbox columns after uniques');
    assert.ok(teIdx > dropSe, 'tool_executions columns after sandbox columns');
    assert.ok(fk < u1, 'FK before uniques');

    // Explicit name constants used in drop order
    assert.match(downBody, /FK_SANDBOX_EXECUTION_TOOL_EXECUTION/);
    assert.match(downBody, /UK_SANDBOX_EXECUTION_RUN_TOOL_CALL/);
    assert.match(downBody, /UK_SANDBOX_EXECUTION_TOOL_EXECUTION/);
  });

  it('has no backfill, NOT NULL on new columns, or core rewrite', () => {
    // Scan executable up/down bodies only (header may mention forbidden patterns).
    const upIdx = source.indexOf('export async function up');
    const downIdx = source.indexOf('export async function down');
    assert.ok(upIdx >= 0 && downIdx > upIdx);
    const code = source.slice(upIdx);
    const upBody = source.slice(upIdx, downIdx);

    assert.doesNotMatch(code, /\bUPDATE\b/i);
    assert.doesNotMatch(code, /\bSET\s+\w+\s*=/i);
    assert.doesNotMatch(code, /\bbackfill\b/i);
    assert.doesNotMatch(code, /\.notNullable\s*\(/);
    assert.doesNotMatch(code, /\bNOT NULL\b/i);
    assert.doesNotMatch(code, /dropTable/);
    assert.doesNotMatch(code, /createTable/);
    assert.doesNotMatch(code, /\bENUM\s*\(/i);
    assert.doesNotMatch(source, /20260718000001/);

    // Expand columns are declared with an explicit .nullable() chain.
    const expandCols = [
      'request_hash',
      'request_hash_version',
      'execution_fence_token',
      'tool_execution_id',
      'tool_call_id',
    ];
    for (const col of expandCols) {
      const re = new RegExp(
        `['"]${col}['"][\\s\\S]{0,80}?\\.nullable\\s*\\(`,
        'm',
      );
      assert.match(upBody, re, `${col} must be .nullable() in up()`);
    }
    // Count nullable declarations — 3 on tool_executions + 5 on sandbox_executions.
    const nullableCount = (upBody.match(/\.nullable\s*\(/g) || []).length;
    assert.equal(nullableCount, 8, `expected 8 .nullable() in up, got ${nullableCount}`);
  });

  it('migration module parses under node (syntax)', async () => {
    const mod = await import(
      '../../src/infrastructure/mysql/migrations/20260718000008_sandbox_tool_execution_claims.js'
    );
    assert.equal(typeof mod.up, 'function');
    assert.equal(typeof mod.down, 'function');
  });
});
