/**
 * enabled-skills 单测——启用集过滤与多租户隔离。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEnabledSkillsProvider, InMemoryEnabledSkillStore, filterCandidatesByEnabled, isSkillVisible } from '../src/providers/enabled-skills.js';
import type { SkillCandidate } from '@deepseek-ai/dsh-skill';

function candidate(name: string): SkillCandidate {
  return {
    name,
    description: name,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'fs',
    rank: 100,
    locator: name,
  } as SkillCandidate;
}

test('纯函数 isSkillVisible / filterCandidatesByEnabled', () => {
  const enabled = new Set(['a', 'c']);
  assert.equal(isSkillVisible('a', enabled), true);
  assert.equal(isSkillVisible('b', enabled), false);
  const filtered = filterCandidatesByEnabled([candidate('a'), candidate('b'), candidate('c')], enabled);
  assert.deepEqual(filtered.map((c) => c.name), ['a', 'c']);
});

test('未启用不挂载：list 过滤掉未启用', async () => {
  const store = new InMemoryEnabledSkillStore();
  store.setEnabled('o1', 'u1', ['keep']);
  const inner = {
    name: 'fs',
    list: async () => [candidate('keep'), candidate('drop')],
    get: async (c: SkillCandidate) => ({ ...c, content: 'body' } as never),
  } as never;
  const provider = createEnabledSkillsProvider({ inner, store, tenantOf: () => ({ orgId: 'o1', userId: 'u1' }) });
  const list = await provider.list({ cwd: '/tmp' });
  const arr = Array.isArray(list) ? list : (list as { candidates: readonly never[] }).candidates;
  assert.deepEqual((arr as SkillCandidate[]).map((c) => c.name), ['keep']);
});

test('多租户隔离：不同 user 启用集互不串', async () => {
  const store = new InMemoryEnabledSkillStore();
  store.setEnabled('o1', 'u1', ['a']);
  store.setEnabled('o1', 'u2', ['b']);
  const inner = {
    name: 'fs',
    list: async () => [candidate('a'), candidate('b')],
    get: async (c: SkillCandidate) => ({ ...c, content: 'x' } as never),
  } as never;
  const provider = createEnabledSkillsProvider({ inner, store, tenantOf: (o) => (o as { orgId: string; userId: string }) });
  const listU1 = await provider.list({ cwd: '/' } as never);
  // tenantOf 返回 null 时退化 fail-closed 空集——这里测试显式 tenant 透传
  const p2 = createEnabledSkillsProvider({ inner, store, tenantOf: () => ({ orgId: 'o1', userId: 'u2' }) });
  const listU2 = await p2.list({ cwd: '/' });
  const a1 = Array.isArray(listU1) ? listU1 : (listU1 as { candidates: readonly SkillCandidate[] }).candidates;
  const a2 = Array.isArray(listU2) ? listU2 : (listU2 as { candidates: readonly SkillCandidate[] }).candidates;
  assert.deepEqual((a1 as SkillCandidate[]).map((c) => c.name), []);
  assert.deepEqual((a2 as SkillCandidate[]).map((c) => c.name), ['b']);
});

test('get 二次校验：绕过 list 直接 get 未启用返回 undefined', async () => {
  const store = new InMemoryEnabledSkillStore();
  store.setEnabled('o1', 'u1', []);
  const inner = {
    name: 'fs',
    list: async () => [],
    get: async (c: SkillCandidate) => ({ ...c, content: 'body' } as never),
  } as never;
  const provider = createEnabledSkillsProvider({ inner, store, tenantOf: () => ({ orgId: 'o1', userId: 'u1' }) });
  const got = await provider.get(candidate('secret'), { cwd: '/' });
  assert.equal(got, undefined);
});
