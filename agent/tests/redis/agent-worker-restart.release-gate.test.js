/**
 * Destructive Agent Worker restart gate.
 *
 * Uses a dedicated MySQL schema, dedicated Redis container, actual production
 * Worker composition, and independent Node processes. It proves both recovery
 * branches: replay from a safe pre-side-effect checkpoint, and manual
 * reconciliation when the durable tool ledger has an unresolved outcome.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
import {
  createRunQueue,
  destroyRunQueue,
} from '../../src/infrastructure/redis/run-queue.js';
import { runLeaseKey } from '../../src/infrastructure/redis/constants.js';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(
  new URL('../fixtures/agent-worker-side-effect-process.js', import.meta.url),
);

const TEST_MYSQL_URL = String(process.env.TEST_MYSQL_URL || '').trim();
const TEST_REDIS_URL = String(process.env.TEST_REDIS_URL || '').trim();
const TEST_REDIS_CONTAINER = String(
  process.env.TEST_REDIS_CONTAINER || '',
).trim();
const explicitlyEnabled =
  process.env.RUN_AGENT_WORKER_RESTART_GATE === '1';
const safeContainer = /^pi-release-gate-redis-[a-z0-9-]+$/.test(
  TEST_REDIS_CONTAINER,
);

function databaseNameFromUrl(value) {
  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ''));
  } catch {
    return '';
  }
}

const databaseName = databaseNameFromUrl(TEST_MYSQL_URL);
const safeDatabase = /^pi_gate_[a-z0-9_]+$/.test(databaseName);
const runLive =
  explicitlyEnabled &&
  safeContainer &&
  safeDatabase &&
  Boolean(TEST_MYSQL_URL) &&
  Boolean(TEST_REDIS_URL);
const describeLive = runLive ? describe : describe.skip;

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN57';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN55';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN56';
const TRACE = 'f'.repeat(32);
const QUEUE = 'release-gate-agent-worker-restart';
const SIDE_EFFECT_TABLE = 'release_gate_worker_side_effects';
const TOOL_CALL_ID = 'release-gate-model-tool-call';
const LEASE_TTL_MS = 10_000;
const RECOVERY_INTERVAL_MS = 250;

const SAFE_IDS = Object.freeze({
  conversationId: CONV,
  sessionId: SESS,
  runId: RUN,
  messageId: MSG,
  sandboxSessionId: SBX,
  workspaceId: WSP,
  toolCallId: `${TOOL_CALL_ID}-safe`,
});
const UNSAFE_IDS = Object.freeze({
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN61',
  sessionId: '01K0G2PAV8FPMVC9QHJG7JPN62',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN63',
  messageId: '01K0G2PAV8FPMVC9QHJG7JPN67',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN65',
  workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN66',
  toolCallId: `${TOOL_CALL_ID}-unsafe`,
});

async function docker(...args) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function createWorkerHarness(workerLabel, opts = {}) {
  const ids = opts.ids ?? SAFE_IDS;
  const child = spawn(process.execPath, [FIXTURE], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEPLOYMENT_ENV: 'test',
      AGENT_DATABASE_URL: TEST_MYSQL_URL,
      AGENT_REDIS_URL: TEST_REDIS_URL,
      AGENT_RUNS_QUEUE_NAME: QUEUE,
      AGENT_MIGRATE_ON_START: 'false',
      AGENT_WORKER_CONCURRENCY: '1',
      AGENT_RECOVERY_SCAN_LIMIT: '10',
      AGENT_RECOVERY_INTERVAL_MS: String(RECOVERY_INTERVAL_MS),
      AGENT_OUTBOX_IDLE_MS: '100',
      AGENT_RUN_LEASE_TTL_MS: String(LEASE_TTL_MS),
      AGENT_RUN_LEASE_RENEW_INTERVAL_MS: '500',
      TEST_WORKER_LABEL: workerLabel,
      TEST_SIDE_EFFECT_TABLE: SIDE_EFFECT_TABLE,
      TEST_TOOL_CALL_ID: ids.toolCallId,
      TEST_RUN_ID: ids.runId,
      TEST_EXECUTOR_MODE: opts.executorMode ?? 'hang-after-side-effect',
      TEST_TOOL_STATUS: opts.toolStatus ?? '',
      TEST_EMIT_RECOVERY_SCANS: opts.emitRecoveryScans ? 'true' : 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const messages = [];
  const waiters = new Set();
  let stdoutBuffer = '';
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
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes('\n')) {
      const newline = stdoutBuffer.indexOf('\n');
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try {
        dispatch(JSON.parse(line));
      } catch {
        dispatch({ type: 'worker-log', line: line.slice(0, 1_024) });
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exitResult = { code, signal };
      resolve(exitResult);
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.reject(
          new Error(
            `Agent Worker ${workerLabel} exited before expected message ` +
              `(code=${String(code)} signal=${String(signal)} stderr=${stderr})`,
          ),
        );
      }
    });
  });

  return {
    child,
    messages,
    waitFor(predicate, timeoutMs = 15_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      if (exitResult) {
        return Promise.reject(
          new Error(
            `Agent Worker ${workerLabel} already exited: ${JSON.stringify(exitResult)}`,
          ),
        );
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
                `timed out waiting for Agent Worker ${workerLabel}; ` +
                  `messages=${JSON.stringify(messages)} stderr=${stderr}`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async terminate(signal = 'SIGTERM', timeoutMs = 15_000) {
      if (exitResult) return exitResult;
      child.kill(signal);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `Agent Worker ${workerLabel} did not exit after ${signal}`,
              ),
            ),
          timeoutMs,
        );
        exited.then((result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
  };
}

async function waitForRunStatus(
  knex,
  runId,
  expected,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await knex('runs').where({ run_id: runId }).first();
    if (String(last?.status || '') === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Run did not reach ${expected}; last=${JSON.stringify(last)}`,
  );
}

async function seedQueuedRun(knex, ids, opts = {}) {
  if (opts.seedTenant !== false) {
    const orgs = new OrganizationRepository(knex);
    await orgs.createOrganization({
      orgId: ORG,
      name: 'Agent Worker restart gate',
      status: 'active',
    });
    await orgs.createUser({
      userId: USER,
      externalSubject: `release-gate-${USER}`,
      displayName: 'Release Gate',
      status: 'active',
    });
    await orgs.addMembership({
      orgId: ORG,
      userId: USER,
      role: 'member',
      status: 'active',
    });

    await knex('agent_definitions').insert({
      agent_id: AGENT,
      org_id: ORG,
      name: 'release-gate-agent',
      description: null,
      status: 'active',
      active_version_id: null,
      created_by: USER,
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
    });
    await knex('agent_versions').insert({
      agent_version_id: VER,
      agent_id: AGENT,
      version_no: 1,
      config_json: JSON.stringify({ modelPolicy: {} }),
      config_hash: 'a'.repeat(64),
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
    title: 'Worker restart gate',
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

  const messages = new MessageRepository(knex);
  await messages.append({
    messageId: ids.messageId,
    conversationId: ids.conversationId,
    orgId: ORG,
    userId: USER,
    agentSessionId: ids.sessionId,
    role: 'user',
    messageType: 'text',
    contentJson: { text: 'execute the release-gate side effect' },
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
    traceId: TRACE,
  });
}

async function readSideEffect(knex, toolCallId) {
  return knex(SIDE_EFFECT_TABLE)
    .where({ tool_call_id: toolCallId })
    .first();
}

async function assertSafeRecoveryFacts(knex, ids) {
  const retryingEvents = await knex('run_events').where({
    run_id: ids.runId,
    event_type: 'run.retrying',
  });
  assert.equal(retryingEvents.length, 1, 'exactly one run.retrying event');

  const retryingOutbox = await knex('domain_outbox').where({
    aggregate_id: ids.runId,
    event_type: 'run.retrying',
  });
  assert.equal(retryingOutbox.length, 1, 'exactly one run.retrying outbox row');

  const failedEvents = await knex('run_events').where({
    run_id: ids.runId,
    event_type: 'run.failed',
  });
  assert.equal(failedEvents.length, 0, 'safe recovery must not invent failure');

  const sideEffect = await readSideEffect(knex, ids.toolCallId);
  assert.ok(sideEffect, 'new Worker must execute the post-recovery effect');
  assert.equal(Number(sideEffect.invocation_count), 1);
  assert.equal(sideEffect.first_worker, 'safe-worker-b');
  assert.equal(sideEffect.last_worker, 'safe-worker-b');
}

async function assertManualRecoveryFacts(knex, ids) {
  const retryingEvents = await knex('run_events').where({
    run_id: ids.runId,
    event_type: 'run.retrying',
  });
  assert.equal(retryingEvents.length, 0, 'unsafe recovery must not retry');

  const failedEvents = await knex('run_events').where({
    run_id: ids.runId,
    event_type: 'run.failed',
  });
  assert.equal(failedEvents.length, 0, 'manual boundary is not terminal FAILED');

  const tools = await knex('tool_executions').where({ run_id: ids.runId });
  assert.equal(tools.length, 1);
  assert.ok(['RUNNING', 'UNKNOWN'].includes(String(tools[0].status)));

  const sideEffect = await readSideEffect(knex, ids.toolCallId);
  assert.ok(sideEffect, 'durable executor side effect must exist');
  assert.equal(Number(sideEffect.invocation_count), 1);
  assert.equal(sideEffect.first_worker, 'unsafe-worker-a');
  assert.equal(sideEffect.last_worker, 'unsafe-worker-a');
}

describe('Agent Worker restart release-gate safety', () => {
  it('requires explicit opt-in and isolated MySQL/Redis resources', () => {
    if (!explicitlyEnabled) {
      assert.ok(true, 'skipped: RUN_AGENT_WORKER_RESTART_GATE is not 1');
      return;
    }
    assert.ok(
      safeContainer,
      'TEST_REDIS_CONTAINER must match pi-release-gate-redis-*',
    );
    assert.ok(
      safeDatabase,
      'TEST_MYSQL_URL database must match pi_gate_*',
    );
    assert.ok(TEST_REDIS_URL, 'TEST_REDIS_URL is required');
  });
});

describeLive('Agent Worker SIGKILL checkpoint-aware recovery', () => {
  let knex = null;
  let queueHandles = null;
  const workers = [];

  before(async () => {
    const inspected = await docker(
      'inspect',
      '--format',
      '{{.Name}}|{{.Config.Image}}|{{.State.Running}}',
      TEST_REDIS_CONTAINER,
    );
    const [name, image, running] = inspected.stdout.trim().split('|');
    assert.equal(name, `/${TEST_REDIS_CONTAINER}`);
    assert.equal(image, 'redis:7.2');
    assert.equal(running, 'true');

    knex = createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 10 } });
    await knex.schema.dropTableIfExists(SIDE_EFFECT_TABLE);
    await migrateRollbackAll(knex);
    await migrateLatest(knex);
    await knex.schema.createTable(SIDE_EFFECT_TABLE, (table) => {
      table.string('tool_call_id', 128).primary();
      table.specificType('run_id', 'CHAR(26)').notNullable();
      table.integer('invocation_count').notNullable();
      table.string('first_worker', 64).notNullable();
      table.string('last_worker', 64).notNullable();
      table.specificType('created_at', 'DATETIME(3)').notNullable();
      table.specificType('updated_at', 'DATETIME(3)').notNullable();
    });

    queueHandles = createRunQueue(TEST_REDIS_URL, { queueName: QUEUE });
    await queueHandles.queue.waitUntilReady();
    await queueHandles.queue.obliterate({ force: true });
    await seedQueuedRun(knex, SAFE_IDS);
  });

  after(async () => {
    const cleanupErrors = [];
    for (const worker of workers) {
      await worker.terminate('SIGKILL').catch((error) => cleanupErrors.push(error));
    }
    if (queueHandles) {
      await queueHandles.queue
        .obliterate({ force: true })
        .catch((error) => cleanupErrors.push(error));
      await destroyRunQueue(queueHandles).catch((error) =>
        cleanupErrors.push(error),
      );
    }
    if (knex) {
      await knex.schema
        .dropTableIfExists(SIDE_EFFECT_TABLE)
        .catch((error) => cleanupErrors.push(error));
      await migrateRollbackAll(knex).catch((error) => cleanupErrors.push(error));
      await destroyMysqlKnex(knex).catch((error) => cleanupErrors.push(error));
    }
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'release-gate cleanup failed');
    }
  });

  it('replays a lease-free Run from a safe pre-side-effect checkpoint', async () => {
    const workerA = createWorkerHarness('safe-worker-a', {
      ids: SAFE_IDS,
      executorMode: 'hang-before-side-effect',
    });
    workers.push(workerA);

    await workerA.waitFor(
      (message) =>
        message.type === 'executor-entered' && message.runId === RUN,
    );

    const running = await waitForRunStatus(knex, RUN, 'RUNNING');
    assert.equal(Number(running.attempt), 1);
    const firstLeaseOwner = await queueHandles.connection.get(runLeaseKey(RUN));
    assert.ok(firstLeaseOwner, 'Worker A must hold the real Redis lease');

    const killed = await workerA.terminate('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');

    const afterKill = await knex('runs').where({ run_id: RUN }).first();
    assert.equal(afterKill.status, 'RUNNING');
    assert.equal(await readSideEffect(knex, SAFE_IDS.toolCallId), undefined);
    assert.ok(
      await queueHandles.connection.get(runLeaseKey(RUN)),
      'SIGKILL leaves Worker A lease until its TTL expires',
    );

    const workerB = createWorkerHarness('safe-worker-b', {
      ids: SAFE_IDS,
      executorMode: 'succeed',
    });
    workers.push(workerB);
    await workerB.waitFor((message) => message.type === 'ready');

    const beforeLeaseExpiry = await knex('runs').where({ run_id: RUN }).first();
    assert.equal(
      beforeLeaseExpiry.status,
      'RUNNING',
      'Worker B initial recovery must skip while Worker A lease is live',
    );
    assert.ok(await queueHandles.connection.get(runLeaseKey(RUN)));
    assert.equal(await readSideEffect(knex, SAFE_IDS.toolCallId), undefined);

    const stalled = await workerB.waitFor(
      (message) => message.type === 'stalled' && message.jobId === RUN,
      85_000,
    );
    assert.equal(stalled.previous, 'active');

    const completed = await workerB.waitFor(
      (message) => message.type === 'completed' && message.jobId === RUN,
      15_000,
    );
    assert.ok(completed.attemptsStarted >= 2);
    assert.ok(completed.stalledCounter >= 1);
    assert.equal(completed.result.status, 'SUCCEEDED');
    assert.deepEqual(completed.data, {
      runId: RUN,
      orgId: ORG,
      traceId: TRACE,
    });

    await waitForRunStatus(knex, RUN, 'SUCCEEDED', 15_000);
    await assertSafeRecoveryFacts(knex, SAFE_IDS);
    await workerB.terminate('SIGTERM');
  });

  it('keeps an orphan Run at the manual recovery boundary for unresolved side effects', async () => {
    await seedQueuedRun(knex, UNSAFE_IDS, { seedTenant: false });
    const workerA = createWorkerHarness('unsafe-worker-a', {
      ids: UNSAFE_IDS,
      executorMode: 'hang-after-side-effect',
      toolStatus: 'RUNNING',
    });
    workers.push(workerA);

    const firstEffect = await workerA.waitFor(
      (message) =>
        message.type === 'executor-side-effect' &&
        message.runId === UNSAFE_IDS.runId,
    );
    assert.equal(firstEffect.invocationCount, 1);
    const running = await waitForRunStatus(knex, UNSAFE_IDS.runId, 'RUNNING');
    assert.equal(Number(running.attempt), 1);
    const killed = await workerA.terminate('SIGKILL');
    assert.equal(killed.signal, 'SIGKILL');

    const workerB = createWorkerHarness('unsafe-worker-b', {
      ids: UNSAFE_IDS,
      executorMode: 'succeed',
      emitRecoveryScans: true,
    });
    workers.push(workerB);
    await workerB.waitFor((message) => message.type === 'ready');
    const reconciliation = await workerB.waitFor(
      (message) =>
        message.type === 'recovery-scan' &&
        message.runId === UNSAFE_IDS.runId &&
        message.action === 'needsReconciliation',
      LEASE_TTL_MS + 5_000,
    );
    assert.match(String(reconciliation.reason), /manual recovery required/i);

    const recovered = await knex('runs')
      .where({ run_id: UNSAFE_IDS.runId })
      .first();
    assert.equal(recovered.status, 'RUNNING');
    assert.equal(await queueHandles.connection.get(runLeaseKey(UNSAFE_IDS.runId)), null);
    assert.equal(
      workerB.messages.some(
        (message) =>
          message.type === 'executor-side-effect' &&
          message.runId === UNSAFE_IDS.runId,
      ),
      false,
    );
    await assertManualRecoveryFacts(knex, UNSAFE_IDS);
    await workerB.terminate('SIGTERM');
  });
});
