// Run from repository root with Node 22 and the installed tsx loader.
// Isolated probes: no database, network, model, or sandbox process is started.
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Hono } from '../../../exec/node_modules/hono/dist/index.js';
import { registerInternalShellRoutes } from '../../../exec/src/http/internal-shell.ts';
import { IsolatedShellExecutor } from '../../../exec/src/shell/executor.ts';
import { createDurableSubagentProvider } from '../../../agent/src/runtime/providers/durable-subagent.ts';
import { ExecRpcClient } from '../../../agent/src/runtime/providers/exec-rpc.ts';

const app = new Hono();
registerInternalShellRoutes(app, {
  workspaceManager: { physicalWorkspacePath: () => '/tmp/review-ws', physicalTempPath: () => '/tmp/review-temp' },
  systemSkillRoot: '/tmp/review-skills', enabledSkillPackagesFor: () => [],
  bwrapExecutable: '/unused', modeFor: () => 'workspace-write',
});
const original = IsolatedShellExecutor.prototype.run;
let received;
IsolatedShellExecutor.prototype.run = async function (spec) { received = spec; return {}; };
try {
  const response = await app.request('/internal/v1/shell/run', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      envelope: { requestId: 'r', orgId: 'o', userId: 'u', workspaceId: 'w', fenceToken: 1 },
      payload: { command: 'pwd', workdir: '/home/sandbox/workspace/subdir', stdin: 'hello', env: { REVIEW: 'yes' }, stdoutMaxBytes: 123, timeoutMs: 120000 },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(received.workdir, '.');
  assert.equal(received.stdin, undefined);
  assert.equal(received.env, undefined);
  assert.notEqual(received.stdoutMaxBytes, 123);
  console.log('CONFIRMED: shell route silently drops workdir/stdin/env/stdoutMaxBytes');
} finally { IsolatedShellExecutor.prototype.run = original; }

const controller = new AbortController();
let reads = 0;
const provider = createDurableSubagentProvider({
  queue: { add: async () => {} },
  store: { getResult: async () => ++reads >= 6 ? { output: [], stopReason: 'completed' } : null },
  tenantOf: () => ({ orgId: 'o', userId: 'u', parentSessionId: 's' }),
});
const run = await provider.start({ parent: { id: 'p' }, prompt: [{ type: 'text', text: 'probe' }], signal: controller.signal });
await run.result;
await run.dispose();
const retained = getEventListeners(controller.signal, 'abort').length;
assert.equal(retained, 5);
console.log(`CONFIRMED: ${retained} abort listeners remain after five polls and dispose`);

let elapsed;
const rpc = new ExecRpcClient({
  baseUrl: 'http://unused.invalid', keyring: { review: randomBytes(32).toString('base64url') }, activeKid: 'review',
  orgId: 'o', userId: 'u', workspaceId: 'w', fenceToken: 1, physicalRoots: [],
  fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
    const start = Date.now();
    init.signal.addEventListener('abort', () => { elapsed = Date.now() - start; reject(new Error('probe abort')); }, { once: true });
  }),
});
await assert.rejects(rpc.post('/internal/v1/shell/run', { command: 'sleep 20', timeoutMs: 120000 }, []));
assert.ok(elapsed >= 14000 && elapsed < 25000);
console.log(`CONFIRMED: 120000ms shell payload aborted by RPC after ${elapsed}ms (fake transport)`);
