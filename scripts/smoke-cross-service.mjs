#!/usr/bin/env node
/**
 * Cross-service smoke without a real LLM key.
 *
 * Starts:
 *   1. Deterministic fake OpenAI-compatible provider
 *   2. Sandbox (uvicorn) on a free port, backed by MySQL
 *   3. Agent pointing at fake LLM + Sandbox + MySQL + Redis
 *   4. Agent Worker (unless SMOKE_START_WORKER=false)
 *   5. BFF pointing at Agent + Sandbox
 *
 * Checks:
 *   - Sandbox /health + /ready
 *   - Agent /health
 *   - BFF /api/status (agent_runtime node-agent)
 *   - Conversation creation through BFF → Agent MySQL
 *   - Run creation, immediate GET, and durable event query
 *   - Optional end-to-end Worker execution with the fake provider
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
// The smoke process exercises the same service-token + acting-header contract
// as production BFF -> Sandbox public adapters.  Keep this deterministic,
// non-production value local to the hermetic test; it is never used by a
// deployed service.
const SMOKE_SANDBOX_API_TOKEN = 'smoke-sandbox-service-token-0123456789abcdef';
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

function requiredServiceUrl(name, candidates) {
  for (const candidate of candidates) {
    const value = String(process.env[candidate] || '').trim();
    if (value) return value;
  }
  throw new Error(
    `${name} is required; set ${candidates.join(' or ')} (the smoke test is MySQL/Redis-only)`,
  );
}

function envInt(name, fallback, { min = 0, max = 10_000 } = {}) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function envFlag(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || '').trim());
}

async function waitForTerminalRun(base, runId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
    if (response.ok) {
      last = await response.json();
      const status = String(last.status || '').toUpperCase();
      if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not reach a terminal state: ${JSON.stringify(last)}`);
}

async function createConversation(base, title) {
  const response = await fetch(`${base}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (response.status !== 201) {
    throw new Error(
      `conversation create failed: ${response.status} ${(await response.text()).slice(0, 400)}`,
    );
  }
  const body = await response.json();
  if (typeof body?.id !== 'string' || !body.id) {
    throw new Error(`conversation response missing id: ${JSON.stringify(body)}`);
  }
  return body;
}

async function createRun(base, conversationId, idempotencyKey, content) {
  const response = await fetch(
    `${base}/api/conversations/${encodeURIComponent(conversationId)}/runs`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ message: { content } }),
    },
  );
  if (response.status !== 202) {
    throw new Error(`run create failed: ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  const body = await response.json();
  const runId = body?.run_id || body?.runId;
  if (typeof runId !== 'string' || !runId) {
    throw new Error(`run response missing run id: ${JSON.stringify(body)}`);
  }
  return { ...body, runId };
}

function parseSseSequences(text) {
  const sequences = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const value = JSON.parse(raw);
      const sequence = Number(value?.sequence ?? value?.data?.sequence);
      if (Number.isSafeInteger(sequence) && sequence > 0) sequences.push(sequence);
    } catch {
      // A heartbeat/comment or a non-JSON upstream frame is not a sequence.
    }
  }
  return sequences;
}

async function consumeSseClient(base, runId, index, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { Accept: 'text/event-stream', 'X-Trace-Id': `${String(index + 1).padStart(32, '0')}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`SSE client ${index} received HTTP ${response.status}`);
    }
    const text = await response.text();
    const sequences = parseSseSequences(text);
    for (let i = 1; i < sequences.length; i += 1) {
      if (sequences[i] <= sequences[i - 1]) {
        throw new Error(`SSE client ${index} observed non-monotonic sequences`);
      }
    }
    if (sequences.length === 0) {
      throw new Error(`SSE client ${index} received no sequenced events`);
    }
    return { bytes: text.length, sequences };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSandboxMysqlUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('Sandbox MySQL URL must be non-empty');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Sandbox MySQL URL must be a valid mysql:// URL');
  }
  if (parsed.protocol === 'mysql2:') parsed.protocol = 'mysql:';
  if (parsed.protocol !== 'mysql:' && parsed.protocol !== 'mysql+pymysql:') {
    throw new Error(
      'Smoke requires a mysql:// or mysql+pymysql:// database URL; SQLite/PostgreSQL are not accepted',
    );
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new Error('Smoke MySQL URL must include host and database name');
  }
  parsed.protocol = 'mysql+pymysql:';
  return parsed.toString();
}

async function prepareDataPlane(mysqlUrl, redisUrl, replayRedisUrl) {
  const [{ createMysqlKnex, destroyMysqlKnex }, { migrateLatest }, redisMod] =
    await Promise.all([
      import('../agent/src/infrastructure/mysql/client.js'),
      import('../agent/src/infrastructure/mysql/migrate.js'),
      import('../agent/src/infrastructure/redis/client.js'),
    ]);

  const knex = createMysqlKnex(mysqlUrl);
  let redis;
  let replayRedis;
  try {
    await knex.raw('SELECT 1');
    await migrateLatest(knex);
    redis = redisMod.createRedisClient(redisUrl);
    await redis.ping();
    replayRedis = redisMod.createRedisClient(replayRedisUrl);
    await replayRedis.ping();
  } catch (error) {
    throw new Error(
      `formal data-plane preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (replayRedis) {
      await redisMod.destroyRedisClient(replayRedis).catch(() => {});
    }
    if (redis) await redisMod.destroyRedisClient(redis).catch(() => {});
    await destroyMysqlKnex(knex).catch(() => {});
  }
}

async function waitForExit(child, name) {
  const [code, signal] = await once(child, 'exit');
  if (code !== 0) {
    throw new Error(`${name} exited before smoke completed (code=${code}, signal=${signal})`);
  }
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

  const artifactGate = envFlag('SMOKE_ARTIFACT_GATE');
  const concurrentRuns = envInt('SMOKE_CONCURRENT_RUNS', 1, {
    min: 1,
    max: 200,
  });
  const sseClients = envInt('SMOKE_SSE_CLIENTS', 0, {
    min: 0,
    max: 500,
  });
  const providerDelayMs = envInt(
    'SMOKE_PROVIDER_DELAY_MS',
    sseClients > 0 ? 1_500 : 0,
    { min: 0, max: 30_000 },
  );
  let artifactDatasetPath = null;
  const fake = await startFakeOpenAIProvider({
    reply: 'cross-service-smoke-ok',
    responder: async ({ body }) => {
      if (providerDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
      }
      const messages = JSON.stringify(body?.messages || []);
      if (!artifactGate || !messages.includes('artifact-gate')) {
        return 'cross-service-smoke-ok';
      }
      if (!messages.includes('call_artifact_python_1')) {
        if (!artifactDatasetPath) {
          throw new Error('artifact gate provider invoked before Dataset upload');
        }
        const source = JSON.stringify(artifactDatasetPath);
        return {
          toolCalls: [
            {
              id: 'call_artifact_python_1',
              name: 'python',
              arguments: {
                code: [
                  'from pathlib import Path',
                  `source = Path(${source})`,
                  "target = Path('reports/artifact-gate-report.txt')",
                  'target.parent.mkdir(parents=True, exist_ok=True)',
                  "rows = [line for line in source.read_text(encoding='utf-8').splitlines() if line]",
                  "target.write_text(f'rows={max(0, len(rows) - 1)}\\nsource={source.name}\\n', encoding='utf-8')",
                  "print('artifact-gate-python-ok')",
                ].join('\n'),
                args: [],
                timeoutSeconds: 30,
              },
            },
          ],
        };
      }
      if (!messages.includes('call_artifact_submit_1')) {
        return {
          toolCalls: [
            {
              id: 'call_artifact_submit_1',
              name: 'submit_artifact',
              arguments: {
                path: 'reports/artifact-gate-report.txt',
                displayName: 'artifact-gate-report.txt',
                description: 'Cross-service Dataset processing release gate',
              },
            },
          ],
        };
      }
      return 'artifact-gate-complete';
    },
  });
  const agentMysqlUrl = requiredServiceUrl('Agent MySQL URL', [
    'SMOKE_MYSQL_URL',
    'AGENT_DATABASE_URL',
    'TEST_MYSQL_URL',
  ]);
  const sandboxMysqlUrl = normalizeSandboxMysqlUrl(
    process.env.SMOKE_SANDBOX_MYSQL_URL || agentMysqlUrl,
  );
  const redisUrl = requiredServiceUrl('Agent Redis URL', [
    'SMOKE_REDIS_URL',
    'AGENT_REDIS_URL',
    'TEST_REDIS_URL',
  ]);
  const replayRedisUrl = requiredServiceUrl('Sandbox replay Redis URL', [
    'SMOKE_SANDBOX_REPLAY_REDIS_URL',
  ]);
  await prepareDataPlane(agentMysqlUrl, redisUrl, replayRedisUrl);

  const internalHmacKeyring = JSON.stringify({
    'smoke-v1': 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
  });
  const internalHmacActiveKid = 'smoke-v1';

  const sandboxPort = await freePort();
  const agentPort = await freePort();
  const bffPort = await freePort();
  const startWorker = String(process.env.SMOKE_START_WORKER || 'true')
    .trim()
    .toLowerCase() !== 'false';

  const smokeDir = path.join(ROOT, '.smoke-tmp');
  const wsPath = path.join(smokeDir, `ws-${process.pid}`);
  const skillsPath = path.join(smokeDir, `skills-${process.pid}`);
  const agentDir = path.join(smokeDir, `agent-${process.pid}`);
  // The container image creates the logical /home/sandbox/workspace cwd. This
  // smoke runs the Worker directly on the host, so give Pi an equivalent
  // process-local cwd that is guaranteed to exist.
  const agentCwd = path.join(smokeDir, `agent-workspace-${process.pid}`);
  await import('node:fs/promises').then((fs) =>
    Promise.all([
      fs.mkdir(smokeDir, { recursive: true }),
      fs.mkdir(agentCwd, { recursive: true }),
    ]),
  );

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
      DEPLOYMENT_ENV: 'development',
      SANDBOX_DATABASE_URL: sandboxMysqlUrl,
      SANDBOX_WORKSPACES_ROOT: wsPath,
      SANDBOX_TEMP_ROOT: path.join(smokeDir, `tmp-${process.pid}`),
      SANDBOX_ATTACHMENTS_ROOT: wsPath,
      SANDBOX_SKILLS_ROOT: skillsPath,
      SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN,
      SANDBOX_AUTH_ENABLED: 'true',
      SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER: 'false',
      SANDBOX_INTERNAL_PLANE_ENABLED: 'true',
      SANDBOX_INTERNAL_REDIS_URL: replayRedisUrl,
      SANDBOX_INTERNAL_HMAC_KEYRING: internalHmacKeyring,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: internalHmacActiveKid,
      AGENT_REDIS_URL: '',
      REDIS_URL: '',
      REDIS_PASSWORD: '',
      SANDBOX_NETWORK_MODE: 'disabled',
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
      SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN,
      AGENT_INTERNAL_TOKEN: '',
      AGENT_DATABASE_URL: agentMysqlUrl,
      AGENT_REDIS_URL: redisUrl,
      AGENT_MIGRATE_ON_START: 'false',
      AGENT_PI_AGENT_DIR: agentDir,
      AGENT_PI_DEFAULT_CWD: agentCwd,
      AGENT_SESSION_WORKSPACE_CWD: agentCwd,
      SANDBOX_INTERNAL_HMAC_KEYRING: internalHmacKeyring,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: internalHmacActiveKid,
      LLMIO_BASE_URL: fake.baseUrl,
      LLMIO_API_KEY: 'fake-test-key',
      MODEL_ID: 'fake-model',
      SKILLS_MODE: 'readonly',
    },
    'agent',
    path.join(ROOT, 'agent'),
  );

  await waitHttp(`http://127.0.0.1:${agentPort}/health`);
  await waitHttp(`http://127.0.0.1:${agentPort}/ready`);

  if (startWorker) {
    spawnProc(
      process.execPath,
      ['worker.js'],
      {
        NODE_ENV: 'test',
        DEPLOYMENT_ENV: 'development',
        AGENT_DATABASE_URL: agentMysqlUrl,
        AGENT_REDIS_URL: redisUrl,
        AGENT_MIGRATE_ON_START: 'false',
        AGENT_PI_AGENT_DIR: agentDir,
        AGENT_PI_DEFAULT_CWD: agentCwd,
        AGENT_SESSION_WORKSPACE_CWD: agentCwd,
        SANDBOX_BASE_URL: `http://127.0.0.1:${sandboxPort}`,
        SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN,
        SANDBOX_AUTH_ENABLED: 'false',
        SANDBOX_INTERNAL_HMAC_KEYRING: internalHmacKeyring,
        SANDBOX_INTERNAL_HMAC_ACTIVE_KID: internalHmacActiveKid,
        LLMIO_BASE_URL: fake.baseUrl,
        LLMIO_API_KEY: 'fake-test-key',
        MODEL_ID: 'deepseek-v4-flash',
        SKILLS_MODE: 'readonly',
        AGENT_WORKER_CONCURRENCY: String(Math.min(20, Math.max(1, concurrentRuns))),
        AGENT_RECOVERY_INTERVAL_MS: '1000',
        AGENT_OUTBOX_IDLE_MS: '100',
      },
      'agent-worker',
      path.join(ROOT, 'agent'),
    );
  }

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
      SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN,
      BFF_DEV_ACTING_USER_ID: `smoke-user-${process.pid}`,
      BFF_DEV_ACTING_ORGANIZATION_ID: `smoke-org-${process.pid}`,
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

  const base = `http://127.0.0.1:${bffPort}`;
  if (!startWorker && (artifactGate || concurrentRuns > 1 || sseClients > 0)) {
    throw new Error('artifact/load/SSE gates require SMOKE_START_WORKER=true');
  }

  const conversation = await createConversation(base, 'cross-service smoke');
  const conversationId = conversation.id;

  // Dataset upload is deliberately performed before the Run. This proves the
  // active AgentSession/SandboxSession binding exists independently of a chat
  // request and lets the scripted model consume the uploaded logical path.
  let sessionId = null;
  let dataset = null;
  if (artifactGate) {
    const sessionRes = await fetch(`${base}/api/sessions/ensure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    if (!sessionRes.ok) {
      throw new Error(`session ensure failed: ${sessionRes.status} ${(await sessionRes.text()).slice(0, 500)}`);
    }
    const sessionBody = await sessionRes.json();
    sessionId = sessionBody?.session_id || sessionBody?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`session ensure response missing session id: ${JSON.stringify(sessionBody)}`);
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob(['name,value\nalpha,1\nbeta,2\n'], { type: 'text/csv' }),
      'artifact-gate-input.csv',
    );
    const uploadKey = `cross-service-dataset-${process.pid}`;
    const uploadRes = await fetch(
      `${base}/api/conversations/${encodeURIComponent(conversationId)}/datasets?session_id=${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': uploadKey },
        body: form,
      },
    );
    if (uploadRes.status !== 201) {
      throw new Error(`dataset upload failed: ${uploadRes.status} ${(await uploadRes.text()).slice(0, 700)}`);
    }
    dataset = await uploadRes.json();
    artifactDatasetPath =
      dataset?.stored_relative_path || dataset?.storedRelativePath || dataset?.path;
    if (typeof artifactDatasetPath !== 'string' || !artifactDatasetPath) {
      throw new Error(`dataset response missing logical path: ${JSON.stringify(dataset)}`);
    }
    // Retry the same durable key and require a byte-identical logical record.
    const retryForm = new FormData();
    retryForm.append(
      'file',
      new Blob(['name,value\nalpha,1\nbeta,2\n'], { type: 'text/csv' }),
      'artifact-gate-input.csv',
    );
    const retryRes = await fetch(
      `${base}/api/conversations/${encodeURIComponent(conversationId)}/datasets?session_id=${encodeURIComponent(sessionId)}`,
      { method: 'POST', headers: { 'Idempotency-Key': uploadKey }, body: retryForm },
    );
    if (retryRes.status !== 201) {
      throw new Error(`dataset idempotency replay failed: ${retryRes.status} ${(await retryRes.text()).slice(0, 500)}`);
    }
    const retryDataset = await retryRes.json();
    const datasetId = dataset?.dataset_id || dataset?.datasetId;
    const retryId = retryDataset?.dataset_id || retryDataset?.datasetId;
    if (!datasetId || datasetId !== retryId) {
      throw new Error(`dataset idempotency returned different rows: ${datasetId} != ${retryId}`);
    }
  }

  const accepted = await createRun(
    base,
    conversationId,
    `cross-service-smoke-${process.pid}`,
    artifactGate
      ? 'artifact-gate: read the Dataset, run Python, submit the report artifact, then reply.'
      : 'reply with exactly: cross-service-smoke-ok',
  );
  const runId = accepted.runId;
  const immediate = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`);
  if (immediate.status !== 200) {
    throw new Error(`immediate run GET failed: ${immediate.status} ${(await immediate.text()).slice(0, 500)}`);
  }

  // Start all SSE clients before waiting for the worker. A provider delay is
  // applied in load mode so these are live concurrent subscriptions rather
  // than 100 sequential reads of an already-closed response.
  const ssePromise = sseClients > 0
    ? Promise.all(
        Array.from({ length: sseClients }, (_, index) =>
          consumeSseClient(base, runId, index),
        ),
      )
    : null;

  const extraRuns = [];
  if (concurrentRuns > 1) {
    const extraConversations = await Promise.all(
      Array.from({ length: concurrentRuns - 1 }, (_, index) =>
        createConversation(base, `cross-service load ${index + 2}`),
      ),
    );
    const extraAccepted = await Promise.all(
      extraConversations.map((item, index) =>
        createRun(
          base,
          item.id,
          `cross-service-load-${process.pid}-${index}`,
          `load-run-${index}`,
        ),
      ),
    );
    extraRuns.push(...extraAccepted);
  }

  const allAccepted = [accepted, ...extraRuns];
  const terminals = startWorker
    ? await Promise.all(allAccepted.map((item) => waitForTerminalRun(base, item.runId)))
    : [];
  for (const terminal of terminals) {
    if (String(terminal.status).toUpperCase() !== 'SUCCEEDED') {
      throw new Error(`worker Run ended ${terminal.status}: ${JSON.stringify(terminal)}`);
    }
  }
  if (ssePromise) {
    const sseResults = await ssePromise;
    const totalEvents = sseResults.reduce((sum, item) => sum + item.sequences.length, 0);
    if (sseResults.some((item) => item.sequences.length < 2)) {
      throw new Error('100-client SSE gate did not receive at least two sequenced frames per client');
    }
    console.log('[smoke] concurrent SSE gate ok', {
      clients: sseResults.length,
      totalEvents,
      maxBytes: Math.max(...sseResults.map((item) => item.bytes)),
    });
  }

  if (fake.requests.filter((request) => request.path.endsWith('/chat/completions')).length < allAccepted.length) {
    throw new Error('worker completed without contacting fake OpenAI provider for every Run');
  }

  if (artifactGate) {
    const datasetsRes = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/datasets?session_id=${encodeURIComponent(sessionId)}`);
    if (!datasetsRes.ok) throw new Error(`dataset refresh failed: ${datasetsRes.status}`);
    const datasetsBody = await datasetsRes.json();
    if (!Array.isArray(datasetsBody?.datasets) || datasetsBody.datasets.length !== 1) {
      throw new Error(`dataset refresh returned unexpected rows: ${JSON.stringify(datasetsBody)}`);
    }
    const artifactsRes = await fetch(`${base}/api/artifacts?session_id=${encodeURIComponent(sessionId)}`);
    if (!artifactsRes.ok) throw new Error(`artifact list failed: ${artifactsRes.status}`);
    const artifactsBody = await artifactsRes.json();
    const artifacts = Array.isArray(artifactsBody?.artifacts) ? artifactsBody.artifacts : [];
    if (artifacts.length !== 1) {
      throw new Error(`expected one explicit artifact, got ${JSON.stringify(artifactsBody)}`);
    }
    const artifactId = artifacts[0]?.artifact_id || artifacts[0]?.artifactId;
    if (!artifactId) throw new Error(`artifact id missing: ${JSON.stringify(artifacts[0])}`);
    const downloadRes = await fetch(
      `${base}/api/files/artifact-download?session_id=${encodeURIComponent(sessionId)}&artifact_id=${encodeURIComponent(artifactId)}`,
    );
    if (!downloadRes.ok) {
      throw new Error(`artifact download failed: ${downloadRes.status} ${(await downloadRes.text()).slice(0, 500)}`);
    }
    const downloaded = await downloadRes.text();
    if (!downloaded.includes('rows=2') || !downloaded.includes('artifact-gate-input.csv')) {
      throw new Error(`artifact bytes did not contain the Dataset-derived report: ${downloaded.slice(0, 500)}`);
    }
    console.log('[smoke] Dataset → Python → submit_artifact → refresh/download ok', {
      datasetId: dataset?.dataset_id || dataset?.datasetId,
      artifactId,
      bytes: downloaded.length,
    });
  }

  const eventsRes = await fetch(`${base}/api/conversations/${encodeURIComponent(conversationId)}/events`);
  if (eventsRes.status !== 200) {
    throw new Error(`durable event query failed: ${eventsRes.status} ${(await eventsRes.text()).slice(0, 500)}`);
  }
  console.log('[smoke] Conversation → Run → durable GET/events ok', {
    conversationId,
    runId,
    concurrentRuns,
    worker: startWorker,
  });

  await fake.close();
  await shutdown();
  console.log('[smoke] PASS cross-service without real LLM key');
}

main().catch(async (err) => {
  console.error('[smoke] FAIL', err);
  await shutdown();
  process.exit(1);
});
