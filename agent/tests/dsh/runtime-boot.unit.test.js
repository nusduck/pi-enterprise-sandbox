import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleSystemPrompt,
  createSessionBackend,
  mountSessionPersistence,
} from '../../src/infrastructure/dsh/runtime-boot.js';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore } from '@deepseek-ai/dsh-session';

test('agent 经 @pi/runtime 取到企业条款', () => {
  const prompt = assembleSystemPrompt('lead');
  assert.match(prompt, /lead/);
  assert.match(prompt, /High-risk actions may wait on approval/);
});

test('agent 经 @pi/runtime 创建会话后端（无 MySQL 时内存）', () => {
  const prevHost = process.env.MYSQL_HOST;
  const prevDb = process.env.DB_HOST;
  const prevExec = process.env.EXEC_DB_HOST;
  const prevAgent = process.env.AGENT_DATABASE_URL;
  const prevTest = process.env.TEST_MYSQL_URL;
  delete process.env.MYSQL_HOST;
  delete process.env.DB_HOST;
  delete process.env.EXEC_DB_HOST;
  delete process.env.AGENT_DATABASE_URL;
  delete process.env.TEST_MYSQL_URL;
  try {
    const store = createSessionBackend({ physicalRoots: [] });
    assert.equal(store.name, 'mysql-memory');
    const ctx = new Context();
    new SessionStore(ctx);
    const persistence = mountSessionPersistence(ctx, { physicalRoots: [] });
    assert.equal(typeof persistence.prepare, 'function');
    assert.equal(typeof ctx.get('sessionPersistence')?.has, 'function');
  } finally {
    if (prevHost !== undefined) process.env.MYSQL_HOST = prevHost;
    if (prevDb !== undefined) process.env.DB_HOST = prevDb;
    if (prevExec !== undefined) process.env.EXEC_DB_HOST = prevExec;
    if (prevAgent !== undefined) process.env.AGENT_DATABASE_URL = prevAgent;
    else delete process.env.AGENT_DATABASE_URL;
    if (prevTest !== undefined) process.env.TEST_MYSQL_URL = prevTest;
    else delete process.env.TEST_MYSQL_URL;
  }
});
