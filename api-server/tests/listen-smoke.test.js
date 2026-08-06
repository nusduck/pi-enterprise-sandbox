/**
 * BFF import + listen smoke (Agent/Sandbox may be unreachable → degraded status OK).
 * Run: node --test api-server/tests/listen-smoke.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BFF_ROOT = path.resolve(__dirname, '..');

async function waitForStatus(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/deps`);
      // The dependency endpoint answers 503 while an upstream is down — the
      // case here by design (deps point at a dead port). Any HTTP response
      // proves the server is listening and serving the aggregated body.
      if (res.status === 200 || res.status === 503) return res.json();
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw lastErr || new Error('status timeout');
}

describe('api-server import/listen smoke', () => {
  it('imports config module', async () => {
    const mod = await import('../src/config.js');
    assert.ok(mod.config);
    assert.equal(typeof mod.config.PORT, 'number');
  });

  it('listens and separates self-scoped probes from dependency status', async () => {
    const port = 20000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: BFF_ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        SANDBOX_BASE_URL: 'http://127.0.0.1:9',
        AGENT_BASE_URL: 'http://127.0.0.1:9',
        AGENT_INTERNAL_TOKEN: '',
        AUTH_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const body = await waitForStatus(port);
      assert.ok(body.status === 'ok' || body.status === 'degraded');
      assert.equal(body.version, '4.0.0');
      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.equal(live.status, 200);
      // Readiness stays 200 with both upstreams dead: it reports whether *this*
      // replica can serve, not whether the system is healthy. Coupling it to
      // upstreams would pull every replica out of rotation together.
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
      assert.equal(ready.status, 200);
    } finally {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
    }
  });
});
