/**
 * `/api/cron-jobs/runs`：跨任务运行历史只转发 since / limit，身份由服务端写入；
 * 路由在单任务路由之前（否则 `runs` 会被当成任务 ID）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAgentAllCronJobRuns } from '../src/services/agent-client.js';

describe('/api/cron-jobs/runs', () => {
  it('forwards since and limit with the projected identity', async (t) => {
    const seen = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      seen.push({ url: new URL(String(url)), init });
      return new Response(JSON.stringify({ cron_job_runs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    t.after(() => { globalThis.fetch = original; });
    await listAgentAllCronJobRuns({ since: '2026-08-27T00:00:00.000Z', limit: '500' }, { auth: { actingUserId: 'u', actingOrganizationId: 'o' } });
    assert.equal(seen[0].url.pathname, '/internal/cron-jobs/runs');
    assert.deepEqual(Object.fromEntries(seen[0].url.searchParams), { since: '2026-08-27T00:00:00.000Z', limit: '500' });
    assert.equal(seen[0].init.headers['X-Acting-User-Id'], 'u');
  });

  it('is routed before the single-job routes', () => {
    const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
    const all = server.indexOf("path === '/api/cron-jobs/runs'");
    const single = server.indexOf('/^\\/api\\/cron-jobs\\/([^/]+)$/');
    assert.ok(all > 0 && single > 0 && all < single);
  });
});
