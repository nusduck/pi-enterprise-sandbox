/**
 * 「技能」分类的草稿读写与候选投影（ADR 0015 D1/D2，design §4.1/§4.2）。
 *
 * 这里钉的是页面与**服务端契约**的对齐：省略 `skillPolicy` = 当前行为、`allowlist`
 * 之外不许带 `names`（服务端对此报错，不许静默忽略）、没设过策略的版本不该因为页面
 * 往返而多出一个会改变 `config_hash` 的键。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SKILL_LAYER_MAX,
  orgSkillCandidates,
  setSkillPolicy,
  skillCandidates,
  skillLayerMaxItems,
  skillPolicyCount,
  skillPolicyOf,
  skillPolicyStructureIssues,
} from '../src/pages/settings/skillPolicyHelpers.ts';

const DIGEST = 'a'.repeat(64);

describe('skillPolicyOf', () => {
  it('没设过这个键时返回 null，不冒充默认值', () => {
    assert.equal(skillPolicyOf({}), null);
    assert.equal(skillPolicyOf({ skillPolicy: null }), null);
  });

  it('读出三层的值', () => {
    assert.deepEqual(
      skillPolicyOf({
        skillPolicy: {
          system: { mode: 'allowlist', names: ['pdf', 'xlsx'] },
          org: [{ name: 'sales-weekly', contentDigest: DIGEST }],
          user: 'deny',
        },
      }),
      {
        systemMode: 'allowlist',
        systemNames: ['pdf', 'xlsx'],
        org: [{ name: 'sales-weekly', contentDigest: DIGEST }],
        user: 'deny',
      },
    );
  });

  it('形状坏掉时按最小可用读法降级，不抛（结构问题另有报告）', () => {
    const view = skillPolicyOf({
      skillPolicy: { system: { mode: 'weird', names: 'nope' }, org: [{ name: 'x' }], user: 'maybe' },
    });
    assert.deepEqual(view, { systemMode: 'all', systemNames: [], org: [], user: 'allow' });
  });
});

describe('skillPolicyStructureIssues', () => {
  it('缺省与合法形状都无问题', () => {
    assert.deepEqual(skillPolicyStructureIssues({}), []);
    assert.deepEqual(
      skillPolicyStructureIssues({
        skillPolicy: { system: { mode: 'allowlist', names: ['pdf'] }, org: [{ name: 'x', contentDigest: DIGEST }], user: 'deny' },
      }),
      [],
    );
  });

  it('点名结构错误，让用户去 JSON 修而不是被覆盖', () => {
    assert.match(skillPolicyStructureIssues({ skillPolicy: [] })[0], /must be an object/);
    assert.match(
      skillPolicyStructureIssues({ skillPolicy: { system: { mode: 'some' } } })[0],
      /mode must be/,
    );
    assert.match(
      skillPolicyStructureIssues({ skillPolicy: { system: { names: ['pdf', 7] } } })[0],
      /names must be a list of strings/,
    );
    assert.match(skillPolicyStructureIssues({ skillPolicy: { org: [{ name: 'x' }] } })[0], /org entries/);
    assert.match(skillPolicyStructureIssues({ skillPolicy: { user: 'maybe' } })[0], /user must be/);
  });
});

describe('setSkillPolicy', () => {
  it('allowlist 写名字与摘要；不动兄弟键', () => {
    const source = { schemaVersion: 1, systemPrompt: 'hi', skillPolicy: { user: 'deny' } };
    const next = setSkillPolicy(source, {
      systemMode: 'allowlist',
      systemNames: ['pdf'],
      org: [{ name: 'shared', contentDigest: DIGEST }],
      user: 'allow',
    });
    assert.deepEqual(next.skillPolicy, {
      system: { mode: 'allowlist', names: ['pdf'] },
      org: [{ name: 'shared', contentDigest: DIGEST }],
      user: 'allow',
    });
    assert.equal(next.systemPrompt, 'hi');
    // 原对象不被改动。
    assert.deepEqual(source.skillPolicy, { user: 'deny' });
  });

  it('all / none 不写 names —— 服务端对「非 allowlist 带 names」报错', () => {
    // 用 `user: deny` 让结果**不是**缺省形状：缺省形状会被删键（下一条测试），
    // 那样就看不到 system 了。
    for (const mode of ['all', 'none'] as const) {
      const next = setSkillPolicy({}, {
        systemMode: mode,
        // 即便调用方手里还留着旧名单，也不能写出去。
        systemNames: ['pdf'],
        org: [],
        user: 'deny',
      });
      const system = (next.skillPolicy as { system: Record<string, unknown> }).system;
      assert.equal('names' in system, false, `${mode} must not carry names`);
      assert.equal(system.mode, mode);
    }
  });

  it('allowlist 一定写 names（服务端要求非空）', () => {
    const next = setSkillPolicy({}, {
      systemMode: 'allowlist',
      systemNames: ['pdf'],
      org: [],
      user: 'allow',
    });
    const system = (next.skillPolicy as { system: Record<string, unknown> }).system;
    assert.deepEqual(system.names, ['pdf']);
  });

  it('与缺省等价的形状删掉整个键（省略 = 当前行为，写回会改 config_hash）', () => {
    const next = setSkillPolicy({ systemPrompt: 'x' }, {
      systemMode: 'all',
      systemNames: [],
      org: [],
      user: 'allow',
    });
    assert.equal('skillPolicy' in next, false);
  });

  it('非默认形状保留键（user: deny 也是非默认）', () => {
    const next = setSkillPolicy({}, {
      systemMode: 'all',
      systemNames: [],
      org: [],
      user: 'deny',
    });
    assert.deepEqual(next.skillPolicy, { system: { mode: 'all' }, org: [], user: 'deny' });
  });

  it('结构坏掉时原样返回，不覆盖用户的写法', () => {
    const source = { skillPolicy: { system: { mode: 'weird' } } };
    const next = setSkillPolicy(source, {
      systemMode: 'all',
      systemNames: [],
      org: [],
      user: 'allow',
    });
    assert.deepEqual(next.skillPolicy, { system: { mode: 'weird' } });
  });
});

describe('候选投影', () => {
  const constraints = {
    skills: {
      system: [{ name: 'pdf', description: 'PDF 处理' }, { name: 'xlsx', description: '' }],
      org: [{
        name: 'sales-weekly',
        description: '周报',
        currentDigest: DIGEST,
        versions: [
          { contentDigest: DIGEST, status: 'active', publishedAt: '2026-09-30T00:00:00.000Z' },
          { contentDigest: 'b'.repeat(64), status: 'deprecated', publishedAt: '' },
        ],
      }],
    },
  };

  it('系统层只取名字与描述', () => {
    assert.deepEqual(skillCandidates(constraints), [
      { name: 'pdf', description: 'PDF 处理' },
      { name: 'xlsx', description: '' },
    ]);
  });

  it('org 层带版本与状态', () => {
    const org = orgSkillCandidates(constraints);
    assert.equal(org.length, 1);
    assert.equal(org[0].name, 'sales-weekly');
    assert.equal(org[0].currentDigest, DIGEST);
    assert.deepEqual(org[0].versions.map((v) => v.status), ['active', 'deprecated']);
  });

  it('目录不可读/缺字段时返回空而不是抛（页面按空能力集之外还要显示加载状态）', () => {
    assert.deepEqual(skillCandidates(undefined), []);
    assert.deepEqual(skillCandidates({}), []);
    assert.deepEqual(skillCandidates({ skills: { system: 'nope' } }), []);
    assert.deepEqual(orgSkillCandidates({ skills: { org: [{ name: 'x' }] } }).map((o) => o.versions), [[]]);
  });
});

describe('计数与上限', () => {
  it('mode: all 不计系统层（个数由服务端展开，标签要能被页面解释）', () => {
    assert.equal(skillPolicyCount({ skillPolicy: { system: { mode: 'all' } } }), 0);
    assert.equal(
      skillPolicyCount({ skillPolicy: { system: { mode: 'allowlist', names: ['a', 'b'] } } }),
      2,
    );
    assert.equal(skillPolicyCount({ skillPolicy: { system: { mode: 'none' } } }), 0);
    assert.equal(skillPolicyCount({}), 0);
  });

  it('计数含 org 条目', () => {
    assert.equal(
      skillPolicyCount({
        skillPolicy: { system: { mode: 'allowlist', names: ['a'] }, org: [{ name: 'x', contentDigest: DIGEST }] },
      }),
      2,
    );
  });

  it('上限读 fieldSupport，读不到时退回默认', () => {
    assert.equal(skillLayerMaxItems({ skillPolicy: { fields: { org: { maxItems: 8 } } } }), 8);
    assert.equal(skillLayerMaxItems({}), DEFAULT_SKILL_LAYER_MAX);
    assert.equal(skillLayerMaxItems(undefined), DEFAULT_SKILL_LAYER_MAX);
    assert.equal(skillLayerMaxItems({ skillPolicy: { fields: { org: { maxItems: 0 } } } }), DEFAULT_SKILL_LAYER_MAX);
  });
});
