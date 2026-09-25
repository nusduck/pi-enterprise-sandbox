/**
 * 跨任务运行历史：参数在查库之前校验；路由 `/internal/cron-jobs/runs` 不会被当成任务 ID。
 * SQL 本身见 cron-claim.integration.test.js（真实 MySQL）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CronJobService } from '../../src/application/cron-job-service.js';
import { ValidationError } from '../../src/application/errors.js';
import { handleCronRoute } from '../../src/presentation/http/cron-routes.js';

function service() {
  return new CronJobService({
    transactionManager: { run: async () => {} },
    createRepositories: () => { throw new Error('must not touch the database'); },
    db: {},
    createRunService: { execute: async () => {} },
    generateId: () => '01K0CRJB000000000000000009',
  });
}

describe('listAllRuns', () => {
  it('rejects bad parameters before any query', async () => {
    const auth = { provider: 'bff', externalOrgId: 'o', externalUserId: 'u' };
    await assert.rejects(service().listAllRuns(auth, { since: 'last week' }), ValidationError);
    await assert.rejects(service().listAllRuns(auth, { limit: '0' }), ValidationError);
    await assert.rejects(service().listAllRuns(auth, { limit: '1001' }), ValidationError);
  });

  it('routes /internal/cron-jobs/runs to the cross-job listing', async () => {
    const calls = [];
    const cronJobService = {
      listAllRuns: async (auth, opts) => { calls.push(['all', opts]); return []; },
      get: async (id) => { calls.push(['get', id]); return {}; },
    };
    const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
    const parsedUrl = new URL('http://agent/internal/cron-jobs/runs?since=2026-08-27T00:00:00.000Z&limit=500');
    const handled = await handleCronRoute({
      req: { method: 'GET', headers: { 'x-acting-user-id': 'u', 'x-acting-organization-id': 'o' } },
      res, parsedUrl, path: parsedUrl.pathname, cronJobService,
    });
    assert.equal(handled, true);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['all', { since: '2026-08-27T00:00:00.000Z', limit: '500' }]]);
    assert.deepEqual(res.body, { cron_job_runs: [] });
  });
});
