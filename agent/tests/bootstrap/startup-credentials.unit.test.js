/**
 * Agent 启动取密（ADR 0011 D10）：没有环境变量口令回退。
 *
 * 断言都在「真正向 DBPM 取密之前」发生的拒绝上，并用注入的取密实现证明合法配置
 * 只按声明的角色取、口令只出现在返回值里。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DbpmConfigError } from '@pi/contract/dbpm-config.js';
import { resolveAgentCredentials } from '../../src/bootstrap/startup-credentials.js';

const ENV = {
  AGENT_DATABASE_URL: 'mysql://agentap@proxy:3306/agent',
  AGENT_REDIS_URL: 'redis://redis:6379/0',
  DBPM_URL: 'dbpm-a:7000,dbpm-b:7001',
  DBPM_DB_NAME: 'agentdb',
  DBPM_DB_USER_NAME: 'agentap',
  DBPM_REDIS_DB_NAME: 'agentrds',
  DBPM_REDIS_DB_USER_NAME: 'agentrdsap',
};

function recorder(passwords = { agentdb: 'db-secret', agentrds: 'redis-secret' }) {
  const asked = [];
  return {
    asked,
    fetchPassword: async (_endpoints, entry, opts) => {
      asked.push({ entry: entry.dbName, role: opts.role });
      return passwords[entry.dbName];
    },
  };
}

describe('resolveAgentCredentials', () => {
  it('fetches the UPDRDB and Redis passwords from DBPM for a password-free config', async () => {
    const r = recorder();
    const creds = await resolveAgentCredentials(ENV, { mysql: true, redis: true }, { fetchPassword: r.fetchPassword });
    assert.deepEqual(creds, { mysql: 'db-secret', redis: 'redis-secret' });
    assert.deepEqual(r.asked, [
      { entry: 'agentdb', role: 'agent-updrdb' },
      { entry: 'agentrds', role: 'agent-redis' },
    ]);
    assert.equal(process.env.AGENT_DB_PASSWORD, undefined, '口令不写回进程环境');
  });

  it('only asks for what the process connects to', async () => {
    const r = recorder();
    assert.deepEqual(
      await resolveAgentCredentials(ENV, { mysql: false, redis: true }, { fetchPassword: r.fetchPassword }),
      { mysql: undefined, redis: 'redis-secret' },
    );
    assert.deepEqual(r.asked.map((a) => a.entry), ['agentrds']);
    assert.deepEqual(await resolveAgentCredentials(ENV, { mysql: false, redis: false }, { fetchPassword: r.fetchPassword }), {});
  });

  it('refuses a database URL that embeds a password, before contacting DBPM', async () => {
    const r = recorder();
    await assert.rejects(
      resolveAgentCredentials(
        { ...ENV, AGENT_DATABASE_URL: 'mysql://agentap:hunter2@proxy:3306/agent' },
        { mysql: true, redis: true },
        { fetchPassword: r.fetchPassword },
      ),
      (err) => err instanceof DbpmConfigError && !/hunter2/.test(err.message),
    );
    assert.equal(r.asked.length, 0);
  });

  it('refuses a Redis URL that embeds a password', async () => {
    const r = recorder();
    await assert.rejects(
      resolveAgentCredentials({ ...ENV, AGENT_REDIS_URL: 'redis://:hunter2@redis:6379/0' }, { mysql: true, redis: true }, { fetchPassword: r.fetchPassword }),
      DbpmConfigError,
    );
    assert.equal(r.asked.length, 0);
  });

  it('refuses when the DSN user does not match the DBPM entry user', async () => {
    const r = recorder();
    await assert.rejects(
      resolveAgentCredentials({ ...ENV, AGENT_DATABASE_URL: 'mysql://root@proxy:3306/agent' }, { mysql: true, redis: false }, { fetchPassword: r.fetchPassword }),
      /does not match/,
    );
    assert.equal(r.asked.length, 0);
  });

  it('refuses to start without DBPM_URL — no fallback to a static password', async () => {
    const { DBPM_URL: _drop, ...rest } = ENV;
    await assert.rejects(resolveAgentCredentials(rest, { mysql: true, redis: true }, recorder()), /DBPM_URL/);
  });

  it('a DBPM failure fails the whole resolution', async () => {
    await assert.rejects(
      resolveAgentCredentials(ENV, { mysql: true, redis: true }, {
        fetchPassword: async () => {
          throw new Error('DBPM credential fetch failed for agent-updrdb: ALL_ENDPOINTS_FAILED');
        },
      }),
      /ALL_ENDPOINTS_FAILED/,
    );
  });
});
