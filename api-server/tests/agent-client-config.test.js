/**
 * BFF config for independent Agent service.
 * Run: node --test api-server/tests/agent-client-config.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../..');

describe('config exposes Agent base URL', () => {
  it('has AGENT_BASE_URL and no AGENT_RUNTIME', async () => {
    const { config } = await import('../config.js');
    assert.equal(typeof config.AGENT_BASE_URL, 'string');
    assert.ok(config.AGENT_BASE_URL.length > 0);
    assert.equal(config.AGENT_RUNTIME, undefined);
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

describe('python agent path is gone', () => {
  it('chat.js has no python proxy', async () => {
    const chat = await import('../routes/chat.js');
    assert.equal(typeof chat.handleChat, 'function');
    assert.equal(chat.handleChatPythonProxy, undefined);
  });
});
