/**
 * Agent Card 的 Skill 描述（ADR 0015 §4.3 / design §4.3）。
 *
 * 有 `skillPolicy` 的版本按**有效绑定**出卡：`system` 展开成当前 release 的名单，
 * `org` 按钉住的摘要列出。两个反面同样重要：
 * - **`user` 层不进卡**——它随调用者变化，写进卡就是把某个用户的私有能力当成
 *   Agent 的对外能力播出去；
 * - 名单里已不在 release 的名字跳过，与 Run 解析写 `not_in_release` 诊断同源。
 *
 * 没有 `skillPolicy` 的 legacy 版本维持旧行为（由调用方决定，不在这里断言）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { skillsFromPolicy } from '../../src/bootstrap/http-main.js';
import type { SkillPolicy } from '@dsh/contract/skill-policy.js';

const CATALOG = [
  { name: 'pdf', description: 'PDF 处理' },
  { name: 'xlsx', description: '表格处理' },
  { name: 'docx', description: '文档处理' },
];

const DIGEST = 'a'.repeat(64);

function policy(overrides: Partial<SkillPolicy> = {}): SkillPolicy {
  return {
    system: { mode: 'all', names: [] },
    org: [],
    user: 'allow',
    ...overrides,
  } as SkillPolicy;
}

describe('skillsFromPolicy', () => {
  it('mode: all 展开成整个 release', async () => {
    const skills = await skillsFromPolicy(policy(), CATALOG);
    assert.deepEqual(skills, [
      { name: 'pdf', description: 'PDF 处理' },
      { name: 'xlsx', description: '表格处理' },
      { name: 'docx', description: '文档处理' },
    ]);
  });

  it('mode: allowlist 只出名单里的包，顺序跟随名单', async () => {
    const skills = await skillsFromPolicy(
      policy({ system: { mode: 'allowlist', names: ['xlsx', 'pdf'] } as SkillPolicy['system'] }),
      CATALOG,
    );
    assert.deepEqual(skills.map((s) => (s as { name: string }).name), ['xlsx', 'pdf']);
  });

  it('mode: none 一个系统包都不出', async () => {
    const skills = await skillsFromPolicy(
      policy({ system: { mode: 'none', names: [] } as SkillPolicy['system'] }),
      CATALOG,
    );
    assert.deepEqual(skills, []);
  });

  it('名单里已不在 release 的名字被跳过（配置保存后 release 变了）', async () => {
    const skills = await skillsFromPolicy(
      policy({ system: { mode: 'allowlist', names: ['pdf', 'gone'] } as SkillPolicy['system'] }),
      CATALOG,
    );
    assert.deepEqual(skills.map((s) => (s as { name: string }).name), ['pdf']);
  });

  it('org 条目按钉住的摘要列出', async () => {
    const skills = await skillsFromPolicy(
      policy({ system: { mode: 'none', names: [] } as SkillPolicy['system'], org: [
        { name: 'sales-weekly', contentDigest: DIGEST },
      ] }),
      CATALOG,
    );
    assert.equal(skills.length, 1);
    assert.equal((skills[0] as { name: string }).name, 'sales-weekly');
    assert.match((skills[0] as { description: string }).description, /aaaaaaaaaaaa/);
  });

  it('user 开关不影响卡（user 层根本不进卡）', async () => {
    const withAllow = await skillsFromPolicy(policy({ user: 'allow' }), CATALOG);
    const withDeny = await skillsFromPolicy(policy({ user: 'deny' }), CATALOG);
    assert.deepEqual(withAllow, withDeny);
  });
});
