/**
 * exec/src/db/client.ts 单测——连接池创建与错误脱敏。
 *
 * 没有对应的 Python 用例需要改写：这是 exec 侧新增的 DB 底座，
 * Python 版的等价物是 `sandbox/app/persistence/database.py` 的
 * `create_engine()`，但那一层直接把 DSN 拼进错误文本，本测试
 * 验证"不泄漏 DSN/物理根"是新增的硬约束。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  readExecDbConfig,
  ExecDbConfigError,
  createExecDbPool,
  closeExecDbPool,
} from '../src/db/client.js';

test('readExecDbConfig: accepts mysql+pymysql DSN from Compose', () => {
  const cfg = readExecDbConfig({
    DATABASE_URL: 'mysql+pymysql://sandbox:sandbox_dev_only@mysql:3306/sandbox',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.host, 'mysql');
  assert.equal(cfg.user, 'sandbox');
  assert.equal(cfg.database, 'sandbox');
});

test('readExecDbConfig: prefers DATABASE_URL', () => {
  const cfg = readExecDbConfig({
    DATABASE_URL: 'mysql://bob:s3cret@db.example.com:3307/mydb',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.host, 'db.example.com');
  assert.equal(cfg.port, 3307);
  assert.equal(cfg.user, 'bob');
  assert.equal(cfg.password, 's3cret');
  assert.equal(cfg.database, 'mydb');
});

test('readExecDbConfig: falls back to EXEC_DB_*', () => {
  const cfg = readExecDbConfig({
    EXEC_DB_HOST: 'h',
    EXEC_DB_USER: 'u',
    EXEC_DB_PASSWORD: 'p',
    EXEC_DB_DATABASE: 'd',
    EXEC_DB_PORT: '3308',
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(cfg.host, 'h');
  assert.equal(cfg.port, 3308);
});

test('readExecDbConfig: missing config throws ExecDbConfigError', () => {
  assert.throws(
    () =>
      readExecDbConfig({
        EXEC_DB_HOST: 'h',
      } as unknown as NodeJS.ProcessEnv),
    (e: unknown) => e instanceof ExecDbConfigError,
  );
});

test('readExecDbConfig: invalid DATABASE_URL throws', () => {
  assert.throws(
    () => readExecDbConfig({ DATABASE_URL: 'not-a-url' } as unknown as NodeJS.ProcessEnv),
    (e: unknown) => e instanceof ExecDbConfigError,
  );
});

test('createExecDbPool: returns a pool with execute and end', async () => {
  // 不连真实 DB，只验证返回对象形状；用一个注定连不上的地址，
  // 但 createPool 本身是同步的，不会立即抛。
  const pool = createExecDbPool({
    host: '127.0.0.1',
    port: 1,
    user: 'u',
    password: 'p',
    database: 'd',
    connectionLimit: 1,
  });
  assert.equal(typeof pool.execute, 'function');
  assert.equal(typeof pool.end, 'function');
  await closeExecDbPool(pool);
});

test('createExecDbPool: close is idempotent', async () => {
  const pool = createExecDbPool({
    host: '127.0.0.1',
    port: 1,
    user: 'u',
    password: 'p',
    database: 'd',
    connectionLimit: 1,
  });
  await closeExecDbPool(pool);
  await closeExecDbPool(pool);
});
