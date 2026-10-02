/**
 * 定时任务的完成后通知策略（design `notification-scenarios.md` D2 / §5.2）：
 * `notify_policy` 随创建/修改写入、随列表与详情返回；非法值 400。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CronJobService } from '../../src/application/cron-job-service.js';
import { ValidationError } from '../../src/application/errors.js';

const ORG = '01K0CRNP000000000000000001';
const OWNER = '01K0CRNP000000000000000002';
const JOB = '01K0CRNP000000000000000003';

function world(existing = null) {
  const created = [];
  const updated = [];
  const repos = {
    organizations: {
      async getUserByExternalSubject() { return { userId: OWNER }; },
      async getMembership() { return { status: 'active' }; },
    },
    externalRefs: {
      async getOrganizationRef() { return { orgId: ORG }; },
    },
    catalog: {
      async getDefinitionById() { return null; },
    },
    cronJobs: {
      async create(input) {
        created.push(input);
        return {
          cronJobId: JOB, orgId: ORG, userId: OWNER, agentId: null,
          name: input.name, prompt: input.prompt, scheduleType: input.scheduleType,
          cronExpression: input.cronExpression, runAt: null, timezone: input.timezone,
          enabled: input.enabled, nextRunAt: input.nextRunAt, lastRunAt: null,
          misfirePolicy: input.misfirePolicy, concurrencyPolicy: input.concurrencyPolicy,
          notifyPolicy: input.notifyPolicy ?? null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
      },
      async requireById() { return existing; },
      async update(id, scope, patch) {
        updated.push(patch);
        return {
          ...existing, ...patch,
          cronJobId: JOB, orgId: ORG, userId: OWNER,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
      },
    },
  };
  const service = new CronJobService({
    transactionManager: { run: async (work) => work({}) },
    createRepositories: () => repos,
    db: {},
    createRunService: { execute: async () => ({}) },
    generateId: () => JOB,
  });
  const auth = { provider: 'bff', externalOrgId: 'org_bootstrap', externalUserId: 'user_1' };
  const input = {
    name: '日报', prompt: '汇总', schedule_type: 'cron', cron_expression: '0 9 * * *', timezone: 'UTC',
  };
  return { service, auth, input, created, updated };
}

describe('cron notify_policy', () => {
  it('defaults to failure and is returned by create', async () => {
    const w = world();
    const job = await w.service.create(w.auth, w.input);
    assert.equal(job.notify_policy, 'failure');
    assert.equal(w.created[0].notifyPolicy, 'failure');
  });

  it('accepts never / always in either naming style', async () => {
    const never = world();
    assert.equal((await never.service.create(never.auth, { ...never.input, notify_policy: 'never' })).notify_policy, 'never');
    const always = world();
    assert.equal((await always.service.create(always.auth, { ...always.input, notifyPolicy: 'always' })).notify_policy, 'always');
  });

  it('rejects anything else with 400 VALIDATION_ERROR and writes nothing', async () => {
    const w = world();
    await assert.rejects(
      w.service.create(w.auth, { ...w.input, notify_policy: 'sometimes' }),
      (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
    );
    assert.equal(w.created.length, 0);
  });

  it('update keeps the existing policy unless the request sets one', async () => {
    const existing = {
      cronJobId: JOB, orgId: ORG, userId: OWNER, agentId: null,
      name: '日报', prompt: '汇总', scheduleType: 'cron', cronExpression: '0 9 * * *',
      runAt: null, timezone: 'UTC', enabled: true, nextRunAt: null, lastRunAt: null,
      misfirePolicy: 'fire_once', concurrencyPolicy: 'forbid', notifyPolicy: 'always',
    };
    const w = world(existing);
    const kept = await w.service.update(JOB, w.auth, { name: '日报 v2' });
    assert.equal(kept.notify_policy, 'always');
    const changed = await w.service.update(JOB, w.auth, { name: '日报 v3', notify_policy: 'never' });
    assert.equal(changed.notify_policy, 'never');
  });

  it('update rejects an invalid policy', async () => {
    const existing = {
      cronJobId: JOB, orgId: ORG, userId: OWNER, agentId: null,
      name: '日报', prompt: '汇总', scheduleType: 'cron', cronExpression: '0 9 * * *',
      runAt: null, timezone: 'UTC', enabled: true, nextRunAt: null, lastRunAt: null,
      misfirePolicy: 'fire_once', concurrencyPolicy: 'forbid', notifyPolicy: 'failure',
    };
    const w = world(existing);
    await assert.rejects(
      w.service.update(JOB, w.auth, { notify_policy: 'everytime' }),
      (err) => err instanceof ValidationError && err.code === 'VALIDATION_ERROR',
    );
  });

  it('get returns the stored policy', async () => {
    const existing = {
      cronJobId: JOB, orgId: ORG, userId: OWNER, agentId: null,
      name: '日报', prompt: '汇总', scheduleType: 'cron', cronExpression: '0 9 * * *',
      runAt: null, timezone: 'UTC', enabled: true, nextRunAt: null, lastRunAt: null,
      misfirePolicy: 'fire_once', concurrencyPolicy: 'forbid', notifyPolicy: 'never',
    };
    const w = world(existing);
    assert.equal((await w.service.get(JOB, w.auth)).notify_policy, 'never');
  });
});
