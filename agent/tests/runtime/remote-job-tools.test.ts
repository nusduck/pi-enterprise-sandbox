import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { RemoteJobs } from '../../src/runtime/providers/remote-jobs.js';
import { apply } from '../../src/runtime/providers/remote-job-tools.js';

test('model job tools await exec results across workers and propagate failures', async () => {
  const calls: string[] = [];
  const snap = { id: 'bash-old', kind: 'bash', label: 'old command', status: 'completed', startedAt: 1, finishedAt: 2, reported: false, outputLimitBytes: 30 };
  let failRead = false;
  const fetchImpl = (async (url: string | URL | Request) => {
    const path = String(url);
    calls.push(path);
    if (failRead && path.endsWith('/jobs/read')) {
      return new Response(JSON.stringify({ ok: false, error: { code: 'WORKSPACE_NOT_FOUND', message: 'job not found' } }), { status: 404 });
    }
    const data = path.endsWith('/jobs/list') ? [snap]
      : path.endsWith('/jobs/read') ? { text: 'OLD_OUTPUT\n', nextCursor: '0-11', snapshot: snap }
      : snap;
    return new Response(JSON.stringify({ ok: true, data }));
  }) as typeof fetch;
  const jobs = new RemoteJobs(new Context(), {
    baseUrl: 'http://exec', keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test', orgId: 'org', userId: 'user', workspaceId: 'ws',
    runId: 'run', fenceToken: 1, systemSkills: [], physicalRoots: [], fetchImpl,
  });
  const definitions = new Map<string, any>();
  const ctx = {
    jobs,
    tools: { register: (definition: any) => { definitions.set(definition.name, definition); return () => undefined; } },
    systemPrompt: { section: () => undefined },
    on: () => undefined,
  };
  apply(ctx as any, {});
  const exec = { agent: undefined, signal: undefined };
  const list = await definitions.get('job_list').execute({}, exec);
  assert.equal(list[0].id, snap.id);
  const read = await definitions.get('job_output').execute({ job_id: snap.id }, exec);
  assert.equal(read.text, 'OLD_OUTPUT\n');
  assert.equal(read.job.status, 'completed');
  const bounded = definitions.get('job_output').finalizeContent(exec, {
    value: read, isError: false,
    content: [{ type: 'text', text: `${'x'.repeat(100)}\n[status: completed]` }],
  });
  assert.ok(Buffer.byteLength(bounded[0].text) <= 30);
  assert.match(bounded[0].text, /completed\]$/);
  const killed = await definitions.get('job_kill').execute({ job_id: snap.id }, exec);
  assert.equal(killed.outcome, 'already-finished');
  assert.equal(calls.filter((path) => path.endsWith('/jobs/kill')).length, 0);
  failRead = true;
  await assert.rejects(definitions.get('job_output').execute({ job_id: snap.id }, exec));
});
