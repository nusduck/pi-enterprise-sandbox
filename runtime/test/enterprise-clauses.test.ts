import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleSystemPrompt, ENTERPRISE_CLAUSES } from '../src/prompt/enterprise-clauses.js';

test('无 lead 时条款原样出现', () => {
  assert.equal(assembleSystemPrompt(), ENTERPRISE_CLAUSES);
  assert.match(assembleSystemPrompt(), /High-risk actions may wait on approval/);
});

test('自定义 lead 不能删掉企业条款', () => {
  const prompt = assembleSystemPrompt('You are a helpful assistant.');
  assert.match(prompt, /You are a helpful assistant/);
  assert.match(prompt, /## Paths \(hard rules\)/);
  assert.match(prompt, /Do not try to bypass policy/);
});
