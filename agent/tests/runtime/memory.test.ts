/**
 * memory 单测——归一化、匹配与租户隔离。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryService, InMemoryMemoryStore, normalizeMemoryText, memoryMatches } from '../../src/runtime/providers/memory.js';

test('normalizeMemoryText 去空白与截断', () => {
  assert.equal(normalizeMemoryText('  a   b \n c  '), 'a b c');
});

test('memoryMatches 大小写与分词', () => {
  assert.equal(memoryMatches('Hello World', 'hello'), true);
  assert.equal(memoryMatches('Hello World', 'WORLD'), true);
  assert.equal(memoryMatches('foo bar', 'baz'), false);
  assert.equal(memoryMatches('foo bar', ''), false);
});

test('租户隔离：不同 org/user 互不串', async () => {
  const store = new InMemoryMemoryStore();
  const svc = new MemoryService(store, () => 1, () => 'id1');
  await svc.write('o1', 'u1', 'remember cats');
  await svc.write('o1', 'u2', 'remember dogs');
  const hitsU1 = await svc.search('o1', 'u1', 'cats');
  const hitsU2 = await svc.search('o1', 'u2', 'cats');
  assert.equal(hitsU1.length, 1);
  assert.equal(hitsU2.length, 0);
});

test('非法文本抛错', async () => {
  const store = new InMemoryMemoryStore();
  const svc = new MemoryService(store);
  await assert.rejects(() => svc.write('o', 'u', ' '), /invalid memory text/);
});

test('检索按时间倒序且 limit 生效', async () => {
  let t = 0;
  const store = new InMemoryMemoryStore();
  const svc = new MemoryService(store, () => ++t, () => `id${t}`);
  await svc.write('o', 'u', 'cats are cute');
  await svc.write('o', 'u', 'cats are fluffy');
  const hits = await svc.search('o', 'u', 'cats', 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.text, 'cats are fluffy');
});
