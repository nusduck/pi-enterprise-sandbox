/**
 * Static + injectable regression: Knex MySQL composite primary must not use
 * object options ({ indexName } / { constraintName }) — create-table path
 * wraps the object as alias SQL → illegal `as indexName`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diagnosePrimaryConstraintArg,
} from '../../src/infrastructure/mysql/migration-partial-ddl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations',
);

/**
 * Find t.primary(…, { … }) object second-arg usages (illegal on MySQL create).
 * @param {string} source
 * @returns {string[]}
 */
function findIllegalPrimaryObjectOptions(source) {
  /** @type {string[]} */
  const hits = [];
  // Multi-line: t.primary([\n ... \n], {\n indexName: ...
  const re =
    /\.primary\s*\(\s*(?:\[[^\]]*\]|['"][^'"]+['"])\s*,\s*\{[\s\S]*?\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    hits.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
  }
  return hits;
}

/**
 * Find object options that use indexName as if it were a primary constraint key.
 * @param {string} source
 */
function findPrimaryIndexNameKey(source) {
  return /\.primary\s*\([\s\S]{0,200}indexName\s*:/.test(source);
}

describe('diagnosePrimaryConstraintArg (Knex MySQL create oracle)', () => {
  it('accepts string constraint names', () => {
    assert.equal(diagnosePrimaryConstraintArg('pk_idempotency_records').ok, true);
    assert.equal(diagnosePrimaryConstraintArg(undefined).ok, true);
  });

  it('flags { indexName } as illegal as-indexName SQL', () => {
    const r = diagnosePrimaryConstraintArg({
      indexName: 'pk_idempotency_records',
    });
    assert.equal(r.ok, false);
    assert.match(String(r.illegalSqlFragment), /as indexName/i);
    assert.match(String(r.illegalSqlFragment), /pk_idempotency_records/);
    assert.match(String(r.illegalSqlFragment), /primary key/i);
  });

  it('flags { constraintName } too (create path does not destructure)', () => {
    const r = diagnosePrimaryConstraintArg({
      constraintName: 'pk_foo',
    });
    assert.equal(r.ok, false);
    assert.match(String(r.illegalSqlFragment), /as constraintName/i);
  });
});

describe('migration sources: no illegal primary object options', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();

  it('has migration files to audit', () => {
    assert.ok(files.length >= 5, `expected migrations, got ${files.length}`);
  });

  for (const file of files) {
    it(`${file} has no t.primary(..., { … }) object options`, () => {
      const src = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const hits = findIllegalPrimaryObjectOptions(src);
      assert.deepEqual(
        hits,
        [],
        `${file} illegal primary options: ${JSON.stringify(hits)}`,
      );
      assert.equal(
        findPrimaryIndexNameKey(src),
        false,
        `${file} must not use indexName inside primary()`,
      );
    });
  }

  it('core + external_refs use string primary constraint names', () => {
    const core = readFileSync(
      path.join(MIGRATIONS_DIR, '20260718000001_core_platform_schema.js'),
      'utf8',
    );
    // Multi-line primary + optional trailing comma after constraint string.
    assert.match(
      core,
      /\.primary\(\s*\[[^\]]*\]\s*,\s*['"]pk_idempotency_records['"]\s*,?\s*\)/,
    );

    const refs = readFileSync(
      path.join(MIGRATIONS_DIR, '20260718000003_run_authority_compatibility.js'),
      'utf8',
    );
    assert.match(
      refs,
      /\.primary\(\s*\[[^\]]*\]\s*,\s*['"]pk_organization_external_refs['"]\s*,?\s*\)/,
    );
    assert.match(
      refs,
      /\.primary\(\s*\[[^\]]*\]\s*,\s*['"]pk_conversation_external_refs['"]\s*,?\s*\)/,
    );
  });

  it('unique({ indexName }) remains allowed (different Knex API)', () => {
    const core = readFileSync(
      path.join(MIGRATIONS_DIR, '20260718000001_core_platform_schema.js'),
      'utf8',
    );
    // unique second arg object with indexName is valid on MySQL
    assert.match(core, /\.unique\(\s*\[[^\]]+\]\s*,\s*\{\s*indexName:/);
  });
});
