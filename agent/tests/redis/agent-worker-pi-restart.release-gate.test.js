/**
 * Destructive real-Pi restart gate.
 *
 * This gate is intentionally opt-in. It uses the production Worker composition
 * (no injected RunExecutor), a real Pi runtime talking to the guarded fake
 * OpenAI-compatible provider, and the formal Sandbox HTTP transports. The
 * caller must provide isolated MySQL/Redis/Sandbox resources.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createMysqlKnex,
  destroyMysqlKnex,
} from '../../src/infrastructure/mysql/client.js';
import {
  migrateLatest,
  migrateRollbackAll,
} from '../../src/infrastructure/mysql/migrate.js';
import { OrganizationRepository } from '../../src/infrastructure/mysql/repositories/organization-repository.js';
import { ConversationRepository } from '../../src/infrastructure/mysql/repositories/conversation-repository.js';
import { AgentSessionRepository } from '../../src/infrastructure/mysql/repositories/agent-session-repository.js';
import { MessageRepository } from '../../src/infrastructure/mysql/repositories/message-repository.js';
import { RunRepository } from '../../src/infrastructure/mysql/repositories/run-repository.js';
import { ExternalReferenceRepository } from '../../src/infrastructure/mysql/repositories/external-reference-repository.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { TransactionManager } from '../../src/infrastructure/mysql/transaction-manager.js';
import { InteractionResponseService } from '../../src/application/interaction-response-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { enqueueRunJob, createRunQueue, destroyRunQueue } from '../../src/infrastructure/redis/run-queue.js';
import { runLeaseKey } from '../../src/infrastructure/redis/constants.js';
import { startFakeOpenAIProvider } from '../../testing/fake-openai-provider.js';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(
  new URL('../fixtures/agent-worker-pi-process.js', import.meta.url),
);

const TEST_MYSQL_URL = String(process.env.TEST_MYSQL_URL || '').trim();
const TEST_SANDBOX_MYSQL_URL = String(
  process.env.TEST_SANDBOX_MYSQL_URL || TEST_MYSQL_URL,
).trim();
const TEST_REDIS_URL = String(process.env.TEST_REDIS_URL || '').trim();
const TEST_REDIS_CONTAINER = String(
  process.env.TEST_REDIS_CONTAINER || '',
).trim();
const TEST_SANDBOX_URL = String(process.env.TEST_SANDBOX_URL || '').trim();
const TEST_SANDBOX_CONTAINER = String(
  process.env.TEST_SANDBOX_CONTAINER || '',
).trim();
const TEST_SANDBOX_TOKEN = String(
  process.env.TEST_SANDBOX_API_TOKEN || process.env.SANDBOX_API_TOKEN || '',
).trim();
const TEST_HMAC_KEYRING = String(
  process.env.TEST_SANDBOX_INTERNAL_HMAC_KEYRING ||
    process.env.SANDBOX_INTERNAL_HMAC_KEYRING ||
    '',
).trim();
const TEST_HMAC_ACTIVE_KID = String(
  process.env.TEST_SANDBOX_INTERNAL_HMAC_ACTIVE_KID ||
    process.env.SANDBOX_INTERNAL_HMAC_ACTIVE_KID ||
    '',
).trim();
const explicitlyEnabled = process.env.RUN_AGENT_PI_RESTART_GATE === '1';
const safeContainer = /^pi-(?:release-gate|refactor-gate)-redis-[a-z0-9-]+$/.test(
  TEST_REDIS_CONTAINER,
);
const safeSandboxContainer =
  /^pi-(?:release-gate|refactor-gate)-sandbox-[a-z0-9-]+$/.test(
    TEST_SANDBOX_CONTAINER,
  );

function databaseNameFromUrl(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

const safeDatabase = /^pi_gate_[a-z0-9_]+$/.test(
  databaseNameFromUrl(TEST_MYSQL_URL),
);
const safeSandboxDatabase = /^pi_gate_[a-z0-9_]+$/.test(
  databaseNameFromUrl(TEST_SANDBOX_MYSQL_URL),
);
const sharedGateDatabase =
  databaseNameFromUrl(TEST_SANDBOX_MYSQL_URL) ===
  databaseNameFromUrl(TEST_MYSQL_URL);
const runLive =
  explicitlyEnabled &&
  safeContainer &&
  safeSandboxContainer &&
  safeDatabase &&
  safeSandboxDatabase &&
  sharedGateDatabase &&
  Boolean(TEST_MYSQL_URL) &&
  Boolean(TEST_REDIS_URL) &&
  Boolean(TEST_SANDBOX_URL) &&
  Boolean(TEST_SANDBOX_MYSQL_URL) &&
  Boolean(TEST_HMAC_KEYRING) &&
  Boolean(TEST_HMAC_ACTIVE_KID) &&
  Boolean(TEST_SANDBOX_TOKEN);
const describeLive = runLive ? describe : describe.skip;

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const QUEUE = 'release-gate-agent-pi-restart';
const TRACE_MODEL = '11111111111111111111111111111111';
const TRACE_TOOL = '22222222222222222222222222222222';
const TRACE_SANDBOX = '33333333333333333333333333333333';
const TRACE_INTERACTION = '44444444444444444444444444444444';
const EXTERNAL_ORG = 'real-pi-restart-gate-org';
const EXTERNAL_USER = 'real-pi-restart-gate-user';

const MODEL_IDS = Object.freeze({
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN71',
  sessionId: '01K0G2PAV8FPMVC9QHJG7JPN72',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN73',
  messageId: '01K0G2PAV8FPMVC9QHJG7JPN77',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN75',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN76',
});
const TOOL_IDS = Object.freeze({
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN81',
  sessionId: '01K0G2PAV8FPMVC9QHJG7JPN82',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN83',
  messageId: '01K0G2PAV8FPMVC9QHJG7JPN87',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN85',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN86',
});
const SANDBOX_IDS = Object.freeze({
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN91',
  sessionId: '01K0G2PAV8FPMVC9QHJG7JPN92',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN93',
  messageId: '01K0G2PAV8FPMVC9QHJG7JPN97',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN95',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN96',
});
const INTERACTION_IDS = Object.freeze({
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPNA1',
  sessionId: '01K0G2PAV8FPMVC9QHJG7JPNA2',
  runId: '01K0G2PAV8FPMVC9QHJG7JPNA3',
  messageId: '01K0G2PAV8FPMVC9QHJG7JPNA7',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPNA5',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPNA6',
});

const modelConfig = (baseUrl) => ({
  model: {
    id: 'fake-model',
    name: 'Release gate fake model',
    api: 'openai-completions',
    provider: 'openai',
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  },
  systemPrompt: '',
});

async function docker(...args) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 120_000,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForPromise(promise, message, timeoutMs = 20_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createWorkerHarness(workerLabel, ids) {
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'test',
      TEST_EXPECT_REAL_PI: '1',
      TEST_RUN_IDS: ids.runId,
      TEST_WORKER_LABEL: workerLabel,
      TEST_EMIT_RECOVERY_SCANS: 'true',
      AGENT_DATABASE_URL: TEST_MYSQL_URL,
      AGENT_REDIS_URL: TEST_REDIS_URL,
      AGENT_RUNS_QUEUE_NAME: QUEUE,
      AGENT_MIGRATE_ON_START: 'false',
      AGENT_WORKER_CONCURRENCY: '1',
      AGENT_RECOVERY_SCAN_LIMIT: '20',
      AGENT_RECOVERY_INTERVAL_MS: '200',
      AGENT_OUTBOX_IDLE_MS: '50',
      AGENT_RUN_LEASE_TTL_MS: '6000',
      AGENT_RUN_LEASE_RENEW_INTERVAL_MS: '1000',
      AGENT_SESSION_LOCK_TTL_MS: '6000',
      AGENT_SESSION_LOCK_RENEW_INTERVAL_MS: '1000',
      AGENT_BULLMQ_LOCK_DURATION_MS: '8000',
      AGENT_BULLMQ_STALLED_INTERVAL_MS: '500',
      AGENT_BULLMQ_MAX_STALLED_COUNT: '2',
      AGENT_PI_AGENT_DIR: path.join(tempRoot, `pi-${workerLabel}`),
      AGENT_PI_DEFAULT_CWD: path.join(tempRoot, `cwd-${ids.sessionId}`),
      AGENT_SESSION_WORKSPACE_CWD: path.join(tempRoot, `cwd-${ids.sessionId}`),
      SANDBOX_BASE_URL: currentSandboxBaseUrl,
      SANDBOX_API_TOKEN: TEST_SANDBOX_TOKEN,
      SANDBOX_INTERNAL_HMAC_KEYRING: TEST_HMAC_KEYRING,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_HMAC_ACTIVE_KID,
      LLMIO_BASE_URL: fakeProvider.baseUrl,
      LLMIO_API_KEY: 'release-gate-fake-key',
      SKILLS_MODE: 'readonly',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = new Set();
  let buffer = '';
  let stderr = '';
  let exitResult = null;

  const dispatch = (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        dispatch({ type: 'worker-log', line: line.slice(0, 1024) });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  child.once('exit', (code, signal) => {
    exitResult = { code, signal };
    for (const waiter of [...waiters]) {
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.reject(
        new Error(
          `${workerLabel} exited before expected message code=${String(code)} signal=${String(signal)} stderr=${stderr}`,
        ),
      );
    }
  });

  return {
    child,
    messages,
    getStderr: () => stderr,
    waitFor(predicate, timeoutMs = 20_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (exitResult) {
        return Promise.reject(new Error(`${workerLabel} already exited`));
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `timed out waiting for ${workerLabel}; messages=${JSON.stringify(messages)} stderr=${stderr}`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async terminate(signal = 'SIGTERM', timeoutMs = 10_000) {
      if (exitResult) return exitResult;
      child.kill(signal);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${workerLabel} did not exit after ${signal}`)),
          timeoutMs,
        );
        child.once('exit', (code, sig) => {
          clearTimeout(timer);
          resolve({ code, signal: sig });
        });
      });
    },
  };
}

async function waitForRow(knex, table, where, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let row;
  while (Date.now() < deadline) {
    row = await knex(table).where(where).first();
    if (predicate(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${table}: ${JSON.stringify(row)}`);
}

async function seedRun(knex, ids, traceId, content, baseUrl) {
  const organizations = new OrganizationRepository(knex);
  const existingOrg = await knex('organizations').where({ org_id: ORG }).first();
  if (!existingOrg) {
    await organizations.createOrganization({
      orgId: ORG,
      name: 'real Pi restart gate',
      status: 'active',
    });
    await organizations.createUser({
      userId: USER,
      externalSubject: `bff:${EXTERNAL_USER}`,
      displayName: 'Release Gate',
      status: 'active',
    });
    await organizations.addMembership({
      orgId: ORG,
      userId: USER,
      role: 'member',
      status: 'active',
    });
    const externalRefs = new ExternalReferenceRepository(knex);
    await externalRefs.createOrganizationRef({
      provider: 'bff',
      externalSubject: EXTERNAL_ORG,
      orgId: ORG,
    });
    await knex('agent_definitions').insert({
      agent_id: AGENT,
      org_id: ORG,
      name: 'real-pi-release-gate',
      description: null,
      status: 'active',
      active_version_id: VER,
      created_by: USER,
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
    });
    await knex('agent_versions').insert({
      agent_version_id: VER,
      agent_id: AGENT,
      version_no: 1,
      config_json: JSON.stringify(modelConfig(baseUrl)),
      config_hash: 'c'.repeat(64),
      pi_sdk_version: '0.80.3',
      status: 'active',
      created_by: USER,
      created_at: knex.fn.now(3),
    });
  }
  const conversations = new ConversationRepository(knex);
  await conversations.create({
    conversationId: ids.conversationId,
    orgId: ORG,
    userId: USER,
    agentId: AGENT,
    title: 'real Pi restart gate',
    status: 'active',
  });
  const sessions = new AgentSessionRepository(knex);
  await sessions.create({
    agentSessionId: ids.sessionId,
    orgId: ORG,
    userId: USER,
    conversationId: ids.conversationId,
    agentVersionId: VER,
    sandboxSessionId: ids.sandboxSessionId,
    workspaceId: ids.workspaceId,
    status: 'ACTIVE',
  });
  await fs.mkdir(path.join(tempRoot, `cwd-${ids.sessionId}`), {
    recursive: true,
  });
  const messages = new MessageRepository(knex);
  await messages.append({
    messageId: ids.messageId,
    conversationId: ids.conversationId,
    orgId: ORG,
    userId: USER,
    agentSessionId: ids.sessionId,
    runId: ids.runId,
    role: 'user',
    messageType: 'text',
    contentJson: { text: content },
  });
  const runs = new RunRepository(knex);
  await runs.create({
    runId: ids.runId,
    orgId: ORG,
    userId: USER,
    conversationId: ids.conversationId,
    agentSessionId: ids.sessionId,
    agentVersionId: VER,
    triggeringMessageId: ids.messageId,
    source: 'release-gate',
    status: 'QUEUED',
    queueName: QUEUE,
    traceId,
  });
}

/** Small HTTP forwarder that can hold the first real Sandbox execution call. */
function startSandboxBarrierProxy(targetBaseUrl) {
  const held = [];
  const hit = deferred();
  let armed = true;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const target = new URL(req.url || '/', targetBaseUrl);
    if (
      armed &&
      req.method === 'POST' &&
      target.pathname.endsWith('/internal/v1/executions/bash')
    ) {
      armed = false;
      held.push({ path: target.pathname, body: body.toString('utf8') });
      hit.resolve(held[held.length - 1]);
      // Keep the socket open until the Worker is SIGKILLed. The held request
      // must never reach Sandbox, proving the durable proposal boundary.
      req.socket.on('close', () => {});
      return;
    }
    try {
      const headers = { ...req.headers };
      delete headers.host;
      const response = await fetch(target, {
        method: req.method,
        headers,
        body:
          req.method === 'GET' || req.method === 'HEAD' || body.length === 0
            ? undefined
            : body,
      });
      const responseBody = Buffer.from(await response.arrayBuffer());
      const outputHeaders = {};
      response.headers.forEach((value, key) => {
        outputHeaders[key] = value;
      });
      res.writeHead(response.status, outputHeaders);
      res.end(responseBody);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'BARRIER_FORWARD_FAILED',
            message: error instanceof Error ? error.message : 'forward failed',
          },
        }),
      );
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        held,
        hit: hit.promise,
        arm() {
          armed = true;
        },
        close() {
          server.closeAllConnections?.();
          return new Promise((resClose) => server.close(() => resClose()));
        },
      });
    });
  });
}

async function waitForHttp(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${url} -> ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error(`timed out waiting for ${url}`);
}

let tempRoot = '';
let fakeProvider = null;
let currentSandboxBaseUrl = TEST_SANDBOX_URL;
let agentKnex = null;
let sandboxKnex = null;
let queueHandles = null;
let sandboxProxy = null;
const workers = [];

describe('real Pi Agent/Sandbox restart release gate', () => {
  it('requires explicit opt-in and isolated resources', () => {
    if (!explicitlyEnabled) {
      assert.ok(true, 'skipped: RUN_AGENT_PI_RESTART_GATE is not 1');
      return;
    }
    assert.ok(safeContainer, 'TEST_REDIS_CONTAINER is not an isolated gate container');
    assert.ok(safeSandboxContainer, 'TEST_SANDBOX_CONTAINER is not an isolated gate container');
    assert.ok(safeDatabase, 'TEST_MYSQL_URL must use a pi_gate_* schema');
    assert.ok(safeSandboxDatabase, 'TEST_SANDBOX_MYSQL_URL must use a pi_gate_* schema');
    assert.ok(
      sharedGateDatabase,
      'Agent and Sandbox must use the same gate schema; Sandbox validates Agent-owned parent rows',
    );
    assert.ok(TEST_SANDBOX_URL, 'TEST_SANDBOX_URL is required');
    assert.ok(TEST_HMAC_KEYRING && TEST_HMAC_ACTIVE_KID, 'Sandbox HMAC keyring is required');
  });
});

describeLive(
  'real Pi model/tool/Sandbox interruption behavior',
  { concurrency: false },
  () => {
  before(async () => {
    const inspected = await docker(
      'inspect',
      '--format',
      '{{.Name}}|{{.State.Running}}',
      TEST_REDIS_CONTAINER,
    );
    assert.equal(inspected.stdout.trim(), `/${TEST_REDIS_CONTAINER}|true`);
    const sandboxInspected = await docker(
      'inspect',
      '--format',
      '{{.Name}}|{{.State.Running}}',
      TEST_SANDBOX_CONTAINER,
    );
    assert.equal(sandboxInspected.stdout.trim(), `/${TEST_SANDBOX_CONTAINER}|true`);
    await waitForHttp(`${TEST_SANDBOX_URL}/health`);
    await waitForHttp(`${TEST_SANDBOX_URL}/ready`);

    tempRoot = mkdtempSync(path.join(os.tmpdir(), 'pi-real-restart-gate-'));
    await fs.mkdir(tempRoot, { recursive: true });
    fakeProvider = await startFakeOpenAIProvider({ reply: 'unused' });
    agentKnex = createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 10 } });
    sandboxKnex = createMysqlKnex(TEST_SANDBOX_MYSQL_URL, {
      pool: { min: 0, max: 10 },
    });
    await agentKnex.raw('SELECT 1');
    await sandboxKnex.raw('SELECT 1');
    await migrateRollbackAll(agentKnex);
    await migrateLatest(agentKnex);
    queueHandles = createRunQueue(TEST_REDIS_URL, { queueName: QUEUE });
    await queueHandles.queue.waitUntilReady();
    await queueHandles.queue.obliterate({ force: true });
  });

  after(async () => {
    const errors = [];
    for (const worker of workers.splice(0).reverse()) {
      await worker.terminate('SIGKILL').catch((error) => errors.push(error));
    }
    if (sandboxProxy) {
      await sandboxProxy.close().catch((error) => errors.push(error));
      sandboxProxy = null;
    }
    if (queueHandles) {
      await queueHandles.queue.obliterate({ force: true }).catch((error) => errors.push(error));
      await destroyRunQueue(queueHandles).catch((error) => errors.push(error));
      queueHandles = null;
    }
    if (agentKnex) {
      await migrateRollbackAll(agentKnex).catch((error) => errors.push(error));
      await destroyMysqlKnex(agentKnex).catch((error) => errors.push(error));
      agentKnex = null;
    }
    if (sandboxKnex) {
      await destroyMysqlKnex(sandboxKnex).catch((error) => errors.push(error));
      sandboxKnex = null;
    }
    if (fakeProvider) {
      await fakeProvider.close().catch((error) => errors.push(error));
      fakeProvider = null;
    }
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'real Pi gate cleanup failed');
  });

  afterEach(async () => {
    const errors = [];
    for (const worker of workers.splice(0).reverse()) {
      await worker.terminate('SIGKILL').catch((error) => errors.push(error));
    }
    if (sandboxProxy) {
      await sandboxProxy.close().catch((error) => errors.push(error));
      sandboxProxy = null;
    }
    currentSandboxBaseUrl = TEST_SANDBOX_URL;
    if (queueHandles) {
      await queueHandles.queue
        .obliterate({ force: true })
        .catch((error) => errors.push(error));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, 'real Pi gate test cleanup failed');
    }
  });

  it('replays a real Pi model call after Worker SIGKILL with no side-effect ledger', async () => {
    const entered = deferred();
    const releaseInterruptedRequest = deferred();
    let attempts = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = JSON.stringify(body?.messages || []);
      if (!text.includes('MODEL_RESTART_GATE')) return 'unused';
      attempts += 1;
      if (attempts === 1) {
        entered.resolve();
        return releaseInterruptedRequest.promise;
      }
      return 'MODEL_RESTART_RECOVERED';
    });
    currentSandboxBaseUrl = TEST_SANDBOX_URL;
    await seedRun(
      agentKnex,
      MODEL_IDS,
      TRACE_MODEL,
      'MODEL_RESTART_GATE: reply after the model call.',
      fakeProvider.baseUrl,
    );
    const workerA = createWorkerHarness('model-worker-a', MODEL_IDS);
    workers.push(workerA);
    await workerA.waitFor((message) => message.type === 'ready');
    await enqueueRunJob(queueHandles.queue, {
      runId: MODEL_IDS.runId,
      orgId: ORG,
      traceId: TRACE_MODEL,
    });
    await workerA.waitFor(
      (message) =>
        message.type === 'active' && message.jobId === MODEL_IDS.runId,
    );
    const firstBoundary = await Promise.race([
      waitForPromise(
        entered.promise,
        'fake model provider did not observe the interrupted request',
      ).then(() => ({ type: 'model-entered' })),
      workerA
        .waitFor(
          (message) =>
            ['completed', 'failed', 'fatal'].includes(message.type) &&
            (message.jobId == null || message.jobId === MODEL_IDS.runId),
        )
        .then((message) => ({ type: 'worker-terminal', message })),
    ]);
    assert.equal(
      firstBoundary.type,
      'model-entered',
      `Worker reached a terminal state before model dispatch: ${JSON.stringify(firstBoundary)} stderr=${workerA.getStderr()}`,
    );
    await waitForRow(
      agentKnex,
      'runs',
      { run_id: MODEL_IDS.runId },
      (row) => row?.status === 'RUNNING',
    );
    assert.ok(await queueHandles.connection.get(runLeaseKey(MODEL_IDS.runId)));
    const killed = await workerA.terminate('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');
    releaseInterruptedRequest.resolve('MODEL_RESTART_INTERRUPTED');

    const workerB = createWorkerHarness('model-worker-b', MODEL_IDS);
    workers.push(workerB);
    const recovery = await workerB.waitFor(
      (message) =>
        message.type === 'recovery-scan' &&
        message.runId === MODEL_IDS.runId &&
        (message.action === 'projected_and_enqueued' || message.action === 'enqueued'),
      15_000,
    );
    assert.match(String(recovery.reason || recovery.action), /replay|enqueued|lease-free/i);
    const completed = await workerB.waitFor(
      (message) => message.type === 'completed' && message.jobId === MODEL_IDS.runId,
      20_000,
    );
    assert.equal(completed.result.status, 'SUCCEEDED');
    assert.equal(attempts, 2, 'recovery must make exactly one new model request');
    const retryEvents = await agentKnex('run_events').where({
      run_id: MODEL_IDS.runId,
      event_type: 'run.retrying',
    });
    assert.equal(retryEvents.length, 1);
    const toolRows = await agentKnex('tool_executions').where({ run_id: MODEL_IDS.runId });
    assert.equal(toolRows.length, 0, 'model-only interruption must have no tool ledger');
    await workerB.terminate('SIGTERM');
  });

  it('continues one durable interaction after Worker restart and checkpoints the answer', async () => {
    const toolCallId = 'call-real-pi-interaction-restart-gate';
    let providerCalls = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = JSON.stringify(body?.messages || []);
      if (!text.includes('INTERACTION_RESTART_GATE')) return 'unused';
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          toolCalls: [
            {
              id: toolCallId,
              name: 'ask_user',
              arguments: {
                interaction_type: 'select',
                title: 'Choose the deployment region',
                message: 'Which region should the gate use?',
                options: ['eu', 'us'],
              },
            },
          ],
        };
      }
      return 'INTERACTION_RESTART_CONTINUED_EU';
    });

    currentSandboxBaseUrl = TEST_SANDBOX_URL;
    await seedRun(
      agentKnex,
      INTERACTION_IDS,
      TRACE_INTERACTION,
      'INTERACTION_RESTART_GATE: ask once for the region, then continue from the durable answer.',
      fakeProvider.baseUrl,
    );
    const workerA = createWorkerHarness('interaction-worker-a', INTERACTION_IDS);
    workers.push(workerA);
    await workerA.waitFor((message) => message.type === 'ready');
    await enqueueRunJob(queueHandles.queue, {
      runId: INTERACTION_IDS.runId,
      orgId: ORG,
      traceId: TRACE_INTERACTION,
    });

    const pending = await waitForRow(
      agentKnex,
      'run_interactions',
      { run_id: INTERACTION_IDS.runId, tool_call_id: toolCallId },
      (row) => row?.status === 'PENDING' && row?.resume_phase === 'NONE',
      30_000,
    );
    const parked = await waitForRow(
      agentKnex,
      'runs',
      { run_id: INTERACTION_IDS.runId },
      (row) => row?.status === 'WAITING_INPUT',
      30_000,
    );
    assert.equal(parked.status, 'WAITING_INPUT');
    await waitForRow(
      agentKnex,
      'agent_sessions',
      { agent_session_id: INTERACTION_IDS.sessionId },
      (row) => Number(row?.pi_session_version || 0) > 0,
      30_000,
    );
    const parkedCompletion = await workerA.waitFor(
      (message) =>
        message.type === 'completed' && message.jobId === INTERACTION_IDS.runId,
      30_000,
    );
    assert.equal(parkedCompletion.result.status, 'WAITING_INPUT');
    assert.equal(providerCalls, 1, 'the first Worker must ask exactly once');
    assert.equal(
      (await agentKnex('run_interactions').where({ run_id: INTERACTION_IDS.runId })).length,
      1,
      'parking must create exactly one durable interaction',
    );
    assert.equal(
      (await agentKnex('tool_executions').where({ run_id: INTERACTION_IDS.runId })).length,
      1,
      'parking must create exactly one tool ledger row',
    );

    assert.equal(
      await queueHandles.connection.get(runLeaseKey(INTERACTION_IDS.runId)),
      null,
      'the parked Run must release its execution lease',
    );
    const stopped = await workerA.terminate('SIGKILL');
    assert.equal(stopped.signal, 'SIGKILL');

    const generateId = createUlidGenerator();
    const service = new InteractionResponseService({
      transactionManager: new TransactionManager(agentKnex),
      createRepositories: (db) => createRepositoryBundle(db, { generateId }),
      runQueue: {
        enqueue(ref, options) {
          return enqueueRunJob(queueHandles.queue, ref, options);
        },
      },
      generateId,
    });
    const rehydrated = await service.rehydrateWaiting({
      auth: {
        provider: 'bff',
        externalOrgId: EXTERNAL_ORG,
        externalUserId: EXTERNAL_USER,
      },
      runId: INTERACTION_IDS.runId,
    });
    assert.equal(rehydrated.count, 1);
    assert.equal(rehydrated.items[0].interaction_id, pending.interaction_id);
    assert.equal(rehydrated.items[0].resolved, false);
    assert.equal(rehydrated.items[0].queued, false);
    const answered = await service.respond({
      auth: {
        provider: 'bff',
        externalOrgId: EXTERNAL_ORG,
        externalUserId: EXTERNAL_USER,
      },
      runId: INTERACTION_IDS.runId,
      interactionId: String(pending.interaction_id),
      response: 'eu',
    });
    assert.equal(answered.changed, true);
    assert.equal(answered.queued, true);

    const workerB = createWorkerHarness('interaction-worker-b', INTERACTION_IDS);
    workers.push(workerB);
    await workerB.waitFor((message) => message.type === 'ready');
    const resumeJobId = `${INTERACTION_IDS.runId}-interaction-${pending.interaction_id}`;
    const completed = await workerB.waitFor(
      (message) =>
        message.type === 'completed' && message.jobId === resumeJobId,
      30_000,
    );
    assert.equal(completed.result.status, 'SUCCEEDED');
    const succeeded = await waitForRow(
      agentKnex,
      'runs',
      { run_id: INTERACTION_IDS.runId },
      (row) => row?.status === 'SUCCEEDED',
      30_000,
    );
    assert.equal(succeeded.status, 'SUCCEEDED');
    const applied = await waitForRow(
      agentKnex,
      'run_interactions',
      { interaction_id: pending.interaction_id },
      (row) => row?.status === 'RESOLVED' && row?.resume_phase === 'APPLIED',
      30_000,
    );
    assert.ok(applied.resume_claimed_at);
    assert.ok(applied.resume_applied_at);
    const session = await agentKnex('agent_sessions')
      .where({ agent_session_id: INTERACTION_IDS.sessionId })
      .first();
    assert.equal(session.last_run_id, INTERACTION_IDS.runId);
    assert.ok(Number(session.pi_session_version) >= 2);
    const latestSnapshot = await agentKnex('agent_session_snapshots')
      .where({ agent_session_id: INTERACTION_IDS.sessionId })
      .orderBy('snapshot_version', 'desc')
      .first();
    assert.ok(latestSnapshot);
    assert.match(
      typeof latestSnapshot.snapshot_json === 'string'
        ? latestSnapshot.snapshot_json
        : JSON.stringify(latestSnapshot.snapshot_json),
      /INTERACTION_RESTART_CONTINUED_EU|User response: eu/,
      'the APPLIED continuation must be present in the durable Pi checkpoint',
    );
    assert.equal(providerCalls, 2, 'continuation must make one and only one follow-up model call');
    assert.equal(
      (await agentKnex('run_interactions').where({ run_id: INTERACTION_IDS.runId })).length,
      1,
    );
    const tools = await agentKnex('tool_executions').where({ run_id: INTERACTION_IDS.runId });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'SUCCEEDED');
    assert.equal(
      (
        await agentKnex('run_events').where({
          run_id: INTERACTION_IDS.runId,
          event_type: 'interaction.resolved',
        })
      ).length,
      1,
    );
    await workerB.terminate('SIGTERM');
  });

  it('does not replay a real Pi tool after its durable dispatch boundary', async () => {
    const toolCallId = 'call-real-pi-tool-restart-gate';
    let providerCalls = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = JSON.stringify(body?.messages || []);
      if (!text.includes('TOOL_PROPOSAL_RESTART_GATE')) return 'unused';
      providerCalls += 1;
      return {
        toolCalls: [
          {
            id: toolCallId,
            name: 'bash',
            arguments: {
              command: 'printf TOOL_PROPOSAL_MUST_NOT_REACH_SANDBOX',
              timeoutSeconds: 30,
            },
          },
        ],
      };
    });

    sandboxProxy = await startSandboxBarrierProxy(TEST_SANDBOX_URL);
    currentSandboxBaseUrl = sandboxProxy.baseUrl;
    await seedRun(
      agentKnex,
      TOOL_IDS,
      TRACE_TOOL,
      'TOOL_PROPOSAL_RESTART_GATE: invoke bash exactly once.',
      fakeProvider.baseUrl,
    );
    const workerA = createWorkerHarness('tool-worker-a', TOOL_IDS);
    workers.push(workerA);
    await workerA.waitFor((message) => message.type === 'ready');
    await enqueueRunJob(queueHandles.queue, {
      runId: TOOL_IDS.runId,
      orgId: ORG,
      traceId: TRACE_TOOL,
    });
    const heldRequest = await waitForPromise(
      sandboxProxy.hit,
      'Sandbox barrier did not observe bash dispatch',
    );
    assert.match(heldRequest.path, /\/internal\/v1\/executions\/bash$/);
    const toolBeforeKill = await waitForRow(
      agentKnex,
      'tool_executions',
      { run_id: TOOL_IDS.runId, tool_call_id: toolCallId },
      (row) => row?.status === 'RUNNING',
    );
    assert.ok(toolBeforeKill.request_hash);
    assert.ok(Number(toolBeforeKill.execution_fence_token) > 0);
    assert.equal(
      await sandboxKnex('sandbox_executions')
        .where({ run_id: TOOL_IDS.runId })
        .first(),
      undefined,
      'the held dispatch must not reach Sandbox',
    );

    const killed = await workerA.terminate('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');
    currentSandboxBaseUrl = TEST_SANDBOX_URL;

    const workerB = createWorkerHarness('tool-worker-b', TOOL_IDS);
    workers.push(workerB);
    await workerB.waitFor((message) => message.type === 'ready');
    const reconciliation = await workerB.waitFor(
      (message) =>
        message.type === 'recovery-scan' &&
        message.runId === TOOL_IDS.runId &&
        message.action === 'needsReconciliation',
      15_000,
    );
    assert.match(String(reconciliation.reason), /manual recovery required/i);

    const run = await agentKnex('runs').where({ run_id: TOOL_IDS.runId }).first();
    assert.equal(run.status, 'RUNNING');
    const toolAfterRestart = await agentKnex('tool_executions')
      .where({ run_id: TOOL_IDS.runId, tool_call_id: toolCallId })
      .first();
    assert.equal(toolAfterRestart.status, 'RUNNING');
    assert.equal(providerCalls, 1, 'Worker B must not re-prompt the model');
    assert.equal(
      (
        await agentKnex('run_events').where({
          run_id: TOOL_IDS.runId,
          event_type: 'run.retrying',
        })
      ).length,
      0,
    );
    assert.equal(
      (
        await sandboxKnex('sandbox_executions').where({
          run_id: TOOL_IDS.runId,
        })
      ).length,
      0,
      'restart recovery must not create a Sandbox execution',
    );
    await workerB.terminate('SIGTERM');
    await sandboxProxy.close();
    sandboxProxy = null;
  });

  it(
    'marks an interrupted real Sandbox execution UNKNOWN and never retries it',
    { timeout: 120_000 },
    async () => {
      const toolCallId = 'call-real-sandbox-restart-gate';
      const secondModelEntered = deferred();
      const releaseSecondModel = deferred();
      let providerCalls = 0;
      fakeProvider.setResponder(async ({ body }) => {
        const text = JSON.stringify(body?.messages || []);
        if (!text.includes('SANDBOX_RESTART_GATE')) return 'unused';
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            toolCalls: [
              {
                id: toolCallId,
                name: 'bash',
                arguments: {
                  command: 'sleep 120',
                  timeoutSeconds: 120,
                },
              },
            ],
          };
        }
        secondModelEntered.resolve();
        return releaseSecondModel.promise;
      });

      currentSandboxBaseUrl = TEST_SANDBOX_URL;
      await seedRun(
        agentKnex,
        SANDBOX_IDS,
        TRACE_SANDBOX,
        'SANDBOX_RESTART_GATE: run the requested bash command exactly once.',
        fakeProvider.baseUrl,
      );
      const workerA = createWorkerHarness('sandbox-worker-a', SANDBOX_IDS);
      workers.push(workerA);
      await workerA.waitFor((message) => message.type === 'ready');
      await enqueueRunJob(queueHandles.queue, {
        runId: SANDBOX_IDS.runId,
        orgId: ORG,
        traceId: TRACE_SANDBOX,
      });

      await waitForRow(
        agentKnex,
        'tool_executions',
        { run_id: SANDBOX_IDS.runId, tool_call_id: toolCallId },
        (row) => row?.status === 'RUNNING',
      );
      const sandboxRunning = await waitForRow(
        sandboxKnex,
        'sandbox_executions',
        { run_id: SANDBOX_IDS.runId, tool_call_id: toolCallId },
        (row) => row?.status === 'RUNNING',
      );
      assert.ok(sandboxRunning.execution_id);

      // The service needs its configured drain window to persist RUNNING ->
      // UNKNOWN before Docker terminates the old container process.
      await docker('restart', '--time', '45', TEST_SANDBOX_CONTAINER);
      await waitForHttp(`${TEST_SANDBOX_URL}/health`);
      await waitForHttp(`${TEST_SANDBOX_URL}/ready`);

      const sandboxUnknown = await waitForRow(
        sandboxKnex,
        'sandbox_executions',
        { execution_id: sandboxRunning.execution_id },
        (row) => row?.status === 'UNKNOWN',
        60_000,
      );
      // Graceful drain uses SHUTDOWN_DRAIN_TIMEOUT; hard Docker/OrbStack
      // restarts may surface CRASH_RECOVERY_UNKNOWN. Both are honest UNKNOWN
      // with no automatic replay (STATUS G2 / sandbox interruption cell).
      assert.ok(
        ['SHUTDOWN_DRAIN_TIMEOUT', 'CRASH_RECOVERY_UNKNOWN'].includes(
          String(sandboxUnknown.error_code || ''),
        ),
        `expected honest UNKNOWN error_code, got ${sandboxUnknown.error_code}`,
      );
      const agentUnknown = await waitForRow(
        agentKnex,
        'tool_executions',
        { run_id: SANDBOX_IDS.runId, tool_call_id: toolCallId },
        (row) => row?.status === 'UNKNOWN',
        60_000,
      );
      assert.equal(agentUnknown.error_code, 'TOOL_OUTCOME_UNKNOWN');
      await waitForPromise(
        secondModelEntered.promise,
        'Pi did not continue after UNKNOWN tool result',
      );

      const killed = await workerA.terminate('SIGKILL');
      assert.equal(killed.signal, 'SIGKILL');
      releaseSecondModel.resolve('SANDBOX_RESTART_INTERRUPTED');

      const workerB = createWorkerHarness('sandbox-worker-b', SANDBOX_IDS);
      workers.push(workerB);
      await workerB.waitFor((message) => message.type === 'ready');
      const reconciliation = await workerB.waitFor(
        (message) =>
          message.type === 'recovery-scan' &&
          message.runId === SANDBOX_IDS.runId &&
          message.action === 'needsReconciliation',
        15_000,
      );
      assert.match(String(reconciliation.reason), /UNKNOWN.*manual recovery/i);

      assert.equal(
        (
          await sandboxKnex('sandbox_executions').where({
            run_id: SANDBOX_IDS.runId,
          })
        ).length,
        1,
        'no second Sandbox execution may be created',
      );
      assert.equal(providerCalls, 2, 'Worker B must not issue another model request');
      assert.equal(
        (
          await agentKnex('run_events').where({
            run_id: SANDBOX_IDS.runId,
            event_type: 'run.retrying',
          })
        ).length,
        0,
      );
      const run = await agentKnex('runs')
        .where({ run_id: SANDBOX_IDS.runId })
        .first();
      assert.equal(run.status, 'RUNNING');
      await workerB.terminate('SIGTERM');
    },
  );
  },
);
