/**
 * Destructive real-DSH restart gate.
 *
 * This gate is intentionally opt-in. It uses the production Worker composition
 * (no injected RunExecutor), the real DSH runtime talking to the guarded fake
 * OpenAI-compatible provider, and the signed internal Sandbox plane. The
 * caller must provide isolated MySQL/Redis/Sandbox resources; run it through
 * `scripts/dev/release-gate-dsh-restart.sh`, which applies the release DDL
 * before the dedicated Sandbox starts (the test never migrates or rolls back).
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
import { startFakeOpenAIProvider } from '../support/fake-openai-provider.js';
import { startDbpmForUrls, stripUrlPassword } from '../support/fake-dbpm-env.js';
import { ExecRpcClient } from '../../src/runtime/providers/exec-rpc.js';

const execFileAsync = promisify(execFile);
/** 被测 Worker 与生产一样经 DBPM 取密；before() 里起本机假 DBPM。 */
let dbpm = null;
const FIXTURE = fileURLToPath(
  new URL('../fixtures/agent-worker-dsh-process.js', import.meta.url),
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

/**
 * 只把 Agent 轮次的请求算进计数。DSH 每轮还会发一次不带工具的「生成会话标题」
 * 请求（system 为 `Create a concise title …`），它不属于被中断 / 重放的那次模型调用。
 */
function agentTurnText(body) {
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return '';
  return JSON.stringify(body?.messages || []);
}

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
  // The fixture imports TypeScript sources; a bare `node` child has no tsx loader.
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), FIXTURE], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'test',
      TEST_EXPECT_REAL_PI: '1',
      TEST_RUN_IDS: ids.runId,
      TEST_WORKER_LABEL: workerLabel,
      TEST_EMIT_RECOVERY_SCANS: 'true',
      AGENT_DATABASE_URL: stripUrlPassword(TEST_MYSQL_URL),
      AGENT_REDIS_URL: stripUrlPassword(TEST_REDIS_URL),
      ...dbpm.env,
      AGENT_RUNS_QUEUE_NAME: QUEUE,
      // 分层之后这是总预算（ADR 0012）：默认最大深度 2 需要至少 3 个槽。
      AGENT_WORKER_CONCURRENCY: '3',
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
      // 与 Compose 一致：DSH 把它作为逻辑工作区根发给 exec，宿主临时目录在沙箱里不存在。
      AGENT_SESSION_WORKSPACE_CWD: '/home/sandbox/workspace',
      MCP_SERVERS_JSON: '[]',
      SANDBOX_BASE_URL: currentSandboxBaseUrl,
      SANDBOX_API_TOKEN: TEST_SANDBOX_TOKEN,
      SANDBOX_INTERNAL_HMAC_KEYRING: TEST_HMAC_KEYRING,
      SANDBOX_INTERNAL_HMAC_ACTIVE_KID: TEST_HMAC_ACTIVE_KID,
      LLMIO_BASE_URL: fakeProvider.baseUrl,
      LLMIO_API_KEY: 'release-gate-fake-key',
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

/**
 * 工作区里某个文件是否存在——直接看独立 sandbox 容器的数据根。exec 的前台
 * 命令不落执行记录，「命令到没到执行面」只能
 * 以它留下的副作用为证。
 */
async function workspaceFileState(workspaceId, fileName) {
  const target = `/var/sandbox/workspaces/${workspaceId}/${fileName}`;
  const { stdout } = await docker(
    'exec',
    TEST_SANDBOX_CONTAINER,
    'sh',
    '-c',
    'test -e "$1" && echo PRESENT || echo ABSENT',
    '_',
    target,
  );
  return stdout.trim();
}

/** 以 Agent 的身份经真实内部面在 Run 的工作区里执行一条命令（正对照用）。 */
async function runInWorkspaceViaInternalPlane(ids, fenceToken, command) {
  const rpc = new ExecRpcClient({
    baseUrl: TEST_SANDBOX_URL,
    keyring: TEST_HMAC_KEYRING,
    activeKid: TEST_HMAC_ACTIVE_KID,
    orgId: ORG,
    userId: USER,
    workspaceId: ids.workspaceId,
    sandboxSessionId: ids.sandboxSessionId,
    runId: ids.runId,
    fenceToken,
    physicalRoots: ['/var/sandbox/workspaces', '/var/sandbox/tmp'],
  });
  await rpc.post('/internal/v1/sessions/ensure', { workspaceId: ids.workspaceId }, []);
  return rpc.post(
    '/internal/v1/shell/run',
    { command, workdir: '/home/sandbox/workspace', timeoutMs: 10_000, stdoutMaxBytes: 4_096 },
    [],
    { deadlineMs: 25_000 },
  );
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
  const existingOrg = await knex('tbl_agsvc_organizations').where({ org_id: ORG }).first();
  if (!existingOrg) {
    await organizations.createOrganization({
      orgId: ORG,
      name: 'real DSH restart gate',
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
    await knex('tbl_agsvc_agent_definitions').insert({
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
    await knex('tbl_agsvc_agent_versions').insert({
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
    title: 'real DSH restart gate',
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
      target.pathname.endsWith('/internal/v1/shell/run')
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

describe('real DSH Agent/Sandbox restart release gate', () => {
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
  'real DSH model/tool/Sandbox interruption behavior',
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
    dbpm = await startDbpmForUrls({ mysqlUrl: TEST_MYSQL_URL, redisUrl: TEST_REDIS_URL });
    agentKnex = createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 10 } });
    sandboxKnex = createMysqlKnex(TEST_SANDBOX_MYSQL_URL, {
      pool: { min: 0, max: 10 },
    });
    await agentKnex.raw('SELECT 1');
    await sandboxKnex.raw('SELECT 1');
    // 结构由脚本按发布 DDL 预先建好（ADR 0011 D6）：独立 sandbox 启动时核对清单，
    // 测试里回滚重迁移会在它运行时拆掉 exec 的表。这里只确认库是空的 gate 库。
    assert.equal(
      Number((await agentKnex('tbl_agsvc_runs').count({ n: '*' }).first())?.n ?? -1),
      0,
      'gate schema must be freshly applied and empty',
    );
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
      await destroyMysqlKnex(agentKnex).catch((error) => errors.push(error));
      agentKnex = null;
    }
    if (sandboxKnex) {
      await destroyMysqlKnex(sandboxKnex).catch((error) => errors.push(error));
      sandboxKnex = null;
    }
    if (dbpm) {
      await dbpm.close().catch((error) => errors.push(error));
      dbpm = null;
    }
    if (fakeProvider) {
      await fakeProvider.close().catch((error) => errors.push(error));
      fakeProvider = null;
    }
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'real DSH gate cleanup failed');
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
      throw new AggregateError(errors, 'real DSH gate test cleanup failed');
    }
  });

  it('replays a real DSH model call after Worker SIGKILL with no side-effect ledger', async () => {
    const entered = deferred();
    const releaseInterruptedRequest = deferred();
    let attempts = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = agentTurnText(body);
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
      'tbl_agsvc_runs',
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
    const retryEvents = await agentKnex('tbl_agsvc_run_events').where({
      run_id: MODEL_IDS.runId,
      event_type: 'run.retrying',
    });
    assert.equal(retryEvents.length, 1);
    const toolRows = await agentKnex('tbl_agsvc_tool_executions').where({ run_id: MODEL_IDS.runId });
    assert.equal(toolRows.length, 0, 'model-only interruption must have no tool ledger');
    await workerB.terminate('SIGTERM');
  });

  it('continues one durable interaction after Worker restart and checkpoints the answer', async () => {
    const toolCallId = 'call-real-pi-interaction-restart-gate';
    let providerCalls = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = agentTurnText(body);
      if (!text.includes('INTERACTION_RESTART_GATE')) return 'unused';
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          toolCalls: [
            {
              id: toolCallId,
              // DSH 出厂工具名与参数形状（ASK_USER_TOOL_NAME）。
              name: 'ask_user_question',
              arguments: {
                questions: [
                  {
                    id: 'region',
                    header: 'Region',
                    question: 'Which region should the gate use?',
                    options: [{ label: 'eu' }, { label: 'us' }],
                  },
                ],
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
      'tbl_agsvc_run_interactions',
      { run_id: INTERACTION_IDS.runId, tool_call_id: toolCallId },
      (row) => row?.status === 'PENDING' && row?.resume_phase === 'NONE',
      30_000,
    );
    const parked = await waitForRow(
      agentKnex,
      'tbl_agsvc_runs',
      { run_id: INTERACTION_IDS.runId },
      (row) => row?.status === 'WAITING_INPUT',
      30_000,
    );
    assert.equal(parked.status, 'WAITING_INPUT');
    await waitForRow(
      agentKnex,
      'tbl_agsvc_agent_sessions',
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
      (await agentKnex('tbl_agsvc_run_interactions').where({ run_id: INTERACTION_IDS.runId })).length,
      1,
      'parking must create exactly one durable interaction',
    );
    assert.equal(
      (await agentKnex('tbl_agsvc_tool_executions').where({ run_id: INTERACTION_IDS.runId })).length,
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
      'tbl_agsvc_runs',
      { run_id: INTERACTION_IDS.runId },
      (row) => row?.status === 'SUCCEEDED',
      30_000,
    );
    assert.equal(succeeded.status, 'SUCCEEDED');
    const applied = await waitForRow(
      agentKnex,
      'tbl_agsvc_run_interactions',
      { interaction_id: pending.interaction_id },
      (row) => row?.status === 'RESOLVED' && row?.resume_phase === 'APPLIED',
      30_000,
    );
    assert.ok(applied.resume_claimed_at);
    assert.ok(applied.resume_applied_at);
    const session = await agentKnex('tbl_agsvc_agent_sessions')
      .where({ agent_session_id: INTERACTION_IDS.sessionId })
      .first();
    assert.equal(session.last_run_id, INTERACTION_IDS.runId);
    assert.ok(Number(session.pi_session_version) >= 2);
    const latestSnapshot = await agentKnex('tbl_agsvc_agent_session_snapshots')
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
      (await agentKnex('tbl_agsvc_run_interactions').where({ run_id: INTERACTION_IDS.runId })).length,
      1,
    );
    const tools = await agentKnex('tbl_agsvc_tool_executions').where({ run_id: INTERACTION_IDS.runId });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].status, 'SUCCEEDED');
    assert.equal(
      (
        await agentKnex('tbl_agsvc_run_events').where({
          run_id: INTERACTION_IDS.runId,
          event_type: 'interaction.resolved',
        })
      ).length,
      1,
    );
    await workerB.terminate('SIGTERM');
  });

  it('does not replay a real DSH tool after its dispatch boundary', async () => {
    const toolCallId = 'call-real-pi-tool-restart-gate';
    let providerCalls = 0;
    fakeProvider.setResponder(async ({ body }) => {
      const text = agentTurnText(body);
      if (!text.includes('TOOL_PROPOSAL_RESTART_GATE')) return 'unused';
      providerCalls += 1;
      return {
        toolCalls: [
          {
            id: toolCallId,
            name: 'bash',
            arguments: {
              command: 'printf TOOL_PROPOSAL_MUST_NOT_REACH_SANDBOX > dispatch-boundary-marker.txt',
              description: 'Write the dispatch boundary marker',
              timeoutMs: 30_000,
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
    assert.match(heldRequest.path, /\/internal\/v1\/shell\/run$/);
    // 请求已经发往执行面（被代理拦住）：派发边界必须**先于**派发落库——RUNNING，
    // 并绑定请求指纹与当前 fence。2026-09-17 修复前 DSH 下这一行停在 PROPOSED、
    // 两者皆空（Pi 时序假设，见 dsh-restart-gate-rewrite 证据 §3.1）。
    const toolBeforeKill = await agentKnex('tbl_agsvc_tool_executions')
      .where({ run_id: TOOL_IDS.runId, tool_call_id: toolCallId })
      .first();
    assert.ok(toolBeforeKill, `ledger row must exist before dispatch; stderr=${workerA.getStderr()}`);
    assert.equal(toolBeforeKill.status, 'RUNNING');
    assert.match(String(toolBeforeKill.request_hash), /^[0-9a-f]{64}$/);
    const sessionBeforeKill = await agentKnex('tbl_agsvc_agent_sessions')
      .where({ agent_session_id: TOOL_IDS.sessionId })
      .first();
    assert.equal(
      Number(toolBeforeKill.execution_fence_token),
      Number(sessionBeforeKill.execution_fence_token),
    );
    assert.equal(
      await workspaceFileState(TOOL_IDS.workspaceId, 'dispatch-boundary-marker.txt'),
      'ABSENT',
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

    const run = await agentKnex('tbl_agsvc_runs').where({ run_id: TOOL_IDS.runId }).first();
    assert.equal(run.status, 'RUNNING');
    const toolAfterRestart = await agentKnex('tbl_agsvc_tool_executions')
      .where({ run_id: TOOL_IDS.runId, tool_call_id: toolCallId })
      .first();
    assert.equal(
      toolAfterRestart.status,
      toolBeforeKill.status,
      'recovery must leave the unresolved tool row untouched',
    );
    assert.equal(providerCalls, 1, 'Worker B must not re-prompt the model');
    assert.equal(
      (
        await agentKnex('tbl_agsvc_run_events').where({
          run_id: TOOL_IDS.runId,
          event_type: 'run.retrying',
        })
      ).length,
      0,
    );
    // 给「若被重放」留出执行与落盘的时间，再看副作用。
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    assert.equal(
      await workspaceFileState(TOOL_IDS.workspaceId, 'dispatch-boundary-marker.txt'),
      'ABSENT',
      'restart recovery must not dispatch the proposed command to Sandbox',
    );
    // 正对照：同一工作区里经真实内部面执行的命令确实会留下文件，
    // 证明上面的 ABSENT 不是路径写错造成的假通过。
    const control = await runInWorkspaceViaInternalPlane(
      TOOL_IDS,
      Number(toolBeforeKill.execution_fence_token),
      'printf CONTROL > dispatch-boundary-control.txt',
    );
    assert.equal(control.exitCode, 0);
    assert.equal(
      await workspaceFileState(TOOL_IDS.workspaceId, 'dispatch-boundary-control.txt'),
      'PRESENT',
    );
    await workerB.terminate('SIGTERM');
    await sandboxProxy.close();
    sandboxProxy = null;
  });

  it(
    'marks an interrupted real Sandbox execution UNKNOWN and never re-executes it',
    { timeout: 180_000 },
    async () => {
      // 命令执行中执行面重启：Agent 拿不到结果，命令可能已经部分执行。
      //   1. 工具账本记 UNKNOWN / TOOL_OUTCOME_UNKNOWN（2026-09-17 修复前是
      //      FAILED/TOOL_ERROR，模型只看到 `fetch failed`）；
      //   2. 模型收到的是「可能已生效、重试前先检查」的明确提示；
      //   3. 被打断的命令不会自动重跑，也不会在重启后补写副作用。
      const toolCallId = 'call-real-sandbox-restart-gate';
      const marker = 'sandbox-restart-late.txt';
      let providerCalls = 0;
      let toolResultSeenByModel = null;
      fakeProvider.setResponder(async ({ body }) => {
        const text = agentTurnText(body);
        if (!text.includes('SANDBOX_RESTART_GATE')) return 'unused';
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            toolCalls: [
              {
                id: toolCallId,
                name: 'bash',
                arguments: {
                  command: `sleep 20; printf LATE > ${marker}`,
                  description: 'Sleep then write the late marker',
                  timeoutMs: 120_000,
                },
              },
            ],
          };
        }
        const toolMessage = (body?.messages || []).find((m) => m.role === 'tool');
        toolResultSeenByModel = toolMessage ? String(toolMessage.content).slice(0, 600) : null;
        return 'SANDBOX_RESTART_OBSERVED';
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
        'tbl_agsvc_tool_executions',
        { run_id: SANDBOX_IDS.runId, tool_call_id: toolCallId },
        (row) => Boolean(row),
      );
      // 确认命令真的在执行面里跑起来了，再重启容器。
      const deadline = Date.now() + 20_000;
      let running = false;
      while (Date.now() < deadline && !running) {
        const { stdout } = await docker(
          'exec',
          TEST_SANDBOX_CONTAINER,
          'sh',
          '-c',
          'ps -eo args | grep -c "[s]leep 20" || true',
        );
        running = Number(stdout.trim()) > 0;
        if (!running) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.ok(running, 'the bash command must be running inside Sandbox before restart');

      await docker('restart', '--time', '10', TEST_SANDBOX_CONTAINER);
      await waitForHttp(`${TEST_SANDBOX_URL}/health`);
      await waitForHttp(`${TEST_SANDBOX_URL}/ready`);

      const terminal = await waitForRow(
        agentKnex,
        'tbl_agsvc_tool_executions',
        { run_id: SANDBOX_IDS.runId, tool_call_id: toolCallId },
        (row) => ['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED', 'DENIED'].includes(String(row?.status)),
        60_000,
      ).catch((error) => {
        throw new Error(`${error.message}\nworker stderr:\n${workerA.getStderr()}`);
      });

      // 原命令 20 秒后才会写文件：等过这个时间点再看，重跑或补写都会留下它。
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      assert.equal(
        await workspaceFileState(SANDBOX_IDS.workspaceId, marker),
        'ABSENT',
        'the interrupted command must not be re-executed or complete after restart',
      );
      const toolRows = await agentKnex('tbl_agsvc_tool_executions').where({ run_id: SANDBOX_IDS.runId });
      assert.equal(toolRows.length, 1, 'no second tool execution may be created');
      assert.equal(terminal.status, 'UNKNOWN');
      assert.equal(terminal.error_code, 'TOOL_OUTCOME_UNKNOWN');
      assert.match(String(toolResultSeenByModel), /may or may not have taken effect/);

      const run = await agentKnex('tbl_agsvc_runs').where({ run_id: SANDBOX_IDS.runId }).first();
      const events = await agentKnex('tbl_agsvc_run_events')
        .where({ run_id: SANDBOX_IDS.runId })
        .orderBy('sequence_no');
      console.error(
        `[gate] sandbox-restart observation: tool=${terminal.status}/${terminal.error_code ?? 'null'} ` +
          `run=${run.status}/${run.status_reason ?? 'null'} providerAgentTurns=${providerCalls} ` +
          `retrying=${events.filter((e) => e.event_type === 'run.retrying').length} ` +
          `modelSawToolResult=${JSON.stringify(toolResultSeenByModel)}`,
      );
      await workerA.terminate('SIGTERM');
    },
  );
  },
);
