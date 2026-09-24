/**
 * `dbpm-config.ts` 的测试：配置缺失即拒绝、连接串不许夹口令、用户名必须一致、
 * 只取声明的角色，以及端到端对着真实 TCP 假服务端取两类口令。
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';

import {
  assertUrlUser,
  assertUrlWithoutPassword,
  DbpmConfigError,
  fetchDbpmCredentials,
  readDbpmSettings,
} from '../src/dbpm-config.js';
import type { DbpmEntry } from '../src/dbpm.js';

const ENV = {
  DBPM_URL: 'dbpm-a:7000,dbpm-b:7001',
  DBPM_DB_NAME: 'agentdb',
  DBPM_DB_USER_NAME: 'agentap',
  DBPM_REDIS_DB_NAME: 'agentrds',
  DBPM_REDIS_DB_USER_NAME: 'agentrdsap',
};

describe('readDbpmSettings', () => {
  it('reads both endpoints and only the requested roles', () => {
    const settings = readDbpmSettings(ENV, ['redis']);
    assert.deepEqual(settings.endpoints, [
      { host: 'dbpm-a', port: 7000 },
      { host: 'dbpm-b', port: 7001 },
    ]);
    assert.deepEqual(settings.entries, { redis: { dbName: 'agentrds', userName: 'agentrdsap' } });
  });

  it('refuses to start without DBPM_URL — there is no env password fallback', () => {
    const { DBPM_URL: _drop, ...rest } = ENV;
    assert.throws(() => readDbpmSettings(rest, ['updrdb']), (e) => e instanceof DbpmConfigError && /DBPM_URL/.test(e.message));
    assert.throws(() => readDbpmSettings({ ...ENV, DBPM_URL: 'dbpm-a:7000' }, ['updrdb']), DbpmConfigError);
  });

  it('names the missing entry variables for a requested role', () => {
    assert.throws(
      () => readDbpmSettings({ ...ENV, DBPM_DB_USER_NAME: ' ' }, ['updrdb', 'redis']),
      (e) => e instanceof DbpmConfigError && /DBPM_DB_USER_NAME/.test(e.message),
    );
  });
});

describe('connection URL guards', () => {
  it('rejects an embedded password without echoing it', () => {
    assert.doesNotThrow(() => assertUrlWithoutPassword('mysql://agentap@proxy:3306/agent', 'AGENT_DATABASE_URL'));
    assert.doesNotThrow(() => assertUrlWithoutPassword('redis://redis:6379/0', 'AGENT_REDIS_URL'));
    for (const url of ['mysql://agentap:hunter2@proxy:3306/agent', 'redis://:hunter2@redis:6379/0']) {
      assert.throws(
        () => assertUrlWithoutPassword(url, 'X_URL'),
        (e) => e instanceof DbpmConfigError && !/hunter2/.test(e.message) && /X_URL/.test(e.message),
      );
    }
    assert.throws(() => assertUrlWithoutPassword('not a url hunter2', 'X_URL'), (e) => !/hunter2/.test(String(e)));
  });

  it('requires the DSN user to match the DBPM credential user', () => {
    assert.doesNotThrow(() => assertUrlUser('mysql://agentap@proxy:3306/agent', 'AGENT_DATABASE_URL', 'agentap'));
    assert.throws(
      () => assertUrlUser('mysql://root@proxy:3306/agent', 'AGENT_DATABASE_URL', 'agentap'),
      DbpmConfigError,
    );
  });
});

describe('fetchDbpmCredentials', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  it('fetches each requested role over the real protocol and labels failures by process and role', async () => {
    const passwords: Record<string, string> = { 'agentdb agentap': 'db-secret', 'agentrds agentrdsap': 'redis-secret' };
    const server = createServer((socket) => {
      socket.once('data', (data) => {
        const key = data.subarray(2).toString('utf8').trim();
        const pwd = passwords[key];
        socket.end(pwd ? `OK: ${pwd}\n` : 'ERR: no such entry\n');
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    const env = { ...ENV, DBPM_URL: `127.0.0.1:${address.port},127.0.0.1:${address.port}` };

    const creds = await fetchDbpmCredentials(readDbpmSettings(env, ['updrdb', 'redis']), ['updrdb', 'redis'], {
      process: 'agent-http',
    });
    assert.deepEqual(creds, { updrdb: 'db-secret', redis: 'redis-secret' });

    const unknown = readDbpmSettings({ ...env, DBPM_REDIS_DB_NAME: 'nosuch' }, ['redis']);
    await assert.rejects(
      fetchDbpmCredentials(unknown, ['redis'], { process: 'sandbox-mcp' }),
      (e) => /sandbox-mcp-redis/.test(String((e as Error).message)) && !/secret/.test(String((e as Error).message)),
    );
  });

  it('only asks DBPM for the roles the process declared', async () => {
    const asked: DbpmEntry[] = [];
    const creds = await fetchDbpmCredentials(readDbpmSettings(ENV, ['updrdb', 'redis']), ['redis'], {
      process: 'sandbox-mcp',
      fetchPassword: async (_endpoints, entry) => {
        asked.push(entry);
        return 'r';
      },
    });
    assert.deepEqual(asked, [{ dbName: 'agentrds', userName: 'agentrdsap' }]);
    assert.deepEqual(creds, { redis: 'r' });
  });

  it('refuses a role whose entry was not read', async () => {
    await assert.rejects(
      fetchDbpmCredentials(readDbpmSettings(ENV, ['redis']), ['updrdb'], { process: 'exec', fetchPassword: async () => 'x' }),
      DbpmConfigError,
    );
  });
});
