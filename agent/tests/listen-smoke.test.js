/**
 * Agent import + listen smoke (no live LLM / Sandbox required for /health).
 * Run: node --test agent/tests/listen-smoke.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.resolve(__dirname, '..');

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return res.json();
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error('health timeout');
}

describe('agent import/listen smoke', () => {
  it('imports config module', async () => {
    const mod = await import('../config.js');
    assert.ok(mod.config);
    assert.equal(typeof mod.config.PORT, 'number');
  });

  it('listens and serves GET /health', async () => {
    const port = 19000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: AGENT_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        SANDBOX_BASE_URL: 'http://127.0.0.1:9',
        LLMIO_BASE_URL: '',
        LLMIO_API_KEY: '',
        AGENT_INTERNAL_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const body = await waitForHealth(port);
      assert.equal(body.status, 'ok');
      assert.equal(body.service, 'pi-enterprise-agent');
    } finally {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
    }
  });
});
