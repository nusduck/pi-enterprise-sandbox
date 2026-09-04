/**
 * Agent 目录（多 Agent 选择）的回归测试。
 *
 * 覆盖 `docs/design/multi-agent-selection.md` §11 列出的全部回归项：建会话带
 * agent_id、跨租户 404、非 admin 拒绝、版本不漂移、非法 config 建版本即被拒、
 * 不传 agent_id 时行为不变。
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
import { ConflictError } from '../../src/infrastructure/mysql/errors.js';
import { createFakeRunWorld, FIXED_AUTH } from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-07-18T06:00:00.000Z');
const ADMIN_AUTH = { ...FIXED_AUTH, role: 'admin' };
const MEMBER_AUTH = { ...FIXED_AUTH, role: 'user' };
/** 另一个租户：同一个 provider，不同的 externalOrgId。 */
const OTHER_ORG_AUTH = {
  ...FIXED_AUTH,
  externalOrgId: '770e8400-e29b-41d4-a716-446655440002',
  externalUserId: '880e8400-e29b-41d4-a716-446655440003',
  role: 'admin',
};

function createConversations(world) {
  return new ConversationService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    db: world.rootDb,
    generateId: world.generateId,
    now: NOW,
  });
}

function createCatalog(world) {
  return new AgentCatalogService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    db: world.rootDb,
    generateId: world.generateId,
    now: NOW,
  });
}

function createRuns(world) {
  return new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
  });
}

/** org/user/membership 由第一次建会话 provision 出来。 */
async function provisionOwner(world, auth = ADMIN_AUTH) {
  return createConversations(world).create(auth, { title: 'bootstrap' });
}

describe('AgentCatalogService — 一个 org 下并列多个智能体', () => {
  it('createAgent 建出 definition + v1，并把 active_version_id 指向 v1', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);

    const created = await catalog.createAgent(ADMIN_AUTH, {
      name: '数据分析助手',
      description: 'SQL + 图表',
      config: { systemPrompt: '你是数据分析助手', skills: ['sql'] },
    });

    assert.equal(created.agent.name, '数据分析助手');
    assert.equal(created.version.version_no, 1);
    assert.equal(created.agent.active_version_id, created.version.agent_version_id);
    assert.equal(created.agent.active_version_no, 1);
    assert.equal(created.version.config.systemPrompt, '你是数据分析助手');

    // 与租户默认 Agent **并列**，不是它的新版本。
    const { agents } = await catalog.listAgents(MEMBER_AUTH);
    assert.equal(agents.length, 2);
    assert.deepEqual(
      agents.map((agent) => agent.name).sort(),
      ['default', '数据分析助手'],
    );
  });

  it('非 admin 不能写目录，但可以读', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);

    await assert.rejects(
      () => catalog.createAgent(MEMBER_AUTH, { name: 'nope' }),
      AdminRoleRequiredError,
    );
    // 角色解析不出来时同样拒绝——fail-closed，不回退到"默认允许"。
    await assert.rejects(
      () => catalog.createAgent(FIXED_AUTH, { name: 'nope' }),
      AdminRoleRequiredError,
    );
    assert.equal((await catalog.listAgents(MEMBER_AUTH)).agents.length, 1);
  });

  it('跨租户的 agentId 一律 404，不泄漏存在性', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    await provisionOwner(world, OTHER_ORG_AUTH);
    const catalog = createCatalog(world);

    const mine = await catalog.createAgent(ADMIN_AUTH, { name: '只属于我' });
    const agentId = mine.agent.agent_id;

    for (const call of [
      () => catalog.listVersions(OTHER_ORG_AUTH, agentId, {}),
      () => catalog.createVersion(OTHER_ORG_AUTH, agentId, { config: {} }),
      () => catalog.setActiveVersion(
        OTHER_ORG_AUTH, agentId, mine.version.agent_version_id,
      ),
    ]) {
      await assert.rejects(call, (err) => {
        assert.ok(err instanceof OwnerScopedNotFoundError);
        assert.equal(err.message, 'Agent not found');
        return true;
      });
    }

    // 建会话选别人的 Agent 也是 404，且响应体里没有该 Agent 的任何痕迹。
    await assert.rejects(
      () => createConversations(world).create(OTHER_ORG_AUTH, { agent_id: agentId }),
      (err) => {
        assert.ok(err instanceof OwnerScopedNotFoundError);
        assert.equal(err.message, 'Agent not found');
        return true;
      },
    );
  });

  it('非法 config 在建版本时就被拒，而不是等到 Run 起不来', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);

    // toolPolicy 是数组：投影会把它读成空，Run 报的是"没有 binding"而不是配置错。
    await assert.rejects(
      () => catalog.createAgent(ADMIN_AUTH, {
        name: 'bad-tool-policy',
        config: { toolPolicy: ['bash'] },
      }),
      ValidationError,
    );
    // model 内嵌凭据字段。
    await assert.rejects(
      () => catalog.createAgent(ADMIN_AUTH, {
        name: 'bad-model',
        config: {
          modelPolicy: {
            model: {
              id: 'm', name: 'm', api: 'chat', provider: 'p', baseUrl: '',
              reasoning: false, input: [], cost: {}, contextWindow: 1,
              maxTokens: 1, apiKey: 'sk-leaked',
            },
          },
        },
      }),
      ValidationError,
    );
    assert.equal(world.tables.agent_definitions.length, 1);
  });
});

describe('会话与 Agent 的绑定', () => {
  it('建会话带 agent_id 时绑到该 Agent；不传时行为不变', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);
    const conversations = createConversations(world);

    const analyst = await catalog.createAgent(ADMIN_AUTH, { name: '数据分析助手' });
    const selected = await conversations.create(ADMIN_AUTH, {
      title: '选了分析助手',
      agent_id: analyst.agent.agent_id,
    });
    assert.equal(selected.agent_id, analyst.agent.agent_id);

    const defaulted = await conversations.create(ADMIN_AUTH, { title: '没选' });
    const tenantDefault = world.tables.agent_definitions.find(
      (row) => row.name === 'default',
    );
    assert.equal(defaulted.agent_id, tenantDefault.agent_id);
  });

  it('agent_id 形状非法时报 400，不当成"没选"', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    await assert.rejects(
      () => createConversations(world).create(ADMIN_AUTH, { agent_id: 'not-a-ulid' }),
      ValidationError,
    );
  });

  it('切活跃版本只影响新会话：已有会话的 Run 仍用原版本', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);
    const conversations = createConversations(world);
    const runs = createRuns(world);

    const agent = await catalog.createAgent(ADMIN_AUTH, {
      name: '代码审查助手',
      config: { systemPrompt: 'v1' },
    });
    const agentId = agent.agent.agent_id;
    const v1 = agent.version.agent_version_id;

    const pinned = await conversations.create(ADMIN_AUTH, {
      title: '在 v1 上开的会话',
      agent_id: agentId,
    });

    const v2 = await catalog.createVersion(ADMIN_AUTH, agentId, {
      config: { systemPrompt: 'v2' },
    });
    assert.equal(v2.version.version_no, 2);
    assert.equal(v2.agent.active_version_id, v2.version.agent_version_id);
    assert.notEqual(v2.version.agent_version_id, v1);

    // 老会话的下一轮 Run 仍钉在 v1。
    const oldRun = await runs.execute({
      messages: [{ role: 'user', content: '继续' }],
      auth: { ...ADMIN_AUTH, externalConversationId: pinned.id },
      traceId: 'a'.repeat(32),
      idempotencyKey: 'pinned-follow-up',
    });
    const oldRow = world.tables.runs.find((row) => row.run_id === oldRun.runId);
    assert.equal(oldRow.agent_version_id, v1);

    // 新会话拿到 v2。
    const fresh = await conversations.create(ADMIN_AUTH, {
      title: '在 v2 上开的会话',
      agent_id: agentId,
    });
    const freshRun = await runs.execute({
      messages: [{ role: 'user', content: '你好' }],
      auth: { ...ADMIN_AUTH, externalConversationId: fresh.id },
      traceId: 'b'.repeat(32),
      idempotencyKey: 'fresh-first-turn',
    });
    const freshRow = world.tables.runs.find((row) => row.run_id === freshRun.runId);
    assert.equal(freshRow.agent_version_id, v2.version.agent_version_id);
  });

  it('回滚 = 把 active_version_id 指回旧版本', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);

    const agent = await catalog.createAgent(ADMIN_AUTH, { name: '可回滚' });
    const agentId = agent.agent.agent_id;
    const v1 = agent.version.agent_version_id;
    await catalog.createVersion(ADMIN_AUTH, agentId, { config: { systemPrompt: 'v2' } });

    const rolledBack = await catalog.setActiveVersion(ADMIN_AUTH, agentId, v1);
    assert.equal(rolledBack.agent.active_version_id, v1);
    assert.equal(rolledBack.agent.active_version_no, 1);

    const { versions } = await catalog.listVersions(ADMIN_AUTH, agentId, {});
    assert.deepEqual(versions.map((v) => v.version_no), [2, 1]);
  });

  it('别的 Agent 的 versionId 不能被激活，同样是 404', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    const catalog = createCatalog(world);

    const a = await catalog.createAgent(ADMIN_AUTH, { name: 'A' });
    const b = await catalog.createAgent(ADMIN_AUTH, { name: 'B' });

    await assert.rejects(
      () => catalog.setActiveVersion(
        ADMIN_AUTH, a.agent.agent_id, b.version.agent_version_id,
      ),
      (err) => {
        assert.ok(err instanceof OwnerScopedNotFoundError);
        assert.equal(err.message, 'Agent version not found');
        return true;
      },
    );
  });

  it('同名 Agent 冲突时报可读的错误，而不是裸的 ConflictError', async () => {
    const world = createFakeRunWorld();
    await provisionOwner(world);
    // fake knex 不执行 uk_agent_definitions_org_name，所以直接让仓储抛出真实
    // MySQL 会抛的那个错，验证服务把它翻成了调用方看得懂的 400。
    const catalog = new AgentCatalogService({
      transactionManager: world.transactionManager,
      createRepositories: (db) => {
        const repos = world.createRepositories(db);
        repos.catalog.createDefinition = async () => {
          throw new ConflictError('Agent definition name conflict', {
            resource: 'agent_definitions',
            id: 'org:重名',
          });
        };
        return repos;
      },
      db: world.rootDb,
      generateId: world.generateId,
      now: NOW,
    });

    await assert.rejects(
      () => catalog.createAgent(ADMIN_AUTH, { name: '重名' }),
      (err) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /already exists/);
        return true;
      },
    );
  });
});
