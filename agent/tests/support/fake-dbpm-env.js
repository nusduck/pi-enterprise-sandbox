/**
 * 测试 / smoke 用：把一组带口令的测试连接串，转换成「无口令连接串 + 本机假 DBPM」。
 *
 * 生产代码没有环境变量口令回退（ADR 0011 D10），所以起真实 Agent / Worker / exec
 * 子进程的测试必须和生产一样经 DBPM 取密。测试自己直连数据库做准备/清理时，仍用
 * 原始带口令的连接串。
 */

import { startFakeDbpm } from '../../../scripts/dev/fake-dbpm.mjs';

/** 去掉 URL 里的口令（保留用户名）。 */
export function stripUrlPassword(value) {
  const url = new URL(String(value));
  url.password = '';
  return url.toString();
}

/**
 * 起一台假 DBPM（主备两个端口），条目取自给定连接串。
 * Redis 连接串没有口令时（CI 的无认证 Redis）用占位口令：服务端未开认证时
 * ioredis 只告警不失败，而 DBPM 协议不允许空口令。
 */
export async function startDbpmForUrls({ mysqlUrl, redisUrl, redisFallbackPassword = 'test-redis-no-auth' }) {
  const mysql = new URL(String(mysqlUrl));
  const mysqlUser = decodeURIComponent(mysql.username);
  const entries = new Map([[`testdb ${mysqlUser}`, decodeURIComponent(mysql.password)]]);
  const env = {
    DBPM_DB_NAME: 'testdb',
    DBPM_DB_USER_NAME: mysqlUser,
  };
  if (redisUrl) {
    const redisPassword = decodeURIComponent(new URL(String(redisUrl)).password) || redisFallbackPassword;
    entries.set('testredis default', redisPassword);
    Object.assign(env, { DBPM_REDIS_DB_NAME: 'testredis', DBPM_REDIS_DB_USER_NAME: 'default' });
  }
  const fake = await startFakeDbpm({ entries });
  return {
    fake,
    env: { DBPM_URL: fake.url, ...env },
    close: () => fake.close(),
  };
}
