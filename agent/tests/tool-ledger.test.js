/**
 * B4 — agent-side tool ledger + edit/apply_patch wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxTools } from '../sandbox-tools.js';
import { BASE_TOOL_NAMES } from '../chat-runner.js';

function makeLedgerClient() {
  /** @type {Map<string, object>} */
  const byId = new Map();
  /** @type {Map<string, string>} */
  const byIdem = new Map();
  const calls = { prepare: 0, executing: 0, terminal: 0, edit: 0, patch: 0, write: 0 };

  return {
    calls,
    byId,
    async prepareToolExecution(body) {
      calls.prepare += 1;
      const existingKey = byIdem.get(body.idempotency_key);
      if (existingKey && byId.has(existingKey)) {
        return byId.get(existingKey);
      }
      if (byId.has(body.tool_call_id)) {
        return byId.get(body.tool_call_id);
      }
      const row = {
        tool_call_id: body.tool_call_id,
        run_id: body.run_id,
        status: 'prepared',
        idempotency_key: body.idempotency_key,
        tool_name: body.tool_name,
        arguments: body.arguments,
        session_id: body.session_id,
        conversation_id: body.conversation_id,
        workspace_id: body.workspace_id,
        summary: body.summary,
        result_json: null,
      };
      byId.set(body.tool_call_id, row);
      byIdem.set(body.idempotency_key, body.tool_call_id);
      return row;
    },
    async markToolExecuting(id) {
      calls.executing += 1;
      const row = byId.get(id);
      if (row && (row.status === 'prepared' || row.status === 'waiting_approval')) {
        row.status = 'executing';
      }
      return row;
    },
    async markToolWaitingApproval(id) {
      const row = byId.get(id);
      if (row && row.status === 'prepared') row.status = 'waiting_approval';
      return row;
    },
    async markToolTerminal(id, body) {
      calls.terminal += 1;
      const row = byId.get(id);
      if (!row) return null;
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(row.status)) {
        return row;
      }
      row.status = body.status;
      row.summary = body.summary;
      row.result_summary = body.summary;
      row.error = body.error;
      row.result_json = body.result_json;
      return row;
    },
    async approvalCheck() {
      return { status: 'approved', risk_level: 'low', policy_version: 'test' };
    },
    async writeFile(sessionId, path, content) {
      calls.write += 1;
      return { path, size: content.length };
    },
    async editFile(sessionId, body) {
      calls.edit += 1;
      if (body.old_string === 'dup') {
        return {
          ok: false,
          path: body.path,
          error: 'old_string matched 2 times',
          match_count: 2,
          match_lines: [1, 3],
          before_hash: 'aaa',
        };
      }
      return {
        ok: true,
        path: body.path,
        before_hash: 'bbb',
        after_hash: 'ccc',
        diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n',
        changed_lines: 2,
      };
    },
    async applyPatch(sessionId, body) {
      calls.patch += 1;
      return {
        ok: true,
        path: body.path,
        before_hash: 'ddd',
        after_hash: 'eee',
        diff: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n',
        changed_lines: 2,
      };
    },
  };
}

describe('tool ledger wrapExecute', () => {
  it('includes apply_patch in base tool set', () => {
    assert.ok(BASE_TOOL_NAMES.includes('apply_patch'));
    const tools = createSandboxTools({ sessionId: 's1' });
    assert.ok(tools.some((t) => t.name === 'apply_patch'));
  });

  it('records prepare → executing → succeeded around write', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-1',
      getMeta: () => ({
        run_id: 'run_1',
        conversation_id: 'conv_1',
        session_id: 'sess-1',
        workspace_id: 'ws_1',
      }),
      approvalEnabled: false,
    });
    const write = tools.find((t) => t.name === 'write');
    const result = await write.execute('call_w1', {
      path: 'a.txt',
      content: 'hello',
    });
    assert.equal(client.calls.prepare, 1);
    assert.equal(client.calls.executing, 1);
    assert.equal(client.calls.terminal, 1);
    assert.equal(client.calls.write, 1);
    assert.equal(result.isError, undefined);
    const row = client.byId.get('call_w1');
    assert.equal(row.status, 'succeeded');
    assert.equal(row.tool_name, 'write');
    assert.ok(row.result_json);
  });

  it('idempotent retry replays terminal result without rewrite', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-1',
      getMeta: () => ({ run_id: 'run_1', session_id: 'sess-1' }),
      approvalEnabled: false,
    });
    const write = tools.find((t) => t.name === 'write');
    await write.execute('call_idem', { path: 'a.txt', content: 'one' });
    assert.equal(client.calls.write, 1);

    // Second call same toolCallId → same idempotency key → replay
    const replay = await write.execute('call_idem', { path: 'a.txt', content: 'two' });
    assert.equal(client.calls.write, 1, 'must not write again');
    assert.equal(client.calls.prepare, 2);
    assert.ok(replay.details?.ledger_replay || replay.content);
    const row = client.byId.get('call_idem');
    assert.equal(row.status, 'succeeded');
  });

  it('edit multi-match surfaces count and lines', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-1',
      getMeta: () => ({ run_id: 'run_1' }),
      approvalEnabled: false,
    });
    const edit = tools.find((t) => t.name === 'edit');
    const result = await edit.execute('call_e1', {
      path: 'd.txt',
      old_string: 'dup',
      new_string: 'x',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /match_count=2/);
    assert.deepEqual(result.details.match_lines, [1, 3]);
    assert.equal(client.calls.edit, 1);
    const row = client.byId.get('call_e1');
    assert.equal(row.status, 'failed');
  });

  it('edit success returns diff and hashes', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-1',
      getMeta: () => ({ run_id: 'run_1' }),
      approvalEnabled: false,
    });
    const edit = tools.find((t) => t.name === 'edit');
    const result = await edit.execute('call_e2', {
      path: 'ok.txt',
      old_string: 'unique',
      new_string: 'new',
    });
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, /before_hash=bbb/);
    assert.match(result.content[0].text, /after_hash=ccc/);
    assert.ok(result.details.diff);
  });

  it('apply_patch tool calls sandbox applyPatch', async () => {
    const client = makeLedgerClient();
    const tools = createSandboxTools({
      client,
      sessionId: 'sess-1',
      getMeta: () => ({ run_id: 'run_1' }),
      approvalEnabled: false,
    });
    const patch = tools.find((t) => t.name === 'apply_patch');
    const result = await patch.execute('call_p1', {
      path: 'f.txt',
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    });
    assert.equal(client.calls.patch, 1);
    assert.match(result.content[0].text, /before_hash=ddd/);
    assert.equal(client.byId.get('call_p1').status, 'succeeded');
  });
});
