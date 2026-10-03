import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { registerInternalJobsRoutes } from '../src/http/internal-jobs.js';
import type { MySqlJobRegistry } from '../src/shell/job-registry.js';

test('internal jobs list takes owner from validated envelope', async () => {
  const owners: unknown[] = [];
  const app = new Hono();
  registerInternalJobsRoutes(app, {
    jobRegistry: { list: async (owner: unknown) => {
      owners.push(owner);
      return [{ id: 'bash-owned', status: 'running' }];
    } } as unknown as MySqlJobRegistry,
  });
  const envelope = { requestId: 'req', orgId: 'org', userId: 'user', workspaceId: 'ws', fenceToken: 1 };
  const request = (value: unknown) => app.request('/internal/v1/jobs/list', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: value, payload: {} }),
  });
  const ok = await request(envelope);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).data.map((job: { id: string }) => job.id), ['bash-owned']);
  assert.deepEqual(owners, [{ orgId: 'org', userId: 'user', workspaceId: 'ws' }]);
  const invalid = await request({ ...envelope, workspaceId: '' });
  assert.equal(invalid.status, 400);
  assert.equal(owners.length, 1);
});
