/**
 * Gated live integration: 租户默认 Agent 惰性创建的并发竞争（2026-09-18 K8s 演练发现）。
 *
 * 组织与用户已存在、默认 Agent 还没建时，同一组织的多个会话并发创建会在
 * `uk_agent_definitions_org_name` 上撞键。期望：全部成功且只有一个默认 Agent；
 * 任何一次冲突都应走可重试路径，而不是把通用 ConflictError（HTTP 409）抛给调用方。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const require = createRequire(import.meta.url);

function mysqlDepsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const runLive =
  Boolean(TEST_MYSQL_URL) &&
  mysqlDepsAvailable() &&
  (TEST_MYSQL_URL.startsWith('mysql://') || TEST_MYSQL_URL.startsWith('mysql2://'));

const describeLive = runLive ? describe : describe.skip;
const CONCURRENCY = 8;

describe('default agent race integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('default agent race (TEST_MYSQL_URL)', () => {
  let knex;
  let mysql;
  let ulidMod;
  let containerEnv;
  let service;
  let ExternalReferenceRepository;

  before(async () => {
    ({ ExternalReferenceRepository } = await import(
      '../../src/infrastructure/mysql/repositories/external-reference-repository.js'
    ));
    mysql = await import('../../src/infrastructure/mysql/index.js');
    ulidMod = await import('../../src/domain/shared/ulid.js');
    containerEnv = await import('../../src/bootstrap/container-env.js');
    const { ConversationService } = await import('../../src/application/conversation-service.js');

    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: CONCURRENCY + 2 } });
    await mysql.migrateLatest(knex);
    service = new ConversationService({
      transactionManager: new mysql.TransactionManager(knex),
      createRepositories: (db) =>
        containerEnv.createRepositoryBundle(db ?? knex, {
          now: () => new Date(),
          generateId: ulidMod.ulid,
        }),
      db: knex,
      generateId: ulidMod.ulid,
    });
  });

  after(async () => {
    if (knex) await mysql.destroyMysqlKnex(knex);
  });

  /** 组织、组织外部引用、用户与成员关系就位，但不建默认 Agent（与 BFF 注册后的状态一致）。 */
  async function seedOrgWithUsers(count) {
    const provider = 'bff';
    const externalOrgId = `race-org-${ulidMod.ulid()}`;
    const orgId = ulidMod.ulid();
    const orgs = new mysql.OrganizationRepository(knex);
    const refs = new ExternalReferenceRepository(knex);
    await orgs.createOrganization({ orgId, name: externalOrgId, status: 'active' });
    await refs.createOrganizationRef({ provider, externalSubject: externalOrgId, orgId });
    const users = [];
    for (let i = 0; i < count; i += 1) {
      const externalUserId = `race-user-${i}-${orgId}`;
      const userId = ulidMod.ulid();
      await orgs.createUser({
        userId,
        externalSubject: `${provider}:${externalUserId}`,
        displayName: externalUserId,
        status: 'active',
      });
      await orgs.addMembership({ orgId, userId, role: 'member', status: 'active' });
      users.push({ provider, externalOrgId, externalUserId });
    }
    return { orgId, users };
  }

  it('concurrent first conversations of an existing org all succeed with one default agent', async () => {
    const { orgId, users } = await seedOrgWithUsers(CONCURRENCY);
    assert.equal(
      (await knex('agent_definitions').where({ org_id: orgId })).length,
      0,
      'precondition: the org has no default agent yet',
    );

    const outcomes = await Promise.allSettled(users.map((auth) => service.create(auth, {})));
    const failures = outcomes
      .filter((o) => o.status === 'rejected')
      .map((o) => `${o.reason?.name}:${o.reason?.code}:${o.reason?.message}`);

    assert.deepEqual(failures, [], 'no concurrent create may surface a conflict');
    const definitions = await knex('agent_definitions').where({ org_id: orgId });
    assert.equal(definitions.length, 1);
    assert.equal(
      (await knex('agent_versions').where({ agent_id: definitions[0].agent_id })).length,
      1,
    );
  });

  it('control: creating after the default agent exists succeeds for every caller', async () => {
    const { orgId, users } = await seedOrgWithUsers(CONCURRENCY);
    await service.create(users[0], {});
    const outcomes = await Promise.allSettled(users.map((auth) => service.create(auth, {})));
    assert.equal(outcomes.filter((o) => o.status === 'rejected').length, 0);
    assert.equal((await knex('agent_definitions').where({ org_id: orgId })).length, 1);
  });
});
