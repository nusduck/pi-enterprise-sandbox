/**
 * AgentVersion → Skill 引用账本（ADR 0015 D5，design §5.2/§5.4）。
 *
 * 两个消费方都是安全相关的，所以这里钉的是**它们各自依赖的查询语义**：
 * - 吊销影响面：按 (org, scope, name, digest) 反查，漏报会让运维以为没人受影响；
 * - GC 判定：`isReferenced` 说「没人用」就会删字节，所以它只认 org 层的精确摘要。
 *
 * 还有两条边界：**用户层不进账本**（它随调用者变化，不随 AgentVersion 固定），
 * 以及 `system` 层的摘要是空串（系统层按名选择、不钉摘要）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeKnex, createFakeState } from './fake-knex.js';
import { AgentVersionSkillRefRepository } from '../../src/infrastructure/mysql/repositories/agent-version-skill-ref-repository.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const OTHER_ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Y';
const V1 = '01K0G2PAV8FPMVC9QHJG7JPN50';
const V2 = '01K0G2PAV8FPMVC9QHJG7JPN51';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

function makeRepo() {
  const state = createFakeState();
  return {
    state,
    repo: new AgentVersionSkillRefRepository(createFakeKnex(state), {
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    }),
  };
}

describe('AgentVersionSkillRefRepository.insertForVersion', () => {
  it('登记 system 与 org 两种 scope；system 的摘要是空串', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1,
      orgId: ORG,
      refs: [
        { scope: 'system', name: 'pdf' },
        { scope: 'org', name: 'sales-weekly', contentDigest: DIGEST },
      ],
    });
    // 排序由 SQL 负责（`ORDER BY scope, skill_name`）；假 knex 只保证行集合，
    // 所以这里比**集合**而不是顺序——顺序本身不是这条测试要证明的东西。
    const refs = await repo.listForVersion(V1);
    assert.deepEqual(
      refs.slice().sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`)),
      [
        { agentVersionId: V1, orgId: ORG, scope: 'org', name: 'sales-weekly', contentDigest: DIGEST },
        { agentVersionId: V1, orgId: ORG, scope: 'system', name: 'pdf', contentDigest: '' },
      ],
    );
  });

  it('空引用集合不写任何行（mode: none 且无 org 条目是合法的）', async () => {
    const { repo, state } = makeRepo();
    // 先让假表存在：直接断言一个还没被 touch 过的表拿不到「是不是为空」的答案。
    state.tables['tbl_agsvc_agent_version_skill_refs'] = [];
    await repo.insertForVersion({ agentVersionId: V1, orgId: ORG, refs: [] });
    assert.equal(state.tables['tbl_agsvc_agent_version_skill_refs'].length, 0);
  });

  it('重复条目取第一个而不是撞主键（重复项在任何解释下都指向同一个引用）', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1,
      orgId: ORG,
      refs: [
        { scope: 'system', name: 'pdf' },
        { scope: 'system', name: 'pdf' },
      ],
    });
    assert.equal((await repo.listForVersion(V1)).length, 1);
  });
});

describe('AgentVersionSkillRefRepository 吊销影响面', () => {
  it('只返回引用了**这个精确摘要**的版本', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1, orgId: ORG,
      refs: [{ scope: 'org', name: 'shared', contentDigest: DIGEST }],
    });
    await repo.insertForVersion({
      agentVersionId: V2, orgId: ORG,
      refs: [{ scope: 'org', name: 'shared', contentDigest: OTHER_DIGEST }],
    });
    assert.deepEqual(
      await repo.listVersionsForSkill({ orgId: ORG, name: 'shared', contentDigest: DIGEST }),
      [V1],
    );
  });

  it('未指定 limit 时返回全部版本（支持 100+ 条引用不被截断漏报）', async () => {
    const { repo } = makeRepo();
    for (let i = 1; i <= 101; i++) {
      const verId = `01K0G2PAV8FPMVC9QHJG7JP${String(i).padStart(3, '0')}`;
      await repo.insertForVersion({
        agentVersionId: verId, orgId: ORG,
        refs: [{ scope: 'org', name: 'shared', contentDigest: DIGEST }],
      });
    }
    const all = await repo.listVersionsForSkill({ orgId: ORG, name: 'shared', contentDigest: DIGEST });
    assert.equal(all.length, 101);

    const limited = await repo.listVersionsForSkill({ orgId: ORG, name: 'shared', contentDigest: DIGEST, limit: 50 });
    assert.equal(limited.length, 50);
  });

  it('system 引用不算进「引用某个 org 版本」（系统层不按 Agent 吊销）', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1, orgId: ORG,
      refs: [{ scope: 'system', name: 'shared' }],
    });
    assert.deepEqual(
      await repo.listVersionsForSkill({ orgId: ORG, name: 'shared', contentDigest: '' }),
      [],
    );
  });

  it('跨 org 互不可见', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1, orgId: ORG,
      refs: [{ scope: 'org', name: 'shared', contentDigest: DIGEST }],
    });
    assert.deepEqual(
      await repo.listVersionsForSkill({ orgId: OTHER_ORG, name: 'shared', contentDigest: DIGEST }),
      [],
    );
  });
});

describe('AgentVersionSkillRefRepository GC 判定', () => {
  it('被引用 → true；换一个摘要或换 org → false', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1, orgId: ORG,
      refs: [{ scope: 'org', name: 'shared', contentDigest: DIGEST }],
    });
    assert.equal(await repo.isReferenced({ orgId: ORG, name: 'shared', contentDigest: DIGEST }), true);
    assert.equal(await repo.isReferenced({ orgId: ORG, name: 'shared', contentDigest: OTHER_DIGEST }), false);
    assert.equal(await repo.isReferenced({ orgId: OTHER_ORG, name: 'shared', contentDigest: DIGEST }), false);
  });

  it('system 引用不让 org 版本显得「有人在用」（GC 只看 org 层）', async () => {
    const { repo } = makeRepo();
    await repo.insertForVersion({
      agentVersionId: V1, orgId: ORG,
      // 系统包同名不算 org 版本的引用：system 的摘要是空串，与 org 的摘要不同。
      refs: [{ scope: 'system', name: 'shared' }],
    });
    assert.equal(await repo.isReferenced({ orgId: ORG, name: 'shared', contentDigest: DIGEST }), false);
  });
});
