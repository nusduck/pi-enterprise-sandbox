/**
 * exec 的 schema 核对器（design §6.2）：exec 用自己的 mysql2 池读元数据，结论必须与
 * Agent 侧一致。设置 `TEST_MYSQL_URL`（已由 Agent 迁移好的一次性库）时连真库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadSchemaManifest, SchemaDriftError } from '@pi/contract/schema-manifest.js';

import { createExecDbPool, closeExecDbPool } from '../src/db/client.js';
import { assertSchemaMatchesManifest, introspectSchema } from '../src/db/schema-verify.js';

describe('exec schema verify (offline)', () => {
  it('an empty metadata view is drift, not success — invisible objects are not "no difference"', async () => {
    const pool = { query: (async () => [[], []]) as never };
    await assert.rejects(assertSchemaMatchesManifest(pool), (err) => {
      assert.ok(err instanceof SchemaDriftError);
      assert.ok(err.drifts.some((d) => d.kind === 'missing_table'));
      assert.ok(err.drifts.some((d) => d.kind === 'missing_trigger'));
      return true;
    });
  });
});

const TEST_MYSQL_URL = (process.env['TEST_MYSQL_URL'] ?? '').trim();
const describeLive = /^mysql2?:\/\//.test(TEST_MYSQL_URL) ? describe : describe.skip;

describeLive('exec schema verify against a migrated database (TEST_MYSQL_URL)', () => {
  const url = new URL(TEST_MYSQL_URL);
  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: 2,
  };

  it('passes on a correct schema and names the missing exec column when it is dropped', async () => {
    const pool = createExecDbPool(config);
    try {
      assert.deepEqual((await introspectSchema(pool)).migrations, loadSchemaManifest().migrations);
      await assertSchemaMatchesManifest(pool);

      await pool.query('ALTER TABLE exec_jobs ADD COLUMN d3_probe INT NULL');
      try {
        await assert.rejects(assertSchemaMatchesManifest(pool, { role: 'exec' }), (err) => {
          assert.ok(err instanceof SchemaDriftError);
          assert.deepEqual(err.drifts.map((d) => `${d.kind} ${d.object}`), ['extra_column exec_jobs.d3_probe']);
          assert.match(err.message, /^exec: /);
          return true;
        });
      } finally {
        await pool.query('ALTER TABLE exec_jobs DROP COLUMN d3_probe');
      }
      await assertSchemaMatchesManifest(pool);
    } finally {
      await closeExecDbPool(pool);
    }
  });
});
