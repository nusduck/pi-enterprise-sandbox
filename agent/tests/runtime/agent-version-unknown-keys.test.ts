/**
 * 滚动升级护栏（design/skill-catalog-and-agent-binding.md §8，ADR 0015 后果）：
 *
 * `schemaVersion: 1` 的记录在 **Worker 绑定时**出现本进程不认识的顶层键，必须
 * fail-closed。理由是新字段（如 `skillPolicy`）由更新的写入方落库，旧 Worker 不认它，
 * 若当作「省略」继续跑，绑定会**静默失效**——配置说明的行为与实际行为不一致，
 * 且没有任何日志能事后追责。
 *
 * legacy 记录（无 `schemaVersion`）不受此约束：它们本来就带
 * `skills` / `extensions` / `sandboxPolicy` 等 v1 已删除的键，且不可变、不迁移。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bindAgentVersionConfig } from '../../src/infrastructure/dsh/agent-version-bindings.js';
import { V1_TOP_LEVEL_KEYS } from '../../src/infrastructure/dsh/agent-config-key-vocabulary.js';
import { AgentConfigValidator } from '../../src/application/agent-config-validator.js';

/** v1 记录里所有本进程认识的顶层键，逐个给出合法值。 */
const RECOGNIZED_V1_CONFIG: Record<string, unknown> = {
  schemaVersion: 1,
  systemPrompt: 'be brief',
  modelPolicy: {},
  toolPolicy: {},
  mcpServers: [],
  delegation: { agents: [], remoteAgents: [] },
  dataSources: [],
  skillPolicy: { system: { mode: 'all' }, org: [], user: 'allow' },
};

/** 旧记录（无 schemaVersion）真实携带、v1 已无对应字段的键。 */
const LEGACY_ONLY_KEYS: readonly string[] = [
  'skills',
  'extensions',
  'sandboxPolicy',
];

describe('bindAgentVersionConfig：v1 未知顶层键 fail-closed', () => {
  it('接受全部已识别的 v1 顶层键', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: 'v1',
      configJson: { ...RECOGNIZED_V1_CONFIG },
    });
    assert.equal(bound.agentVersionId, 'v1');
  });

  it('v1 记录出现未知顶层键 → DSH_CONFIG_UNSUPPORTED，而不是静默忽略', () => {
    // 形状模拟「更新的写入方落库了一个这个 Worker 还不认识的键」。
    // 这条断言就是「先单独发布旧 Worker 的 fail-closed」的回归保护。
    assert.throws(
      () =>
        bindAgentVersionConfig({
          agentVersionId: 'v1',
          configJson: { ...RECOGNIZED_V1_CONFIG, skillPolicyV2: { user: 'deny' } },
        }),
      (err: { code?: string; message?: string }) =>
        err.code === 'DSH_CONFIG_UNSUPPORTED' &&
        /\bskillPolicyV2\b/.test(String(err.message)),
    );
  });

  it('同一份记录去掉未知键后可以绑定（合法对照，避免「全部拒绝」假通过）', () => {
    const bound = bindAgentVersionConfig({
      agentVersionId: 'v1',
      configJson: { ...RECOGNIZED_V1_CONFIG },
    });
    assert.deepEqual([...bound.dataSources], []);
  });

  it('legacy 记录（无 schemaVersion）带 v1 已删除的键仍照常绑定', () => {
    for (const key of LEGACY_ONLY_KEYS) {
      const bound = bindAgentVersionConfig({
        agentVersionId: 'legacy',
        configJson: {
          systemPrompt: 'be brief',
          modelPolicy: {},
          toolPolicy: {},
          mcpServers: [],
          [key]: key === 'extensions' ? [] : key === 'skills' ? [] : {},
        },
      });
      assert.equal(bound.agentVersionId, 'legacy', `legacy record with "${key}" must still bind`);
    }
  });

  it('未识别的键在 legacy 记录里不被拒绝（legacy 维持现状）', () => {
    // 开关是 `schemaVersion` 是否存在。没有它就按 legacy 读，不套 v1 白名单。
    const bound = bindAgentVersionConfig({
      agentVersionId: 'legacy',
      configJson: { systemPrompt: '', modelPolicy: {}, somethingFromTheFuture: true },
    });
    assert.equal(bound.agentVersionId, 'legacy');
  });

  it('未知键报错时点名全部未知键，便于运维定位', () => {
    assert.throws(
      () =>
        bindAgentVersionConfig({
          agentVersionId: 'v1',
          configJson: {
            ...RECOGNIZED_V1_CONFIG,
            alphaFutureKey: 1,
            betaFutureKey: 2,
          },
        }),
      (err: { message?: string }) => {
        const message = String(err.message);
        return message.includes('alphaFutureKey') && message.includes('betaFutureKey');
      },
    );
  });
});

describe('顶层键词汇表不落后于验证器', () => {
  it('验证器接受的每个 v1 顶层键都在 V1_TOP_LEVEL_KEYS 里', () => {
    // 漂移的后果是「新版本被自己的 Worker 拒绝」：验证器放行 skillPolicy 落库，
    // 但这个进程的绑定白名单没跟上 → 每个新 Run 都被 DSH_CONFIG_UNSUPPORTED 打死。
    const validator = new AgentConfigValidator({
      env: {},
      mcpServers: [],
      remoteAgents: [],
    });
    const fieldSupport = (validator.options() as unknown as {
      fieldSupport: Record<string, unknown>;
    }).fieldSupport;
    const validatorKeys = Object.keys(fieldSupport);
    for (const key of validatorKeys) {
      assert.ok(
        V1_TOP_LEVEL_KEYS.includes(key),
        `validator accepts "${key}" but V1_TOP_LEVEL_KEYS does not list it`,
      );
    }
    assert.ok(validatorKeys.length > 0, 'validator must expose at least one v1 key');
  });
});

/**
 * `skillPolicy` 内部的形状错误同样 fail-closed。
 *
 * 2026-09-30 复审在运行栈上复现：配置为 `system.allowlist = [xlsx]`，只因
 * `skillPolicy.system` 里多了一个更新写入方才认识的键，解析结果为 `null`，
 * 被当成「省略」→ 全部系统 Skill + 用户 Skill，沙箱里挂了 13 个系统包，无任何报错。
 * 这是顶层 P0 护栏要防的同一种「绑定静默失效」，只是发生在下一层。
 */
describe('bindAgentVersionConfig：skillPolicy 形状非法 fail-closed', () => {
  const withPolicy = (skillPolicy: unknown) => ({
    agentVersionId: 'v1',
    configJson: { schemaVersion: 1, skillPolicy },
  });

  for (const [label, policy] of [
    ['嵌套未知键', { system: { mode: 'allowlist', names: ['xlsx'], pinRelease: true }, user: 'deny' }],
    ['未知取值', { system: { mode: 'recommended' } }],
    ['类型错误', { org: 'sales-weekly' }],
  ] as const) {
    it(`${label} → DSH_CONFIG_UNSUPPORTED，而不是回落到默认策略`, () => {
      assert.throws(
        () => bindAgentVersionConfig(withPolicy(policy)),
        (err: { code?: string; message?: string }) =>
          err.code === 'DSH_CONFIG_UNSUPPORTED' && /skillPolicy/.test(String(err.message)),
      );
    });
  }

  it('合法对照：同样的白名单去掉未知键后照常绑定，且保留原策略', () => {
    const bound = bindAgentVersionConfig(withPolicy({ system: { mode: 'allowlist', names: ['xlsx'] }, user: 'deny' }));
    assert.deepEqual(bound.skillPolicy?.system.names, ['xlsx']);
    assert.equal(bound.skillPolicy?.user, 'deny');
  });

  it('省略 skillPolicy 仍是默认策略（全部系统 + 用户），不受影响', () => {
    const bound = bindAgentVersionConfig({ agentVersionId: 'v1', configJson: { schemaVersion: 1 } });
    assert.equal(bound.skillPolicy?.system.mode, 'all');
    assert.equal(bound.skillPolicy?.user, 'allow');
  });
});
