/**
 * exec / sandbox-mcp 启动取密（ADR 0011 D10）：没有环境变量口令回退，
 * 装配层也拒绝带口令或未取密的数据库配置。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DbpmConfigError } from '@pi/contract/dbpm-config.js';
import type { DbpmEntry } from '@pi/contract/dbpm.js';

import { createExecAppFromEnv, readExecDbConfigFromSandboxEnv } from '../src/http/app.js';
import { resolveExecDbPassword } from '../src/startup-credentials.js';
import { resolveMcpRedisPassword } from '../src/mcp/startup-credentials.js';

const DBPM = {
  DBPM_URL: 'dbpm-a:7000,dbpm-b:7001',
  DBPM_DB_NAME: 'execdb',
  DBPM_DB_USER_NAME: 'sandbox',
  DBPM_REDIS_DB_NAME: 'mcprds',
  DBPM_REDIS_DB_USER_NAME: 'mcpap',
};

function recorder() {
  const asked: DbpmEntry[] = [];
  return {
    asked,
    fetchPassword: async (_e: unknown, entry: DbpmEntry) => {
      asked.push(entry);
      return `pwd-for-${entry.dbName}`;
    },
  };
}

const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...DBPM, ...extra }) as NodeJS.ProcessEnv;

describe('resolveExecDbPassword', () => {
  it('fetches only the UPDRDB password for a password-free DSN', async () => {
    const r = recorder();
    const pwd = await resolveExecDbPassword(
      env({ SANDBOX_DATABASE_URL: 'mysql://sandbox@mysql:3306/sandbox' }),
      readExecDbConfigFromSandboxEnv,
      { fetchPassword: r.fetchPassword as never },
    );
    assert.equal(pwd, 'pwd-for-execdb');
    assert.deepEqual(r.asked, [{ dbName: 'execdb', userName: 'sandbox' }]);
  });

  it('no database configured → no DBPM call (assembly decides production vs memory)', async () => {
    const r = recorder();
    assert.equal(await resolveExecDbPassword({} as NodeJS.ProcessEnv, readExecDbConfigFromSandboxEnv, { fetchPassword: r.fetchPassword as never }), undefined);
    assert.equal(r.asked.length, 0);
  });

  it('refuses a DSN with an embedded password or a mismatched user, before contacting DBPM', async () => {
    const r = recorder();
    await assert.rejects(
      resolveExecDbPassword(env({ SANDBOX_DATABASE_URL: 'mysql://sandbox:hunter2@mysql:3306/sandbox' }), readExecDbConfigFromSandboxEnv, { fetchPassword: r.fetchPassword as never }),
      (e) => e instanceof DbpmConfigError && !/hunter2/.test(e.message),
    );
    await assert.rejects(
      resolveExecDbPassword(env({ SANDBOX_DATABASE_URL: 'mysql://root@mysql:3306/sandbox' }), readExecDbConfigFromSandboxEnv, { fetchPassword: r.fetchPassword as never }),
      /does not match/,
    );
    assert.equal(r.asked.length, 0);
  });

  it('refuses without DBPM_URL', async () => {
    await assert.rejects(
      resolveExecDbPassword({ SANDBOX_DATABASE_URL: 'mysql://sandbox@mysql:3306/sandbox' } as NodeJS.ProcessEnv, readExecDbConfigFromSandboxEnv),
      /DBPM_URL/,
    );
  });
});

describe('createExecAppFromEnv 口令护栏', () => {
  const base = {
    SANDBOX_INTERNAL_HMAC_KEYRING: '{"k1":"0123456789abcdef0123456789abcdef"}',
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
    SANDBOX_API_TOKEN: 'test-public-token',
  };

  it('rejects a database config with an embedded password even when a DBPM password is supplied', () => {
    assert.throws(
      () =>
        createExecAppFromEnv({ ...base, SANDBOX_DATABASE_URL: 'mysql://sandbox:hunter2@127.0.0.1:1/sandbox' } as NodeJS.ProcessEnv, {
          dbPassword: 'from-dbpm',
        }),
      DbpmConfigError,
    );
  });

  it('refuses to assemble a configured database without the DBPM password', () => {
    assert.throws(
      () => createExecAppFromEnv({ ...base, SANDBOX_DATABASE_URL: 'mysql://sandbox@127.0.0.1:1/sandbox' } as NodeJS.ProcessEnv),
      /fetched from DBPM/,
    );
  });

  it('assembles with a password-free DSN plus the DBPM password (pool is lazy, no connection yet)', async () => {
    const runtime = createExecAppFromEnv(
      { ...base, SANDBOX_DATABASE_URL: 'mysql://sandbox@127.0.0.1:1/sandbox' } as NodeJS.ProcessEnv,
      { dbPassword: 'from-dbpm' },
    );
    await runtime.dispose();
  });
});

describe('resolveMcpRedisPassword', () => {
  it('fetches only the service Redis password', async () => {
    const r = recorder();
    assert.equal(
      await resolveMcpRedisPassword(env({}), 'redis://redis:6379/0', { fetchPassword: r.fetchPassword as never }),
      'pwd-for-mcprds',
    );
    assert.deepEqual(r.asked, [{ dbName: 'mcprds', userName: 'mcpap' }], 'facade 不取 UPDRDB 口令');
  });

  it('refuses a Redis URL with an embedded password', async () => {
    const r = recorder();
    await assert.rejects(
      resolveMcpRedisPassword(env({}), 'redis://:hunter2@redis:6379/0', { fetchPassword: r.fetchPassword as never }),
      (e) => e instanceof DbpmConfigError && !/hunter2/.test(e.message),
    );
    assert.equal(r.asked.length, 0);
  });
});
