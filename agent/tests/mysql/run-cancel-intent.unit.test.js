/**
 * PR-04 T2: cancel intent migration static/syntax tests (offline).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CANCEL_REASON_MAX_LEN,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20260718000004_run_cancel_intent.js';
import {
  sanitizeCancelReason,
  CANCEL_REASON_MAX_LEN as REPO_MAX,
} from '../../src/infrastructure/mysql/repositories/run-repository.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../src/infrastructure/mysql/migrations',
);
const MIGRATION_PATH = path.join(
  MIGRATIONS_DIR,
  '20260718000004_run_cancel_intent.js',
);

describe('20260718000004_run_cancel_intent migration static', () => {
  const source = readFileSync(MIGRATION_PATH, 'utf8');

  it('is listed among migrations and exports up/down', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.includes('20260718000004_run_cancel_intent.js'));
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
  });

  it('adds cancel intent columns + index on runs (additive)', () => {
    assert.match(source, /cancel_requested_at/);
    assert.match(source, /cancel_reason/);
    assert.match(source, /cancel_requested_by/);
    assert.match(source, /CHAR\(26\)/);
    assert.match(source, /idx_runs_cancel_requested_at/);
    assert.match(source, /alterTable\(\s*['"]runs['"]/);
  });

  it('down is reversible (drop index + columns)', () => {
    const downIdx = source.indexOf('export async function down');
    assert.ok(downIdx > 0);
    const downBody = source.slice(downIdx);
    assert.match(downBody, /dropIndex/);
    assert.match(downBody, /dropColumn\(['"]cancel_requested_by['"]\)/);
    assert.match(downBody, /dropColumn\(['"]cancel_reason['"]\)/);
    assert.match(downBody, /dropColumn\(['"]cancel_requested_at['"]\)/);
  });

  it('does not drop or rewrite core run status columns', () => {
    assert.doesNotMatch(source, /dropColumn\(['"]status['"]\)/);
    assert.doesNotMatch(source, /dropTable/);
  });

  it('CANCEL_REASON_MAX_LEN matches repository bound', () => {
    assert.equal(CANCEL_REASON_MAX_LEN, 255);
    assert.equal(REPO_MAX, CANCEL_REASON_MAX_LEN);
  });

  it('migration module parses under node (syntax)', async () => {
    const mod = await import(
      '../../src/infrastructure/mysql/migrations/20260718000004_run_cancel_intent.js'
    );
    assert.equal(typeof mod.up, 'function');
    assert.equal(typeof mod.down, 'function');
  });
});

describe('sanitizeCancelReason', () => {
  it('bounds, strips controls, redacts bearer material', () => {
    assert.equal(sanitizeCancelReason(null), null);
    assert.equal(sanitizeCancelReason('  ok  '), 'ok');
    assert.equal(
      sanitizeCancelReason('Bearer super-secret-token-value'),
      '[redacted]',
    );
    const long = 'x'.repeat(300);
    assert.equal(sanitizeCancelReason(long)?.length, 255);
  });
});

describe('migration up/down against schema-alter fake', () => {
  it('records alterTable operations in order', async () => {
    /** @type {Array<{ op: string, table?: string, cols?: string[] }>} */
    const ops = [];
    const knex = {
      raw: async () => {},
      schema: {
        alterTable: async (table, builder) => {
          /** @type {string[]} */
          const cols = [];
          /** @type {string[]} */
          const indexes = [];
          /** @type {string[]} */
          const dropped = [];
          const t = {
            specificType(name) {
              cols.push(name);
              return {
                nullable() {
                  return this;
                },
              };
            },
            string(name) {
              cols.push(name);
              return {
                nullable() {
                  return this;
                },
              };
            },
            index(colsArr, name) {
              indexes.push(name || colsArr.join(','));
            },
            dropIndex(_cols, name) {
              indexes.push(`drop:${name}`);
            },
            dropColumn(name) {
              dropped.push(name);
            },
          };
          builder(t);
          ops.push({
            op: 'alterTable',
            table,
            cols: [...cols, ...indexes, ...dropped],
          });
        },
      },
    };

    await up(/** @type {any} */ (knex));
    await down(/** @type {any} */ (knex));

    assert.ok(ops.length >= 2);
    assert.equal(ops[0].table, 'runs');
    assert.ok(ops[0].cols.includes('cancel_requested_at'));
    assert.ok(ops[0].cols.includes('cancel_reason'));
    assert.ok(ops[0].cols.includes('cancel_requested_by'));
    assert.ok(ops[0].cols.includes('idx_runs_cancel_requested_at'));
    assert.ok(ops[1].cols.some((c) => String(c).includes('cancel_')));
  });
});
