/**
 * Gated live integration: Skill 启用 / 停用的 owner 行锁与账本事务（design §3.3 S1，第 4 条）。
 *
 * 覆盖真正重叠的事务：一个连接持有 owner 的 membership 行锁未提交时，同一 owner 的第二个
 * 事务必须等待，另一 owner 不受影响；membership 不存在时不给锁。
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

// Crockford base32: no I, L, O or U — an invalid ULID makes the seed repositories throw.
const ORG = '01K0SKMB000000000000000001';
const USER_A = '01K0SKMB000000000000000002';
const USER_B = '01K0SKMB000000000000000003';
const USER_NO_MEMBERSHIP = '01K0SKMB000000000000000004';
const DIGEST = 'd'.repeat(64);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('skill enablement lock integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('skill enablement owner lock (TEST_MYSQL_URL)', () => {
  let knex;
  let mysql;
  let ulidMod;
  let containerEnv;
  let service;

  const repos = (db) =>
    containerEnv.createRepositoryBundle(db, { now: () => new Date(), generateId: ulidMod.ulid });

  before(async () => {
    mysql = await import('../../src/infrastructure/mysql/index.js');
    ulidMod = await import('../../src/domain/shared/ulid.js');
    containerEnv = await import('../../src/bootstrap/container-env.js');
    service = await import('../../src/application/skill-enablement-service.js');

    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 6 } });
    await mysql.migrateLatest(knex);

    const orgs = new mysql.OrganizationRepository(knex);
    await orgs.createOrganization({ orgId: ORG, name: 'Skill Lock Org', status: 'active' }).catch(() => {});
    for (const userId of [USER_A, USER_B, USER_NO_MEMBERSHIP]) {
      await orgs
        .createUser({ userId, externalSubject: `sub-${userId}`, status: 'active', displayName: userId })
        .catch(() => {});
    }
    for (const userId of [USER_A, USER_B]) {
      await orgs.addMembership({ orgId: ORG, userId, role: 'member', status: 'active' }).catch(() => {});
    }
    // catch 只吞重复插入；种子真缺了就地失败。
    assert.ok(await knex('tbl_agsvc_organization_memberships').where({ org_id: ORG, user_id: USER_A }).first());
    await knex('tbl_agsvc_user_skill_enablements').where({ org_id: ORG }).del();
  });

  after(async () => {
    if (!knex) return;
    try {
      await knex('tbl_agsvc_user_skill_enablements').where({ org_id: ORG }).del();
    } catch {
      // ignore cleanup errors
    }
    await knex.destroy();
  });

  it('同一 owner 的第二个事务等第一个提交；另一 owner 不被阻塞', async () => {
    const holder = await knex.transaction();
    try {
      assert.equal(await repos(holder).skillEnablements.lockOwner({ orgId: ORG, userId: USER_A }), true);

      let sameOwnerAcquiredAt = 0;
      const sameOwner = knex.transaction(async (trx) => {
        await repos(trx).skillEnablements.lockOwner({ orgId: ORG, userId: USER_A });
        sameOwnerAcquiredAt = Date.now();
      });

      const otherStarted = Date.now();
      await knex.transaction(async (trx) => {
        assert.equal(await repos(trx).skillEnablements.lockOwner({ orgId: ORG, userId: USER_B }), true);
      });
      assert.ok(Date.now() - otherStarted < 2000, 'a different owner must not wait for the held lock');

      await sleep(400);
      assert.equal(sameOwnerAcquiredAt, 0, 'the same owner must wait while the lock is held');

      const releasedAt = Date.now();
      await holder.commit();
      await sameOwner;
      assert.ok(sameOwnerAcquiredAt >= releasedAt, 'the waiting transaction acquires only after commit');
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  });

  it('membership 不存在时不给锁', async () => {
    await knex.transaction(async (trx) => {
      assert.equal(
        await repos(trx).skillEnablements.lockOwner({ orgId: ORG, userId: USER_NO_MEMBERSHIP }),
        false,
      );
    });
  });

  it('真实事务里启用写账本行、停用删行；账本是发现依据', async () => {
    const owner = { orgId: ORG, userId: USER_A };
    const collected = [];
    const manager = {
      enable: async () => ({ name: 'locked-demo', contentDigest: DIGEST, fileCount: 1, totalBytes: 3 }),
      disable: async () => ({ name: 'locked-demo' }),
      collectVersions: async (input) => {
        collected.push(input.keepDigests);
        return [];
      },
    };
    const common = {
      name: 'locked-demo',
      owner,
      manager,
      transactionManager: new mysql.TransactionManager(knex),
      ledgerFor: (trx) => repos(trx).skillEnablements,
      graceMs: 0,
    };

    await service.mutateSkillWithLedger({ ...common, action: 'enable' });
    assert.deepEqual(
      (await repos(knex).skillEnablements.listForOwner(owner)).map((row) => [row.name, row.contentDigest]),
      [['locked-demo', DIGEST]],
    );

    assert.deepEqual(await service.mutateSkillWithLedger({ ...common, action: 'disable' }), {
      name: 'locked-demo',
      removed: true,
    });
    assert.deepEqual(await repos(knex).skillEnablements.listForOwner(owner), []);
    assert.deepEqual(collected, [[DIGEST], [DIGEST]], 'collection keeps the digest the ledger referenced before commit');
  });
});
