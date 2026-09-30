/**
 * Agent → exec 的 Skill 清单映射（ADR 0015 D4/D5 / design §6.3、§8）。
 *
 * 这里钉的是**下发形状**：系统层走 `systemSkills`（**总是下发**，空数组 = 一个
 * 都不挂；缺省在 exec 那边是兼容期旧 Agent 的整树挂载，design §8），按摘要分版本
 * 的走 `enabledSkills` 且带 `scope` 让 exec 选 owner 根。挂载是否正确由 exec 侧的
 * 测试与真实链路证明，这里只保证「说出去的话」与有效清单一致。
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';

import { buildExecRpcConfig } from '../../src/infrastructure/dsh/runtime-factory.js';

const env = {
  SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({
    k1: Buffer.from('0'.repeat(32)).toString('base64url'),
  }),
  SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
};

const input = {
  context: {
    orgId: 'org-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    runId: 'run-1',
    executionFenceToken: 3,
  },
  cwd: '/ws',
};

const DIGEST = 'a'.repeat(64);

function systemEntry(names: string[]) {
  return { kind: 'system' as const, root: '/home/sandbox/skill', filtered: true, names };
}

function publishedEntry(kind: 'user' | 'org', name: string) {
  return {
    kind,
    name,
    contentDigest: DIGEST,
    versionRoot: `/published/${name}/.v/${DIGEST}`,
    packageDir: `/published/${name}/.v/${DIGEST}/${name}`,
  };
}

describe('buildExecRpcConfig：systemSkills', () => {
  it('按名单过滤时下发 systemSkills（含空数组 = 一个都不挂）', () => {
    assert.deepEqual(
      buildExecRpcConfig({ ...input, additionalSkillPaths: [systemEntry(['pdf'])] }, env).systemSkills,
      ['pdf'],
    );
    // `mode: none` 或名字都不在 release 里：下发空数组，exec 挂 0 个系统包。
    assert.deepEqual(
      buildExecRpcConfig({ ...input, additionalSkillPaths: [systemEntry([])] }, env).systemSkills,
      [],
    );
  });

  it('旧形状（裸目录字符串）不再有「不下发」这条退路：下发空数组', () => {
    const config = buildExecRpcConfig(
      { ...input, additionalSkillPaths: ['/home/sandbox/skill'] },
      env,
    );
    // 裸字符串是 `effectiveSystemSkills` 的旧形状回退，生产路径不产生它
    // （`resolveRunSkillPaths` 一律给结构化项）。收紧后它不能变成「整树挂载」：
    // 解析不出名字集就下发空数组，宁可一个都不挂。
    assert.deepEqual(config.systemSkills, []);
  });

  it('完全没有清单时也下发空数组（字段必需，不是可选）', () => {
    const config = buildExecRpcConfig(input, env);
    assert.deepEqual(config.systemSkills, []);
  });
});

describe('buildExecRpcConfig：enabledSkills 的 scope', () => {
  it('user 层省略 scope，org 层显式 scope: org', () => {
    const config = buildExecRpcConfig({
      ...input,
      additionalSkillPaths: [
        systemEntry([]),
        publishedEntry('user', 'mine'),
        publishedEntry('org', 'shared'),
      ],
    }, env);
    assert.deepEqual(config.enabledSkills, [
      { name: 'mine', contentDigest: DIGEST },
      { name: 'shared', contentDigest: DIGEST, scope: 'org' },
    ]);
  });

  it('只有系统层时不下发 enabledSkills', () => {
    const config = buildExecRpcConfig({ ...input, additionalSkillPaths: [systemEntry(['pdf'])] }, env);
    assert.equal('enabledSkills' in config, false);
  });
});
