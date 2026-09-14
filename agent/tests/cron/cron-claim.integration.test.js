/**
 * Gated live integration: Cron 抢占事务（design §5.2 / review R3 门槛 T3）。
 *
 * 覆盖真正重叠的事务，不是「A 提交后再跑 B」的顺序探针：一个连接持锁未提交时，
 * 另一个连接进入同一竞争区，必须等锁而不是跳过，提交后也拿不到同一行。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
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

const ORG = '01K0CRJB000000000000000001';
const USER = '01K0CRJB000000000000000002';

describe('cron claim integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('cron claim (TEST_MYSQL_URL)', () => {
  let knex;
  let mysql;
  let ulidMod;
  let containerEnv;
  let cronMod;
  let service;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 直接写库造一条已到期的计划，避开控制面校验。 */
  async function seedJob(overrides = {}) {
    const cronJobId = ulidMod.ulid();
    const row = {
      cron_job_id: cronJobId,
      org_id: ORG,
      user_id: USER,
      agent_id: null,
      name: `job-${cronJobId.slice(-6)}`,
      prompt: 'ping',
      schedule_type: 'cron',
      cron_expression: '*/5 * * * *',
      run_at: null,
      timezone: 'UTC',
      enabled: true,
      next_run_at: '2026-09-12 00:00:00.000',
      last_run_at: null,
      misfire_policy: 'fire_once',
      concurrency_policy: 'forbid',
      auth_provider: 'test',
      external_org_id: 'ext-org',
      external_user_id: 'ext-user',
      claim_token: null,
      deleted_at: null,
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
      ...overrides,
    };
    await knex('cron_jobs').insert(row);
    return cronJobId;
  }

  async function readJob(cronJobId) {
    return knex('cron_jobs').where({ cron_job_id: cronJobId }).first();
  }

  before(async () => {
    mysql = await import('../../src/infrastructure/mysql/index.js');
    ulidMod = await import('../../src/domain/shared/ulid.js');
    containerEnv = await import('../../src/bootstrap/container-env.js');
    cronMod = await import('../../src/application/cron-job-service.js');

    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 5 } });
    await mysql.migrateLatest(knex);

    const orgs = new mysql.OrganizationRepository(knex);
    await orgs
      .createOrganization({ orgId: ORG, name: 'Cron Org', status: 'active' })
      .catch(() => {});
    await orgs
      .createUser({
        userId: USER,
        externalSubject: `sub-${USER}`,
        status: 'active',
        displayName: 'Cron Tester',
      })
      .catch(() => {});
    await orgs
      .addMembership({ orgId: ORG, userId: USER, role: 'member', status: 'active' })
      .catch(() => {});
    // 上面的 catch 只吞重复插入；种子真缺了就地失败，别让后面的断言变成 FK 报错。
    const seededOrg = await knex('organizations').where({ org_id: ORG }).first();
    assert.ok(seededOrg, 'cron 测试种子组织缺失');

    service = new cronMod.CronJobService({
      transactionManager: new mysql.TransactionManager(knex),
      createRepositories: (db) =>
        containerEnv.createRepositoryBundle(db ?? knex, {
          now: () => new Date(),
          generateId: ulidMod.ulid,
        }),
      db: knex,
      // claimDue 不触发执行；executeClaim 由调用方在 commit 之后单独执行。
      createRunService: {
        execute: async () => {
          throw new Error('createRunService must not be called from claimDue');
        },
      },
      generateId: ulidMod.ulid,
      now: () => new Date('2026-09-12T00:10:00.000Z'),
    });
  });

  beforeEach(async () => {
    await knex('cron_job_runs').whereIn(
      'cron_job_id',
      knex('cron_jobs').select('cron_job_id').where({ org_id: ORG }),
    ).del();
    await knex('cron_jobs').where({ org_id: ORG }).del();
  });

  after(async () => {
    if (!knex) return;
    try {
      await knex('cron_job_runs').whereIn(
        'cron_job_id',
        knex('cron_jobs').select('cron_job_id').where({ org_id: ORG }),
      ).del();
      await knex('cron_jobs').where({ org_id: ORG }).del();
    } catch {
      // ignore cleanup errors
    }
    await knex.destroy();
  });

  it('抢占、写执行记录、推进调度与清空批次标记在同一事务内完成', async () => {
    const cronJobId = await seedJob();

    const claims = await service.claimDue(10);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].job.cronJobId, cronJobId);

    const row = await readJob(cronJobId);
    assert.equal(row.claim_token, null, '批次标记不得越过 commit');
    assert.notEqual(
      String(row.next_run_at),
      '2026-09-12 00:00:00.000',
      'next_run_at 必须推进',
    );

    const runs = await knex('cron_job_runs').where({ cron_job_id: cronJobId });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'CLAIMED');
  });

  it('两个重叠事务竞争同一行：后到者等锁，先到者提交后拿不到它', async () => {
    const cronJobId = await seedJob();

    const knexB = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 2 } });
    try {
      // A：手工开事务并抢占，模拟另一台 Worker 的 claimDue 卡在事务中途。
      const trxA = await knex.transaction();
      const reposA = containerEnv.createRepositoryBundle(trxA, {
        now: () => new Date(),
        generateId: ulidMod.ulid,
      });
      const tokenA = ulidMod.ulid();
      const claimedA = await reposA.cronJobs.claimDueBatch(
        new Date('2026-09-12T00:10:00.000Z'),
        10,
        tokenA,
      );
      assert.equal(claimedA, 1);

      // B：走生产 service 路径，与 A 真正重叠。
      const serviceB = new cronMod.CronJobService({
        transactionManager: new mysql.TransactionManager(knexB),
        createRepositories: (db) =>
          containerEnv.createRepositoryBundle(db ?? knexB, {
            now: () => new Date(),
            generateId: ulidMod.ulid,
          }),
        db: knexB,
        createRunService: { execute: async () => { throw new Error('unused'); } },
        generateId: ulidMod.ulid,
        now: () => new Date('2026-09-12T00:10:00.000Z'),
      });

      let settled = false;
      const claimB = serviceB.claimDue(10).then((rows) => {
        settled = true;
        return rows;
      });

      await sleep(500);
      assert.equal(settled, false, 'A 未提交前 B 必须被行锁挡住，而不是跳过该行');

      // A 放弃：回滚必须把批次标记一并撤销。
      await trxA.rollback();

      const claimsB = await claimB;
      assert.equal(claimsB.length, 1, 'A 回滚后该行应回到可抢占状态');
      assert.equal(claimsB[0].job.cronJobId, cronJobId);

      const row = await readJob(cronJobId);
      assert.equal(row.claim_token, null);
      const runs = await knex('cron_job_runs').where({ cron_job_id: cronJobId });
      assert.equal(runs.length, 1, '重叠竞争不得产生重复执行记录');
    } finally {
      await knexB.destroy();
    }
  });

  it('A 提交后 B 不会重复抢占同一个到期时刻', async () => {
    // 整点表达式：本轮只有 00:00 一个到期时刻（下一次 01:00 已超出 now），
    // 这样「两个调度器同时开跑」只应产生一条执行记录。
    const cronJobId = await seedJob({ cron_expression: '0 * * * *' });

    const knexB = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 2 } });
    try {
      const serviceB = new cronMod.CronJobService({
        transactionManager: new mysql.TransactionManager(knexB),
        createRepositories: (db) =>
          containerEnv.createRepositoryBundle(db ?? knexB, {
            now: () => new Date(),
            generateId: ulidMod.ulid,
          }),
        db: knexB,
        createRunService: { execute: async () => { throw new Error('unused'); } },
        generateId: ulidMod.ulid,
        now: () => new Date('2026-09-12T00:10:00.000Z'),
      });

      const [claimsA, claimsB] = await Promise.all([
        service.claimDue(10),
        serviceB.claimDue(10),
      ]);

      assert.equal(
        claimsA.length + claimsB.length,
        1,
        '同一个到期时刻只能被抢到一次',
      );
      const runs = await knex('cron_job_runs').where({ cron_job_id: cronJobId });
      assert.equal(runs.length, 1);
      assert.equal(
        new Set(runs.map((r) => String(r.scheduled_at))).size,
        runs.length,
        '同一 scheduled_at 不得出现两条执行记录',
      );
      const row = await readJob(cronJobId);
      assert.equal(row.claim_token, null);
    } finally {
      await knexB.destroy();
    }
  });

  it('misfire skip 分支也推进调度并清空批次标记', async () => {
    const cronJobId = await seedJob({
      misfire_policy: 'skip',
      next_run_at: '2026-09-11 00:00:00.000', // 远早于 now，超过 misfire grace
    });

    const claims = await service.claimDue(10);
    assert.equal(claims.length, 0, 'skip 策略不产生可执行 claim');

    const row = await readJob(cronJobId);
    assert.equal(row.claim_token, null);
    assert.notEqual(String(row.next_run_at), '2026-09-11 00:00:00.000');

    const runs = await knex('cron_job_runs').where({ cron_job_id: cronJobId });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'SKIPPED');
    assert.equal(runs[0].error_message, 'MISFIRE_SKIPPED');
  });

  it('forbid 策略下已有未结执行时记为 SKIPPED 且不留残留标记', async () => {
    const cronJobId = await seedJob();

    await knex('cron_job_runs').insert({
      cron_job_run_id: ulidMod.ulid(),
      cron_job_id: cronJobId,
      scheduled_at: '2026-09-11 23:55:00.000',
      claimed_at: '2026-09-11 23:55:00.000',
      run_id: null,
      status: 'CLAIMED',
      idempotency_key: `cron:${cronJobId}:2026-09-11T23:55:00.000Z`,
      error_message: null,
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
    });

    const claims = await service.claimDue(10);
    assert.equal(claims.length, 0);

    const row = await readJob(cronJobId);
    assert.equal(row.claim_token, null);

    const runs = await knex('cron_job_runs')
      .where({ cron_job_id: cronJobId })
      .orderBy('scheduled_at', 'asc');
    assert.equal(runs.length, 2);
    assert.equal(runs[1].status, 'SKIPPED');
    assert.equal(runs[1].error_message, 'CONCURRENCY_FORBID');
  });
});
