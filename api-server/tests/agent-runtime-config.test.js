/**
 * AGENT_RUNTIME selection + python proxy helpers.
 * Run: node --test api-server/tests/agent-runtime-config.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

describe('normalizeAgentRuntime / isPythonAgentRuntime', () => {
  it('defaults unknown and empty to node', async () => {
    const { normalizeAgentRuntime, isPythonAgentRuntime } = await import('../config.js');
    assert.equal(normalizeAgentRuntime(undefined), 'node');
    assert.equal(normalizeAgentRuntime(''), 'node');
    assert.equal(normalizeAgentRuntime('NODE'), 'node');
    assert.equal(normalizeAgentRuntime('weird'), 'node');
    assert.equal(isPythonAgentRuntime('node'), false);
    assert.equal(isPythonAgentRuntime('python'), true);
    assert.equal(isPythonAgentRuntime('PYTHON'), true);
  });

  it('config.AGENT_RUNTIME is node or python only', async () => {
    const { config } = await import('../config.js');
    assert.ok(config.AGENT_RUNTIME === 'node' || config.AGENT_RUNTIME === 'python');
  });
});

describe('shared SSE fixture is readable from Node', () => {
  it('lists required frontend event types', () => {
    const fixturePath = join(root, 'tests/fixtures/sse_events.json');
    const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
    for (const t of [
      'token',
      'tool_start',
      'tool_end',
      'file_ready',
      'error',
      'done',
      'session',
      'approval_required',
      'trace',
      'session_closed',
    ]) {
      assert.ok(data.required_event_types.includes(t), `missing ${t}`);
    }
  });
});

describe('handleChat dispatches to python proxy when selected', () => {
  it('exports handleChatPythonProxy', async () => {
    const chat = await import('../routes/chat.js');
    assert.equal(typeof chat.handleChatPythonProxy, 'function');
    assert.equal(typeof chat.handleChat, 'function');
  });
});
