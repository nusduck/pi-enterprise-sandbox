/**
 * 开发挡板本身的测试：假 DBPM 按真协议发口令、能注入单台故障、生产拒绝运行；
 * 测试辅助把带口令的测试连接串转成「无口令连接串 + DBPM 条目」。
 *
 * 取密走 contract 的生产客户端，证明挡板与生产代码说的是同一个协议。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchDbpmCredentials, readDbpmSettings } from '@pi/contract/dbpm-config.js';
import { parseFakeDbpmEntries, startFakeDbpm } from '../../../scripts/dev/fake-dbpm.mjs';
import { startDbpmForUrls, stripUrlPassword } from './fake-dbpm-env.js';

const SCRIPT = fileURLToPath(new URL('../../../scripts/dev/fake-dbpm.mjs', import.meta.url));

describe('fake DBPM dev stub', () => {
  it('stripUrlPassword keeps the user and drops only the password', () => {
    assert.equal(stripUrlPassword('mysql://sandbox:s3cret@127.0.0.1:3307/sandbox'), 'mysql://sandbox@127.0.0.1:3307/sandbox');
    assert.equal(stripUrlPassword('redis://:r3dis@127.0.0.1:6379/0'), 'redis://127.0.0.1:6379/0');
  });

  it('serves both credential roles over the real protocol, for the production client', async () => {
    const handle = await startDbpmForUrls({
      mysqlUrl: 'mysql://sandbox:db-secret@127.0.0.1:3307/sandbox',
      redisUrl: 'redis://:redis-secret@127.0.0.1:6379/0',
    });
    try {
      const creds = await fetchDbpmCredentials(readDbpmSettings(handle.env, ['updrdb', 'redis']), ['updrdb', 'redis'], {
        process: 'test',
      });
      assert.deepEqual(creds, { updrdb: 'db-secret', redis: 'redis-secret' });
      assert.equal(handle.env.DBPM_DB_USER_NAME, 'sandbox');
    } finally {
      await handle.close();
    }
  });

  it('a failing primary makes the production client use the secondary', async () => {
    const fake = await startFakeDbpm({ entries: parseFakeDbpmEntries('db:u:pw-ok'), failIndexes: [0] });
    try {
      const env = { DBPM_URL: fake.url, DBPM_DB_NAME: 'db', DBPM_DB_USER_NAME: 'u' };
      const creds = await fetchDbpmCredentials(readDbpmSettings(env, ['updrdb']), ['updrdb'], { process: 't' });
      assert.equal(creds.updrdb, 'pw-ok');
      fake.setFailing(1, true);
      await assert.rejects(
        fetchDbpmCredentials(readDbpmSettings(env, ['updrdb']), ['updrdb'], { process: 't' }),
        (err) => /ALL_ENDPOINTS_FAILED/.test(err.message) && !/pw-ok/.test(err.message),
      );
    } finally {
      await fake.close();
    }
  });

  it('rejects malformed entry lists', () => {
    assert.throws(() => parseFakeDbpmEntries(''), /empty/);
    assert.throws(() => parseFakeDbpmEntries('db:user'), /db:user:password/);
    assert.equal(parseFakeDbpmEntries('db:user:pa:ss').get('db user'), 'pa:ss');
  });

  it('the CLI refuses to run with DEPLOYMENT_ENV=production', () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, DEPLOYMENT_ENV: 'production', FAKE_DBPM_ENTRIES: 'a:b:c', FAKE_DBPM_PORTS: '0' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refuses to run/);
  });
});
