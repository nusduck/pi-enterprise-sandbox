import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assembleSystemPrompt,
  createSessionBackend,
} from '../../src/infrastructure/dsh/runtime-boot.js';

test('agent 经 @pi/runtime 取到企业条款', () => {
  const prompt = assembleSystemPrompt('lead');
  assert.match(prompt, /lead/);
  assert.match(prompt, /High-risk actions may wait on approval/);
});

test('agent 经 @pi/runtime 创建会话后端（无 MySQL 时内存）', () => {
  const prevHost = process.env.MYSQL_HOST;
  const prevDb = process.env.DB_HOST;
  const prevExec = process.env.EXEC_DB_HOST;
  delete process.env.MYSQL_HOST;
  delete process.env.DB_HOST;
  delete process.env.EXEC_DB_HOST;
  try {
    const store = createSessionBackend({ physicalRoots: [] });
    assert.equal(store.name, 'mysql-memory');
  } finally {
    if (prevHost !== undefined) process.env.MYSQL_HOST = prevHost;
    if (prevDb !== undefined) process.env.DB_HOST = prevDb;
    if (prevExec !== undefined) process.env.EXEC_DB_HOST = prevExec;
  }
});
