/**
 * `tbl_agsvc_browser_auth_sessions` 迁移的静态门禁（UPspec《数据库设计规范》）。
 *
 * `tests/test_schema_upspec_naming.py` 校验的是**重新生成后的 manifest**；在真实重放与
 * manifest 生成之前，这里先把迁移源码里最容易写错的三类钉住：表/索引命名、≤16 的
 * 字符串必须 `CHAR`、NOT NULL 列必须有默认值（会话漏写 expires_at 时立即过期）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_AUTH_SESSIONS_TABLE,
  up,
  down,
} from '../../src/infrastructure/mysql/migrations/20261002000001_browser_auth_sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(
  path.join(__dirname, '../../src/infrastructure/mysql/migrations/20261002000001_browser_auth_sessions.js'),
  'utf8',
);

describe('browser_auth_sessions migration', () => {
  it('exports the logical name and up/down hooks', () => {
    assert.equal(BROWSER_AUTH_SESSIONS_TABLE, 'browser_auth_sessions');
    assert.equal(typeof up, 'function');
    assert.equal(typeof down, 'function');
  });

  it('creates the UPspec physical table with the expected columns', () => {
    assert.match(SOURCE, /const PHYSICAL_BROWSER_AUTH_SESSIONS = 'tbl_agsvc_browser_auth_sessions'/);
    for (const column of [
      'session_id',
      'user_id',
      'org_id',
      'external_user_id',
      'external_org_id',
      'login_method',
      'identity_provider',
      'source',
      'created_at',
      'expires_at',
      'revoked_at',
    ]) {
      assert.match(SOURCE, new RegExp(`specificType\\('${column}'|string\\('${column}'|column\\('${column}'`), column);
    }
  });

  it('names every index ind_agsvc_bas_(a|i)N within 18 bytes', () => {
    const indexes = [...SOURCE.matchAll(/'(ind_agsvc_[a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.deepEqual(indexes.sort(), ['ind_agsvc_bas_i1', 'ind_agsvc_bas_i2']);
    for (const name of indexes) {
      assert.match(name, /^ind_agsvc_[a-z0-9]{1,5}_[ai][1-9][0-9]*$/);
      assert.ok(Buffer.byteLength(name) <= 18, `${name} exceeds 18 bytes`);
    }
  });

  it('uses CHAR(16) for the short enum projection and keeps expires_at fail-closed', () => {
    assert.match(SOURCE, /specificType\('login_method', SMALL_TYPE\)/);
    assert.match(SOURCE, /specificType\('source', SMALL_TYPE\)/);
    assert.match(SOURCE, /const SMALL_TYPE = 'CHAR\(16\)'/);
    // 漏写 expires_at 的会话立即过期，而不是永不过期。
    assert.match(SOURCE, /specificType\('expires_at', AT_TYPE\)\.notNullable\(\)\.defaultTo\(knex\.fn\.now\(3\)\)/);
    assert.match(SOURCE, /specificType\('revoked_at', AT_TYPE\)\.nullable\(\)/);
    // 不要出现定长 ≤16 的 VARCHAR 列（UPspec 要求 CHAR）。
    assert.doesNotMatch(SOURCE, /string\('(?:login_method|source)'/);
  });

  it('references the physical parent tables and drops itself in down()', () => {
    assert.match(SOURCE, /references\('tbl_agsvc_organizations\.org_id'\)/);
    assert.match(SOURCE, /references\('tbl_agsvc_users\.user_id'\)/);
    assert.match(SOURCE, /dropTableIfExists\(PHYSICAL_BROWSER_AUTH_SESSIONS\)/);
  });
});
