/**
 * 定时任务执行时再查一次智能体可见范围（design docs/design/agent-visibility.md §4）：
 * 后台执行没有 BFF 角色头，owner 的角色从 member_roles 当下读取并随 Run 传下去；
 * 受限智能体对未授予的 owner 记 FAILED，不创建 Run。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CronJobService } from '../../src/application/cron-job-service.js';

const ORG = '01K0CRJB000000000000000001';
const OWNER = '01K0CRJB000000000000000002';
const AGENT = '01K0CRJB000000000000000003';

function world({ visibility, granted = false, roles = [] }) {
  const updates = [];
  const runs = [];
  const repos = {
    organizations: {
      getUser: async () => ({ userId: OWNER, status: 'active' }),
      getMembership: async () => ({ status: 'active' }),
    },
    memberRoles: { listRoles: async () => roles.map((role) => ({ role, source: 'grant' })) },
    catalog: {
      getDefinitionById: async () => ({ agentId: AGENT, orgId: ORG, status: 'active', visibility }),
    },
    agentAccess: { hasGrant: async () => granted },
    cronJobs: {
      updateExecution: async (id, patch) => updates.push(patch),
      getExecution: async () => updates.at(-1),
    },
  };
  const service = new CronJobService({
    transactionManager: { run: async (work) => work({}) },
    createRepositories: () => repos,
    db: {},
    createRunService: {
      execute: async (input) => {
        runs.push(input);
        return { runId: '01K0CRJB000000000000000009' };
      },
    },
    generateId: () => '01K0CRJB000000000000000008',
  });
  const job = {
    orgId: ORG,
    userId: OWNER,
    agentId: AGENT,
    prompt: '日报',
    authProvider: 'bff',
    externalOrgId: 'org_bootstrap',
    externalUserId: 'sso_owner',
  };
  const execution = { cronJobRunId: '01K0CRJB000000000000000007', idempotencyKey: 'cron-1' };
  return { service, job, execution, updates, runs };
}

describe('cron execution respects agent visibility', () => {
  it('fails without creating a run when the owner lost access to a restricted agent', async () => {
    const w = world({ visibility: 'restricted', granted: false });
    const result = await w.service.executeClaim({ job: w.job, execution: w.execution });
    assert.equal(result.status, 'FAILED');
    assert.equal(w.runs.length, 0);
  });

  it('runs for a granted owner', async () => {
    const w = world({ visibility: 'restricted', granted: true });
    const result = await w.service.executeClaim({ job: w.job, execution: w.execution });
    assert.equal(result.status, 'QUEUED');
    assert.equal(w.runs.length, 1);
  });

  it('passes the owner\'s current roles from member_roles, so an admin owner keeps access', async () => {
    const w = world({ visibility: 'restricted', granted: false, roles: ['admin'] });
    const result = await w.service.executeClaim({ job: w.job, execution: w.execution });
    assert.equal(result.status, 'QUEUED');
    assert.equal(w.runs[0].auth.role, 'admin');
  });

  it('leaves org-visible agents unaffected', async () => {
    const w = world({ visibility: 'org' });
    assert.equal((await w.service.executeClaim({ job: w.job, execution: w.execution })).status, 'QUEUED');
  });
});
