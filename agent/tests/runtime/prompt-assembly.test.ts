import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const output = execFileSync('npx', ['tsx', join(here, 'fixtures/prompt-assembly-probe.ts')], {
  cwd: join(here, '..'), encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, MCP_SERVERS_JSON: '[]' },
});
const result = JSON.parse(output.trim().split('\n').at(-1)!) as {
  requests: Array<{ system: string; tools: string[] }>; persona: string;
};
const [full, restricted, isolated, narrowed, restored, empty, withoutRead, withoutEdit] = result.requests;

test('hidden tools have no call guidance in the actual model request; read remains usable', () => {
  assert.equal(result.requests.length, 8);
  assert.ok(restricted!.tools.includes('read'));
  assert.match(restricted!.system, /Use the read tool/);
  for (const name of ['write', 'edit', 'bash', 'job_output', 'job_kill', 'submit_artifact']) {
    assert.ok(!restricted!.tools.includes(name), `${name} schema leaked`);
  }
  assert.doesNotMatch(restricted!.system, /Use the write tool|Use the edit tool|every bash result|Track every background job/);
});

test('multi-tool guidance never recommends a hidden prerequisite or alternative', () => {
  assert.deepEqual(withoutRead!.tools, ['edit', 'write']);
  assert.doesNotMatch(withoutRead!.system, /Use the read tool|Use the write tool|Use the edit tool/);
  assert.deepEqual(withoutEdit!.tools, ['read', 'write']);
  assert.match(withoutEdit!.system, /Use the read tool/);
  assert.doesNotMatch(withoutEdit!.system, /Use the write tool|prefer edit/);
});

test('empty persona gets task completion rules and capability-scoped artifact delivery', () => {
  assert.ok(full!.tools.includes('submit_artifact'));
  assert.match(full!.system, /## Doing work/);
  assert.match(full!.system, /verified facts, inferences, and unknowns/);
  assert.match(full!.system, /submit_artifact/);
  assert.doesNotMatch(restricted!.system, /submit_artifact/);
  assert.ok(restricted!.system.includes(result.persona));
  assert.ok(restricted!.system.indexOf('## Policy') < restricted!.system.indexOf('## Doing work'));
  assert.ok(restricted!.system.indexOf('## Doing work') < restricted!.system.indexOf(result.persona));
});

test('guidance is recomputed per step and does not leak between Agent scopes', () => {
  assert.deepEqual(isolated!.tools, full!.tools);
  assert.equal(isolated!.system, full!.system);
  assert.deepEqual(narrowed!.tools, ['read']);
  assert.match(narrowed!.system, /Use the read tool/);
  assert.doesNotMatch(narrowed!.system, /Use the write tool|Use the edit tool|every bash result|Track every background job|submit_artifact/);
  assert.deepEqual(restored!.tools, full!.tools);
  assert.equal(restored!.system, full!.system);
  assert.deepEqual(empty!.tools, []);
  assert.match(empty!.system, /## Doing work/);
  assert.doesNotMatch(empty!.system, /Use the read tool|Use the write tool|Use the edit tool|every bash result|Track every background job|submit_artifact/);
});
