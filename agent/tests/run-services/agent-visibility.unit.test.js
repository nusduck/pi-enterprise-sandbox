/**
 * 智能体可见范围（design docs/design/agent-visibility.md）：经真实服务
 * （AgentCatalogService / ConversationService / CreateRunService）走一遍，确认判定在
 * **每个使用入口**都生效——列表、显式选择、已绑定会话的后续轮次——而不只是列表过滤。
 * 账本是内存替身；真实 SQL 由 Compose 真实链路在 MySQL 上验证。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentCatalogService } from '../../src/application/agent-catalog-service.js';
import { ConversationService } from '../../src/application/conversation-service.js';
import { CreateRunService } from '../../src/application/create-run-service.js';
import {
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
  ValidationError,
} from '../../src/application/errors.js';
import { createFakeRunWorld, FIXED_AUTH } from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-10-02T06:00:00.000Z');
const ADMIN = { ...FIXED_AUTH, role: 'admin' };
const ALICE = { ...FIXED_AUTH, externalUserId: 'alice-0000-0000-0000-000000000001', role: 'user' };
const BOB = { ...FIXED_AUTH, externalUserId: 'bob-00000-0000-0000-000000000002', role: 'user' };
const OTHER_ORG_ADMIN = {
  ...FIXED_AUTH,
  externalOrgId: '770e8400-e29b-41d4-a716-446655440002',
  externalUserId: '880e8400-e29b-41d4-a716-446655440003',
  role: 'admin',
};

function services(world) {
  const deps = {
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    db: world.rootDb,
    generateId: world.generateId,
    now: NOW,
  };
  return {
    catalog: new AgentCatalogService(deps),
    conversations: new ConversationService(deps),
    runs: new CreateRunService({ ...deps, runQueue: world.runQueue }),
  };
}

let keySeq = 0;
function run(svc, auth, extra = {}) {
  keySeq += 1;
  return svc.runs.execute({
    messages: [{ role: 'user', content: '你好' }],
    auth,
    traceId: 'c'.repeat(32),
    idempotencyKey: `visibility-${keySeq}`,
    ...extra,
  });
}

/** 三个同 org 成员 + 一个受限智能体，返回各自的内部 user_id。 */
async function setup() {
  const world = createFakeRunWorld({ orgSkillGroups: [] });
  const svc = services(world);
  for (const auth of [ADMIN, ALICE, BOB]) await svc.conversations.create(auth, { title: 'bootstrap' });
  const created = await svc.catalog.createAgent(ADMIN, { name: '财务助手', config: { systemPrompt: 'finance' } });
  const agentId = created.agent.agent_id;
  const userIdOf = (auth) => {
    const subject = `bff:${auth.externalUserId}`;
    return world.tables.tbl_agsvc_users.find((u) => u.external_subject === subject).user_id;
  };
  return { world, svc, agentId, aliceId: userIdOf(ALICE), bobId: userIdOf(BOB) };
}

const names = (list) => list.agents.map((a) => a.name);

describe('agent visibility', () => {
  it('new agents are visible to the whole organization (behavior before this feature)', async () => {
    const { svc } = await setup();
    assert.ok(names(await svc.catalog.listAgents(BOB)).includes('财务助手'));
    const listed = (await svc.catalog.listAgents(ADMIN)).agents.find((a) => a.name === '财务助手');
    assert.equal(listed.visibility, 'org');
  });

  it('a restricted agent is listed and usable only by granted members and admins', async () => {
    const { svc, agentId, aliceId } = await setup();
    const access = await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [aliceId] });
    assert.equal(access.visibility, 'restricted');
    assert.deepEqual(access.grants.map((g) => g.user_id), [aliceId]);

    assert.ok(names(await svc.catalog.listAgents(ALICE)).includes('财务助手'));
    assert.ok(!names(await svc.catalog.listAgents(BOB)).includes('财务助手'));
    assert.ok(names(await svc.catalog.listAgents(ADMIN)).includes('财务助手'));

    const ok = await run(svc, ALICE, { agentId });
    assert.ok(ok.runId);
    await assert.rejects(() => run(svc, BOB, { agentId }), OwnerScopedNotFoundError);
    await assert.rejects(
      () => svc.conversations.create(BOB, { title: 'x', agent_id: agentId }),
      OwnerScopedNotFoundError,
    );
    assert.ok((await run(svc, ADMIN, { agentId })).runId, 'admin can still use it');
  });

  it('revoking a grant blocks the next turn of a conversation already bound to the agent', async () => {
    const { svc, agentId, aliceId } = await setup();
    await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [aliceId] });
    const bound = await svc.conversations.create(ALICE, { title: '绑定财务助手', agent_id: agentId });
    assert.ok((await run(svc, { ...ALICE, externalConversationId: bound.id })).runId);

    await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [] });
    await assert.rejects(
      () => run(svc, { ...ALICE, externalConversationId: bound.id }),
      OwnerScopedNotFoundError,
    );
  });

  it('switching back to org clears the list so it cannot silently come back later', async () => {
    const { svc, agentId, aliceId } = await setup();
    await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [aliceId] });
    const open = await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'org', user_ids: [aliceId] });
    assert.deepEqual(open.grants, []);
    const again = await svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [] });
    assert.deepEqual(again.grants, []);
    assert.ok(!names(await svc.catalog.listAgents(ALICE)).includes('财务助手'));
  });

  it('only admins manage access; other organizations get 404', async () => {
    const { svc, agentId, aliceId } = await setup();
    await assert.rejects(() => svc.catalog.getAccess(ALICE, agentId), AdminRoleRequiredError);
    await assert.rejects(
      () => svc.catalog.setAccess(ALICE, agentId, { visibility: 'restricted', user_ids: [aliceId] }),
      AdminRoleRequiredError,
    );
    await svc.conversations.create(OTHER_ORG_ADMIN, { title: 'other org' });
    await assert.rejects(() => svc.catalog.getAccess(OTHER_ORG_ADMIN, agentId), OwnerScopedNotFoundError);
  });

  it('rejects invalid input instead of saving something else', async () => {
    const { svc, agentId, world } = await setup();
    for (const body of [
      { visibility: 'department', user_ids: [] },
      { visibility: 'restricted', user_ids: ['not-a-ulid'] },
      // 合法 ULID 但不是本 org 的活跃成员。
      { visibility: 'restricted', user_ids: ['01M3ZZZZZZZZZZZZZZZZZZZZZZ'] },
      [],
    ]) {
      await assert.rejects(() => svc.catalog.setAccess(ADMIN, agentId, body), ValidationError, JSON.stringify(body));
    }
    const defaultAgent = world.tables.tbl_agsvc_agent_definitions.find((d) => d.name === '通用智能体');
    assert.ok(defaultAgent, 'tenant default agent exists');
    await assert.rejects(
      () => svc.catalog.setAccess(ADMIN, defaultAgent.agent_id, { visibility: 'restricted', user_ids: [] }),
      ValidationError,
    );
    // 失败的保存不留下任何改动。
    assert.equal((await svc.catalog.getAccess(ADMIN, agentId)).visibility, 'org');
  });

  it('a disabled member cannot be granted', async () => {
    const { svc, agentId, bobId, world } = await setup();
    world.tables.tbl_agsvc_organization_memberships.find((m) => m.user_id === bobId).status = 'disabled';
    await assert.rejects(
      () => svc.catalog.setAccess(ADMIN, agentId, { visibility: 'restricted', user_ids: [bobId] }),
      ValidationError,
    );
  });
});
