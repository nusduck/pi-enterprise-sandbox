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
import { BASE_TOOL_NAMES, resolveToolAllowlist } from '../../chat-runner.js';
import { createSkillTools, SKILL_TOOL_NAMES } from '../../skills/tools.js';
import { SKILLS_MODE } from '../../skills/manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Base sandbox tool names (always present). */
const CHAT_TOOL_ALLOWLIST = [
  'read',
  'bash',
  'edit',
  'write',
  'apply_patch',
  'submit_artifact',
  'ls',
  'find',
  'grep',
  'process_start',
  'process_status',
  'process_logs',
  'process_wait',
  'process_write_stdin',
  'process_signal',
  'process_cancel',
];

describe('createSandboxTools override contract', () => {
  it('exposes exactly the base chat allowlist names', () => {
    const tools = createSandboxTools({ sessionId: 'sess-test' });
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...CHAT_TOOL_ALLOWLIST].sort());
    assert.deepEqual(names, [...BASE_TOOL_NAMES].sort());
  });

  it('each tool has name, description, parameters, execute', () => {
    for (const tool of createSandboxTools({ sessionId: 'sess-test' })) {
      assert.equal(typeof tool.name, 'string');
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.parameters, `parameters missing on ${tool.name}`);
      assert.equal(typeof tool.execute, 'function');
    }
  });

  it('chat-runner resolveToolAllowlist is base tools + optional skill tools', () => {
    assert.deepEqual(resolveToolAllowlist(SKILLS_MODE.READONLY).sort(), [...BASE_TOOL_NAMES].sort());
    assert.deepEqual(
      resolveToolAllowlist(SKILLS_MODE.DEVELOPMENT).sort(),
      [...BASE_TOOL_NAMES, ...SKILL_TOOL_NAMES].sort(),
    );
    const runnerSrc = readFileSync(join(__dirname, '../../chat-runner.js'), 'utf8');
    assert.match(runnerSrc, /resolveToolAllowlist/);
    assert.match(runnerSrc, /createSkillTools/);
  });

  it('skill tools only appear in development mode', () => {
    assert.equal(createSkillTools({ mode: SKILLS_MODE.READONLY }).length, 0);
    const dev = createSkillTools({ mode: SKILLS_MODE.DEVELOPMENT });
    assert.deepEqual(dev.map((t) => t.name).sort(), [...SKILL_TOOL_NAMES].sort());
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

  it('ls/find/grep tools defer to sandbox client (not local FS)', async () => {
    const calls = [];
    const client = {
      async lsFiles(sessionId, body) {
        calls.push({ op: 'ls', sessionId, body });
        return { items: [], skipped: [], stats: { matched: 0 }, truncated: false };
      },
      async findFiles(sessionId, body) {
        calls.push({ op: 'find', sessionId, body });
        return { items: [], skipped: [], stats: { matched: 0 }, truncated: false };
      },
      async grepFiles(sessionId, body) {
        calls.push({ op: 'grep', sessionId, body });
        return { matches: [], skipped: [], stats: { matched: 0 }, truncated: false };
      },
    };
    const tools = createSandboxTools({ client, sessionId: 's-search' });
    const ls = tools.find((t) => t.name === 'ls');
    const find = tools.find((t) => t.name === 'find');
    const grep = tools.find((t) => t.name === 'grep');
    await ls.execute('t1', { path: '.', depth: 2 });
    await find.execute('t2', { pattern: '*.py' });
    await grep.execute('t3', { query: 'TODO', regex: false });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].op, 'ls');
    assert.equal(calls[0].sessionId, 's-search');
    assert.equal(calls[1].op, 'find');
    assert.equal(calls[1].body.pattern, '*.py');
    assert.equal(calls[2].op, 'grep');
    assert.equal(calls[2].body.query, 'TODO');
  });
});
