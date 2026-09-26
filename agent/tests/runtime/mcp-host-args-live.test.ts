/**
 * 宿主参数：**真实** MCP Server 端到端（docs/design/mcp-per-agent-arguments.md §8）。
 *
 * 纯函数单测（tests/domain/mcp-host-arguments.unit.test.ts）证不了「DSH 的 scope
 * 注册真的遮蔽了 global、模型请求里真的没有宿主参数、Server 真的收到了按 Agent
 * 注入的值」——这些只能起真插件树看。跑在子进程里，理由同 mcp-live.test.ts。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, '../..');
const server = join(here, 'fixtures/mcp-host-args-server.mjs');

function received(call: { text: string }): Record<string, unknown> {
  const match = /RECEIVED (\{.*?\}) pid=/.exec(call.text.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  assert.ok(match, `server did not echo arguments: ${call.text}`);
  return JSON.parse(match[1]);
}

test('宿主参数：schema 去掉、按 Agent 注入、模型不能覆盖、审批看到实际参数、缺值隐藏、重连后仍生效', () => {
  const env = {
    ...process.env,
    MCP_SERVERS_JSON: JSON.stringify([
      { serverId: 'qa', command: 'node', args: [server], hostArguments: { kb_id: { description: '知识库 ID' } } },
    ]),
    SANDBOX_INTERNAL_HMAC_KEYRING: '{"k1":"a2tra2tra2tra2tra2tra2tra2tra2tra2tra2tra2s"}',
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
    LLMIO_API_KEY: 'mcp-host-args-probe',
  };
  const out = execFileSync('npx', ['tsx', join(here, 'fixtures/mcp-host-args-probe.ts')], {
    cwd: agentDir,
    env,
    encoding: 'utf8',
    timeout: 150_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `probe printed no RESULT line:\n${out}`);
  const r = JSON.parse(line.slice('RESULT '.length));

  // Global definition keeps the server contract; only the Run scopes differ.
  assert.deepEqual(r.globalAskProps, ['question', 'kb_id', 'top_k']);
  assert.deepEqual(r.globalAskPropsAfter, ['question', 'kb_id', 'top_k']);

  // The model's final request: no host argument, tools without one untouched.
  assert.deepEqual(r.wireA.ask, ['question', 'top_k']);
  assert.deepEqual(r.wireB.ask, ['question', 'top_k']);
  assert.deepEqual(r.wireA.ping, []);
  // Agent C configured no kb_id and kb_id is required: the tool is not offered.
  assert.equal(r.wireC.ask, null);
  assert.deepEqual(r.wireC.ping, []);

  // What the server actually received, from two concurrent Runs.
  assert.deepEqual(received(r.callA), { question: 'q-a', kb_id: 'hr' });
  assert.deepEqual(received(r.callB), { question: 'q-b', kb_id: 'finance' });
  // The model cannot switch knowledge bases by supplying the argument itself.
  assert.deepEqual(received(r.callAOverride), { question: 'q-a2', kb_id: 'hr' });

  // Hidden tool: refused before dispatch, nothing reached the server or the ledger.
  assert.equal(r.callCHidden.isError, true);
  assert.match(r.callCHidden.text, /MCP_HOST_ARGUMENTS_MISSING/);
  assert.doesNotMatch(r.callCHidden.text, /RECEIVED/);
  assert.equal(r.callCPing.isError, false);
  assert.deepEqual(r.ledgerC.map((e: { toolName: string }) => e.toolName), ['mcp__qa__ping']);

  // Approval: the pending record (what the approver sees, and what the digest
  // binds) carries the arguments that will be sent — the host value, never the
  // model's attempt. Resuming the approved call needs an open model turn, which a
  // direct tools.execute is not; that DSH path is covered by the approval tests.
  assert.deepEqual(r.approvalShownD, [{ toolName: 'mcp__qa__ask', args: { question: 'q-d', kb_id: 'legal' } }]);

  // The ledger records the arguments that were actually sent.
  assert.deepEqual(r.ledgerA[0], { toolName: 'mcp__qa__ask', args: { question: 'q-a', kb_id: 'hr' } });
  assert.deepEqual(r.ledgerA[1].args, { question: 'q-a2', kb_id: 'hr' });

  // After the server crashed and reconnected, the shadow reaches the new generation.
  assert.equal(r.reconnected, true);
  assert.deepEqual(received(r.callAfterReconnect), { question: 'q-after', kb_id: 'hr' });
});
