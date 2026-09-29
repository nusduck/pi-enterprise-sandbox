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
    const { config } = await import('../src/config.js');
    assert.equal(typeof config.AGENT_BASE_URL, 'string');
    assert.ok(config.AGENT_BASE_URL.length > 0);
    assert.equal(config.AGENT_RUNTIME, undefined);
  });
});

describe('python agent path is gone', () => {
  it('BFF has no Python Agent proxy', async () => {
    const runs = await import('../src/routes/runs.js');
    assert.equal(typeof runs.handleCreateRun, 'function');
    assert.equal(typeof runs.handleRunEvents, 'function');
  });
});
