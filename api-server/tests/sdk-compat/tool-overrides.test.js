/**
 * Sandbox custom tools must override SDK host built-ins for allowlisted names.
 * Run: node --test api-server/tests/sdk-compat/tool-overrides.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxTools } from '../../sandbox-tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Names passed to createAgentSession({ tools }) in routes/chat.js */
const CHAT_TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'submit_artifact'];

describe('createSandboxTools override contract', () => {
  it('exposes exactly the chat allowlist names', () => {
    const tools = createSandboxTools({ sessionId: 'sess-test' });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...CHAT_TOOL_ALLOWLIST].sort());
  });

  it('each tool has name, description, parameters, execute', () => {
    for (const tool of createSandboxTools({ sessionId: 'sess-test' })) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.parameters, `parameters missing on ${tool.name}`);
      assert.equal(typeof tool.execute, 'function');
    }
  });

  it('chat.js allowlist matches createSandboxTools names (source contract)', () => {
    const chatSrc = readFileSync(join(__dirname, '../../routes/chat.js'), 'utf8');
    // tools: ['read', 'bash', 'edit', 'write', 'submit_artifact']
    const m = chatSrc.match(/tools:\s*\[([^\]]+)\]/);
    assert.ok(m, 'createAgentSession tools allowlist not found in chat.js');
    const listed = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    const toolNames = createSandboxTools().map((t) => t.name).sort();
    assert.deepEqual(listed, toolNames);
  });

  it('bash tool defers to client.executeCommand (not local shell)', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'low' };
      },
      async executeCommand(sessionId, command, timeout) {
        calls.push({ sessionId, command, timeout });
        return { exit_code: 0, stdout_preview: 'ok', stderr_preview: '', duration_ms: 1 };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's1' });
    const bash = tools.find((t) => t.name === 'bash');
    const result = await bash.execute('tc1', { command: 'echo hi', timeout: 5 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 's1');
    assert.equal(calls[0].command, 'echo hi');
    assert.equal(result.isError, false);
  });

  it('write tool defers to client.writeFile', async () => {
    const calls = [];
    const client = {
      async approvalCheck() {
        return { status: 'approved', risk_level: 'medium' };
      },
      async writeFile(sessionId, path, content) {
        calls.push({ sessionId, path, content });
        return { size: content.length, path };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's2' });
    const write = tools.find((t) => t.name === 'write');
    await write.execute('tc2', { path: 'a.txt', content: 'body' });
    assert.deepEqual(calls, [{ sessionId: 's2', path: 'a.txt', content: 'body' }]);
  });

  it('write tools fail closed when approval check errors', async () => {
    const client = {
      async approvalCheck() {
        throw new Error('upstream down');
      },
      async writeFile() {
        throw new Error('should not write');
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's3' });
    const write = tools.find((t) => t.name === 'write');
    const result = await write.execute('tc3', { path: 'x.txt', content: 'nope' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Approval check failed|upstream down/i);
  });
});
