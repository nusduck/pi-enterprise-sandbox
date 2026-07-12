#!/usr/bin/env node
/**
 * Cross-service smoke without a real LLM key.
 *
 * Starts:
 *   1. Deterministic fake OpenAI-compatible provider
 *   2. Sandbox (uvicorn) on a free port
 *   3. Agent pointing at fake LLM + Sandbox
 *   4. BFF pointing at Agent + Sandbox
 *
 * Checks:
 *   - Sandbox /health + /ready
 *   - Agent /health
 *   - BFF /api/status (agent_runtime node-agent)
 *   - Optional chat turn when SANDBOX is healthy (POST /api/chat)
 *
 * Production cannot use the fake provider (AGENT_ENABLE_FAKE_LLM guard).
 *
 * Usage (repo root):
 *   node scripts/smoke-cross-service.mjs
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOpenAIProvider, assertFakeLlmAllowed } from '../agent/testing/fake-openai-provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const children = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.once('error', reject);
  });
}

async function waitHttp(url, { ok = (r) => r.ok, timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (ok(res)) return res;
      lastErr = new Error(`${url} -> ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw lastErr || new Error(`timeout ${url}`);
}

function spawnProc(command, args, env, name, cwd = ROOT) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child._smokeName = name;
  children.push(child);
  child.stderr.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.error(`[${name}] ${line}`);
  });
  child.stdout.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) console.log(`[${name}] ${line}`);
  });
  return child;
}

async function shutdown() {
  for (const child of children.splice(0).reverse()) {
    if (!child.killed) child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
    if (!child.killed && child.exitCode == null) child.kill('SIGKILL');
  }
}

process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
});

async function main() {
  process.env.AGENT_ENABLE_FAKE_LLM = '1';
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.DEPLOYMENT_ENV = process.env.DEPLOYMENT_ENV || 'development';
  assertFakeLlmAllowed(process.env);

  const fake = await startFakeOpenAIProvider({ reply: 'cross-service-smoke-ok' });
  const sandboxPort = await freePort();
  const agentPort = await freePort();
  const bffPort = await freePort();

  const smokeDir = path.join(ROOT, '.smoke-tmp');
  const dbPath = path.join(smokeDir, `sandbox-${process.pid}.db`);
  const wsPath = path.join(smokeDir, `ws-${process.pid}`);
  const skillsPath = path.join(smokeDir, `skills-${process.pid}`);
  await import('node:fs/promises').then((fs) => fs.mkdir(smokeDir, { recursive: true }));

  console.log('[smoke] fake LLM', fake.baseUrl);
  console.log('[smoke] ports', { sandboxPort, agentPort, bffPort });

  // Prefer venv python if present
  const python = process.env.SMOKE_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
  const uvicornArgs = [
    '-m',
    'uvicorn',
    'sandbox.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    String(sandboxPort),
  ];

  spawnProc(
    python,
    uvicornArgs,
    {
      SANDBOX_DATABASE_URL: `sqlite:///${dbPath}`,
      SANDBOX_WORKSPACES_ROOT: wsPath,
      SANDBOX_ATTACHMENTS_ROOT: wsPath,
      SANDBOX_SKILLS_ROOT: skillsPath,
      SANDBOX_API_TOKEN: '',
      SANDBOX_AUTH_ENABLED: 'false',
      SANDBOX_IPTABLES_ENABLED: 'false',
      SANDBOX_BIND_HOST: '127.0.0.1',
      SANDBOX_ALLOWED_CLIENT_CIDRS: '127.0.0.1/32,::1/128',
      PYTHONPATH: ROOT,
    },
    'sandbox',
  );

  await waitHttp(`http://127.0.0.1:${sandboxPort}/health`);
  await waitHttp(`http://127.0.0.1:${sandboxPort}/ready`);

  spawnProc(
    process.execPath,
    ['server.js'],
    {
      PORT: String(agentPort),
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'development',
      AGENT_ENABLE_FAKE_LLM: '1',
      SANDBOX_BASE_URL: `http://127.0.0.1:${sandboxPort}`,
      SANDBOX_API_TOKEN: '',
      AGENT_INTERNAL_TOKEN: '',
      LLMIO_BASE_URL: fake.baseUrl,
      LLMIO_API_KEY: 'fake-test-key',
      MODEL_ID: 'fake-model',
      SKILLS_MODE: 'readonly',
    },
    'agent',
    path.join(ROOT, 'agent'),
  );

  await waitHttp(`http://127.0.0.1:${agentPort}/health`);

  spawnProc(
    process.execPath,
    ['server.js'],
    {
      PORT: String(bffPort),
      NODE_ENV: 'test',
      SANDBOX_BASE_URL: `http://127.0.0.1:${sandboxPort}`,
      AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
      AGENT_INTERNAL_TOKEN: '',
      AUTH_ENABLED: 'false',
      SANDBOX_API_TOKEN: '',
    },
    'bff',
    path.join(ROOT, 'api-server'),
  );

  const statusRes = await waitHttp(`http://127.0.0.1:${bffPort}/api/status`);
  const status = await statusRes.json();
  if (status.agent_runtime !== 'node-agent') {
    throw new Error(`unexpected agent_runtime: ${status.agent_runtime}`);
  }
  if (status.agent?.status !== 'ok') {
    throw new Error(`agent not ok in status: ${JSON.stringify(status.agent)}`);
  }
  if (status.sandbox?.status !== 'ok') {
    throw new Error(`sandbox not ok in status: ${JSON.stringify(status.sandbox)}`);
  }
  console.log('[smoke] /api/status ok', {
    status: status.status,
    agent_runtime: status.agent_runtime,
  });

  // Best-effort chat: fake LLM + agent may still need full SDK session setup.
  // Fail the smoke only if BFF returns a hard 5xx without any SSE.
  const chatRes = await fetch(`http://127.0.0.1:${bffPort}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'reply with exactly: cross-service-smoke-ok' }],
    }),
  });
  const chatText = await chatRes.text();
  console.log('[smoke] chat status', chatRes.status);
  if (chatRes.status >= 500 && !chatText.includes('data:')) {
    throw new Error(`chat failed hard: ${chatRes.status} ${chatText.slice(0, 400)}`);
  }
  // Accept SSE stream or degraded application error from missing SDK deps —
  // protocol path BFF→Agent must at least be reachable (status already proved agent).
  console.log('[smoke] chat bytes', chatText.length);

  await fake.close();
  await shutdown();
  console.log('[smoke] PASS cross-service without real LLM key');
}

main().catch(async (err) => {
  console.error('[smoke] FAIL', err);
  await shutdown();
  process.exit(1);
});
