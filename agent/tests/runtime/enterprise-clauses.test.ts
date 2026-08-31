import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleSystemPrompt,
  DEFAULT_SKILL_ROOT,
  ENTERPRISE_CLAUSES,
} from '../../src/runtime/prompt/enterprise-clauses.js';

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

test('路径条款用调用方传入的根目录，不是写死的常量', () => {
  const prompt = assembleSystemPrompt('', {
    workspaceRoot: '/srv/ws',
    skillRoot: '/srv/skills',
  });
  assert.match(prompt, /`\/srv\/ws`/);
  assert.match(prompt, /`\/srv\/skills`/);
  assert.doesNotMatch(prompt, /home\/sandbox/);
});

test('默认 skill 根目录与真实挂载点一致（单数 skill，不是 skills）', () => {
  // DSH 重建后这里一直写着 `/home/sandbox/skills`，而 compose 挂载的是
  // `/home/sandbox/skill`（SKILLS_ROOT / skills/paths.js 的 SYSTEM_SKILL_ROOT）。
  // 模型照着提示词去列 skill 会扑空。这条断言把两者钉在一起。
  assert.equal(DEFAULT_SKILL_ROOT, '/home/sandbox/skill');
  assert.match(assembleSystemPrompt(), /`\/home\/sandbox\/skill`/);
  assert.doesNotMatch(assembleSystemPrompt(), /home\/sandbox\/skills/);
});

test('ADR 0009 D7 / H6.12：提示词必须写明可写的草稿根', () => {
  const prompt = assembleSystemPrompt();
  // 模型现在没有 skill_create / skill_install 这类工具了（D7 取消了整套），
  // 它**只能靠这段话知道包该建在哪**。不说的话，最可能的失败是它去写只读的
  // skill 根然后报错。
  assert.match(prompt, /`\/home\/sandbox\/skill-draft`/);
  // 而且必须说清「草稿不等于可用」——闸门只剩人按的那一下。
  assert.match(prompt, /until a human enables it/);
  assert.match(prompt, /cannot enable one yourself/);
});

test('H6.12 草稿根跟随调用方给的 skillRoot，不回落到写死的常量', () => {
  const prompt = assembleSystemPrompt('', {
    workspaceRoot: '/srv/ws',
    skillRoot: '/srv/skills',
  });
  assert.match(prompt, /`\/srv\/skills-draft`/);
  assert.doesNotMatch(
    prompt,
    /home\/sandbox/,
    '同时出现两套根会让模型照着写扑空，而那种不一致没有人会报错',
  );
});
