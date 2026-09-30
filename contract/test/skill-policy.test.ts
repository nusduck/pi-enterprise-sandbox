/**
 * `skill-policy.ts`：`AgentVersion.skillPolicy` 的纯形状校验（ADR 0015 D2，design §4.1）。
 *
 * 断言的是**对外行为**：哪些形状被接受、哪些被拒绝、拒绝时报的 `{path, code}`。
 * 语义校验（名字在不在 release / org 账本里）在 Agent 侧，不在这里。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultSkillPolicy,
  parseSkillPolicy,
  SKILL_POLICY_LAYER_MAX,
  SKILL_POLICY_TOTAL_MAX,
  skillPolicyTooLarge,
} from '../src/skill-policy.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

/** 收集诊断的 `path`/`code`，方便逐条比对。 */
function codes(value: unknown): Array<[string, string]> {
  const parsed = parseSkillPolicy(value);
  assert.equal(parsed.policy, null, `expected rejection for ${JSON.stringify(value)}`);
  return parsed.errors.map((e) => [e.path, e.code]);
}

describe('parseSkillPolicy：缺省即当前行为', () => {
  it('省略等于 { system: all, org: [], user: allow }', () => {
    assert.deepEqual(parseSkillPolicy(undefined).policy, {
      system: { mode: 'all', names: [] },
      org: [],
      user: 'allow',
    });
    assert.deepEqual(parseSkillPolicy(null).policy, defaultSkillPolicy());
  });

  it('空对象同样等于全部系统 + 用户启用', () => {
    assert.deepEqual(parseSkillPolicy({}).policy, {
      system: { mode: 'all', names: [] },
      org: [],
      user: 'allow',
    });
  });
});

describe('parseSkillPolicy：system', () => {
  it('接受三种 mode', () => {
    for (const mode of ['all', 'allowlist', 'none'] as const) {
      const policy = parseSkillPolicy(
        mode === 'allowlist'
          ? { system: { mode, names: ['pdf'] } }
          : { system: { mode } },
      ).policy;
      assert.equal(policy?.system.mode, mode);
    }
  });

  it('allowlist 保留名字顺序', () => {
    const policy = parseSkillPolicy({ system: { mode: 'allowlist', names: ['pdf', 'xlsx'] } }).policy;
    assert.deepEqual([...policy!.system.names], ['pdf', 'xlsx']);
  });

  it('allowlist 没有 names 或 names 为空都报错', () => {
    assert.deepEqual(codes({ system: { mode: 'allowlist' } }), [
      ['skillPolicy.system.names', 'CONFIG_TYPE'],
    ]);
    assert.deepEqual(codes({ system: { mode: 'allowlist', names: [] } }), [
      ['skillPolicy.system.names', 'CONFIG_TYPE'],
    ]);
  });

  it('all / none 带着 names 报错（不许静默忽略）', () => {
    for (const mode of ['all', 'none'] as const) {
      assert.deepEqual(codes({ system: { mode, names: ['pdf'] } }), [
        ['skillPolicy.system.names', 'CONFIG_TYPE'],
      ]);
    }
  });

  it('拒绝未知 mode、重复名、非法名与未知键', () => {
    // mode 坏掉时只报根因，不追加 names 的连带诊断。
    assert.deepEqual(codes({ system: { mode: 'some' } }), [
      ['skillPolicy.system.mode', 'CONFIG_TYPE'],
    ]);
    assert.deepEqual(codes({ system: { mode: 'allowlist', names: ['pdf', 'pdf'] } }), [
      ['skillPolicy.system.names[1]', 'CONFIG_TYPE'],
    ]);
    assert.deepEqual(codes({ system: { mode: 'allowlist', names: ['PDF'] } }), [
      ['skillPolicy.system.names[0]', 'CONFIG_TYPE'],
    ]);
    assert.deepEqual(codes({ system: { mode: 'all', extra: 1 } }), [
      ['skillPolicy.system.extra', 'CONFIG_UNKNOWN_FIELD'],
    ]);
  });

  it('names 超过上限报 CONFIG_LIMIT（不再追加「仅 allowlist 允许」）', () => {
    const names = Array.from({ length: SKILL_POLICY_LAYER_MAX + 1 }, (_, i) => `s${i}`);
    assert.deepEqual(codes({ system: { mode: 'allowlist', names } }), [
      ['skillPolicy.system.names', 'CONFIG_LIMIT'],
    ]);
  });
});

describe('parseSkillPolicy：org', () => {
  it('接受 { name, contentDigest } 并钉住摘要', () => {
    const policy = parseSkillPolicy({ org: [{ name: 'sales-weekly', contentDigest: DIGEST }] }).policy;
    assert.deepEqual(policy?.org, [{ name: 'sales-weekly', contentDigest: DIGEST }]);
  });

  it('摘要必须是 sha256 hex；名字必须合法', () => {
    assert.deepEqual(codes({ org: [{ name: 'x', contentDigest: 'short' }] }), [
      ['skillPolicy.org[0].contentDigest', 'CONFIG_TYPE'],
    ]);
    assert.deepEqual(codes({ org: [{ name: 'X', contentDigest: DIGEST }] }), [
      ['skillPolicy.org[0].name', 'CONFIG_TYPE'],
    ]);
  });

  it('条目只接收 name 与 contentDigest', () => {
    assert.deepEqual(codes({ org: [{ name: 'x', contentDigest: DIGEST, description: 'hi' }] }), [
      ['skillPolicy.org[0].description', 'CONFIG_UNKNOWN_FIELD'],
    ]);
  });

  it('同一个 org 名不能钉两个版本', () => {
    assert.deepEqual(codes({ org: [
      { name: 'x', contentDigest: DIGEST },
      { name: 'x', contentDigest: OTHER },
    ] }), [['skillPolicy.org[1].name', 'CONFIG_TYPE']]);
  });
});

describe('parseSkillPolicy：user', () => {
  it('接受 allow / deny', () => {
    assert.equal(parseSkillPolicy({ user: 'deny' }).policy?.user, 'deny');
    assert.equal(parseSkillPolicy({ user: 'allow' }).policy?.user, 'allow');
  });

  it('拒绝其他取值', () => {
    assert.deepEqual(codes({ user: 'maybe' }), [['skillPolicy.user', 'CONFIG_TYPE']]);
  });
});

describe('parseSkillPolicy：跨层', () => {
  it('system 选中名与 org 名重复报错（防历史数据）', () => {
    assert.deepEqual(codes({
      system: { mode: 'allowlist', names: ['pdf'] },
      org: [{ name: 'pdf', contentDigest: DIGEST }],
    }), [['skillPolicy.org[0].name', 'CONFIG_TYPE']]);
  });

  it('system: all 时不判与 org 的重名（展开后才知道）', () => {
    assert.ok(parseSkillPolicy({
      system: { mode: 'all' },
      org: [{ name: 'pdf', contentDigest: DIGEST }],
    }).policy);
  });

  it('每层上限之和小于总量上限：总量这条必须在展开后再判', () => {
    // 形状阶段能算出的上界是 2 × 64 = 128 < 256，所以 `parseSkillPolicy` 里的总量
    // 判定**不可能**被合法形状触发。真正的把关点是 `skillPolicyTooLarge()`——它在
    // 拿到 release 展开后的 system 名单之后才成立。这条断言把「为什么要有那个函数」
    // 钉住，防止有人以为形状校验已经守住了总量。
    const org = Array.from({ length: SKILL_POLICY_LAYER_MAX }, (_, i) => ({
      name: `o${i}`,
      contentDigest: DIGEST,
    }));
    const names = Array.from({ length: SKILL_POLICY_LAYER_MAX }, (_, i) => `s${i}`);
    assert.ok(parseSkillPolicy({ system: { mode: 'allowlist', names }, org }).policy);
    assert.ok(SKILL_POLICY_LAYER_MAX * 2 < SKILL_POLICY_TOTAL_MAX);
  });

  it('展开后的总量超过上限由 skillPolicyTooLarge 拦下', () => {
    assert.equal(skillPolicyTooLarge({ system: SKILL_POLICY_TOTAL_MAX, org: 0 }), null);
    assert.equal(
      skillPolicyTooLarge({ system: SKILL_POLICY_TOTAL_MAX, org: 0, user: 0 }),
      null,
    );
    const over = skillPolicyTooLarge({ system: SKILL_POLICY_TOTAL_MAX, org: 1 });
    assert.deepEqual(over && [over.path, over.code], ['skillPolicy', 'SKILL_POLICY_TOO_LARGE']);
    // `all` 模式展开出一个很大的 release 时，同样在 Run 之前被拦下。
    assert.equal(
      skillPolicyTooLarge({ system: 300, org: 0 })?.code,
      'SKILL_POLICY_TOO_LARGE',
    );
  });

  it('拒绝未知顶层键与错误类型', () => {
    assert.deepEqual(codes({ nope: 1 }), [['skillPolicy.nope', 'CONFIG_UNKNOWN_FIELD']]);
    assert.deepEqual(codes([]), [['skillPolicy', 'CONFIG_TYPE']]);
  });
});
