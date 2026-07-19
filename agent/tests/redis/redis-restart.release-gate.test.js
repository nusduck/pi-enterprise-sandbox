/**
 * Destructive live Redis restart gate.
 *
 * This test is intentionally outside the regular `*.integration.test.js` glob.
 * It stops/restarts a dedicated Redis container and rolls migrations on a
 * dedicated MySQL schema. The explicit opt-in and resource-name checks prevent
 * it from touching the development stack.
 */

import { after, before, describe, it } from 'node:test';
import assertStrict from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const TEST_REDIS_URL = (process.env.TEST_REDIS_URL || '').trim();
const TEST_REDIS_CONTAINER = (process.env.TEST_REDIS_CONTAINER || '').trim();
const explicitlyEnabled = process.env.RUN_REDIS_RESTART_GATE === '1';

const safeContainer = /^pi-release-gate-redis-[a-z0-9-]+$/.test(
  TEST_REDIS_CONTAINER,
);

function isDedicatedMysqlUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'mysql:' || parsed.protocol === 'mysql2:') &&
      parsed.pathname.slice(1).startsWith('pi_gate_')
    );
  } catch {
    return false;
  }
}

const safeMysql = isDedicatedMysqlUrl(TEST_MYSQL_URL);
const runLive =
  explicitlyEnabled &&
  safeContainer &&
  safeMysql &&
  Boolean(TEST_REDIS_URL);

const describeLive = runLive ? describe : describe.skip;

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const MESSAGE = '01K0G2PAV8FPMVC9QHJG7JPN57';
const SANDBOX_SESSION = '01K0G2PAV8FPMVC9QHJG7JPN55';
const WORKSPACE = '01K0G2PAV8FPMVC9QHJG7JPN56';
const RESTART_EVENT = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const RETRY_EVENT = '01K0G2PAV8FPMVC9QHJG7JPN5D';
const OUTBOX = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const SSE_EVENT_1 = '01K0G2PAV8FPMVC9QHJG7JPN58';
const SSE_EVENT_2 = '01K0G2PAV8FPMVC9QHJG7JPN59';
const TRACE = 'c'.repeat(32);

async function docker(...args) {
  return execFileAsync('docker', args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

async function waitForRedis(client, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if ((await client.ping()) === 'PONG') return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('dedicated Redis did not become ready before deadline', {
    cause: lastError,
  });
}

describe('redis restart release gate safety', () => {
  it('requires explicit opt-in and dedicated resource names', () => {
    if (!explicitlyEnabled) {
      assertStrict.ok(true, 'skipped: RUN_REDIS_RESTART_GATE is not 1');
      return;
    }
    assertStrict.ok(
      safeContainer,
      'TEST_REDIS_CONTAINER must match pi-release-gate-redis-*',
    );
    assertStrict.ok(
      safeMysql,
      'TEST_MYSQL_URL database must start with pi_gate_',
    );
    assertStrict.ok(TEST_REDIS_URL, 'TEST_REDIS_URL is required');
  });
});

describeLive('redis restart + outbox retry + SSE fallback (dedicated live resources)', () => {
  let mysql;
  let redisMod;
  let outboxMod;
  let RunEventQueryService;
  let RunEventSseService;
  let ExternalReferenceRepository;
  let knex;
  let client;

  async function createClient() {
    const next = redisMod.createRedisClient(TEST_REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectionRole: 'release-gate-redis-restart',
      connectionLog: () => {},
    });
    await next.connect();
    return next;
  }

  before(async () => {
    const inspected = await docker(
      'inspect',
      '--format',
      '{{.Name}}|{{.Config.Image}}|{{.State.Running}}',
      TEST_REDIS_CONTAINER,
    );
    const [name, image, running] = inspected.stdout.trim().split('|');
    assertStrict.equal(name, `/${TEST_REDIS_CONTAINER}`);
    assertStrict.equal(image, 'redis:7.2');
    assertStrict.equal(running, 'true');

    mysql = await import('../../src/infrastructure/mysql/index.js');
    redisMod = await import('../../src/infrastructure/redis/index.js');
    outboxMod = await import('../../src/infrastructure/outbox/index.js');
    ({ RunEventQueryService } = await import(
      '../../src/application/run-event-query-service.js'
    ));
    ({ RunEventSseService } = await import(
      '../../src/application/run-event-sse-service.js'
    ));
    ({ ExternalReferenceRepository } = await import(
      '../../src/infrastructure/mysql/repositories/external-reference-repository.js'
    ));

    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 5 } });
    await mysql.migrateLatest(knex);
    client = await createClient();

    await knex('domain_outbox').where({ outbox_id: OUTBOX }).del();
    await client.del(redisMod.runStreamKey(RUN));
  });

  after(async () => {
    try {
      await docker('start', TEST_REDIS_CONTAINER);
    } catch {
      // The original test failure remains primary; cleanup continues below.
    }

    if (client) {
      try {
        await waitForRedis(client);
        await client.del(redisMod.runStreamKey(RUN));
      } catch {
        // Best-effort Redis cleanup on a failing restart gate.
      }
      await redisMod.destroyRedisClient(client);
    }

    if (knex) {
      try {
        await knex('domain_outbox').where({ outbox_id: OUTBOX }).del();
        await mysql.migrateRollbackAll(knex);
      } finally {
        await mysql.destroyMysqlKnex(knex);
      }
    }
  });

  it('retains a run stream across an AOF-backed container restart', async () => {
    const stream = new redisMod.RunEventStream(client);
    await stream.append(RUN, {
      eventId: RESTART_EVENT,
      sequence: 40,
      type: 'run.restart_probe',
      payload: { source: 'live-release-gate' },
      createdAt: new Date().toISOString(),
    });

    const waitAof = await client.call('WAITAOF', '1', '0', '5000');
    assertStrict.deepEqual(waitAof.map(Number), [1, 0]);

    await docker('restart', '--time', '1', TEST_REDIS_CONTAINER);
    await waitForRedis(client);

    const rows = await stream.range(RUN);
    const persisted = rows.find((row) => row.eventId === RESTART_EVENT);
    assertStrict.ok(persisted, 'AOF-backed stream entry must survive restart');
    assertStrict.equal(persisted.sequence, '40');
    assertStrict.equal(persisted.type, 'run.restart_probe');
  });

  it('retries a MySQL outbox row after a real Redis outage', async () => {
    const repo = new outboxMod.OutboxRepository(knex, {
      baseDelayMs: 1,
      maxDelayMs: 10,
      maxAttempts: 5,
    });
    await repo.insert({
      outboxId: OUTBOX,
      aggregateType: 'run',
      aggregateId: RUN,
      eventType: 'run.outbox_retry_probe',
      payloadJson: {
        eventId: RETRY_EVENT,
        runId: RUN,
        sequence: 41,
      },
    });

    const publisher = new outboxMod.OutboxPublisher({
      repository: repo,
      stream: new redisMod.RunEventStream(client),
    });

    await docker('stop', '--time', '1', TEST_REDIS_CONTAINER);
    const inspected = await docker(
      'inspect',
      '--format',
      '{{.State.Running}}',
      TEST_REDIS_CONTAINER,
    );
    assertStrict.equal(inspected.stdout.trim(), 'false');

    const failedPass = await publisher.publishOnce();
    assertStrict.equal(failedPass.claimed, 1);
    assertStrict.equal(failedPass.retried, 1);
    assertStrict.equal(failedPass.published, 0);

    const pending = await repo.getById(OUTBOX);
    assertStrict.equal(pending.status, outboxMod.OUTBOX_STATUS.PENDING);
    assertStrict.equal(pending.attempts, 1);
    assertStrict.ok(pending.nextAttemptAt);
    assertStrict.ok(pending.lastError);
    assertStrict.equal(pending.lastError.includes(TEST_REDIS_URL), false);

    await docker('start', TEST_REDIS_CONTAINER);
    await waitForRedis(client);

    const recoveredPass = await publisher.publishOnce();
    assertStrict.equal(recoveredPass.claimed, 1);
    assertStrict.equal(recoveredPass.published, 1);
    assertStrict.equal(recoveredPass.retried, 0);

    const published = await repo.getById(OUTBOX);
    assertStrict.equal(published.status, outboxMod.OUTBOX_STATUS.PUBLISHED);
    assertStrict.equal(published.attempts, 2);

    const rows = await new redisMod.RunEventStream(client).range(RUN);
    const delivered = rows.filter((row) => row.eventId === RETRY_EVENT);
    assertStrict.equal(delivered.length, 1);
    assertStrict.equal(delivered[0].sequence, '41');
    assertStrict.equal(delivered[0].type, 'run.outbox_retry_probe');
  });

  it('falls back an active SSE stream to the MySQL journal during Redis outage', async () => {
    const scope = { orgId: ORG, userId: USER };
    const organizations = new mysql.OrganizationRepository(knex);
    const externalRefs = new ExternalReferenceRepository(knex);
    const conversations = new mysql.ConversationRepository(knex);
    const sessions = new mysql.AgentSessionRepository(knex);
    const messages = new mysql.MessageRepository(knex);
    const runs = new mysql.RunRepository(knex);
    const runEvents = new mysql.RunEventRepository(knex);

    await client.del(redisMod.runStreamKey(RUN));
    await organizations.createOrganization({
      orgId: ORG,
      name: 'Release Gate Org',
      status: 'active',
    });
    await organizations.createUser({
      userId: USER,
      externalSubject: 'bff:release-gate-user',
      displayName: 'Release Gate User',
      status: 'active',
    });
    await organizations.addMembership({
      orgId: ORG,
      userId: USER,
      role: 'member',
      status: 'active',
    });
    await externalRefs.createOrganizationRef({
      provider: 'bff',
      externalSubject: 'release-gate-org',
      orgId: ORG,
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
      agent_version_id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      config_json: JSON.stringify({ modelPolicy: {} }),
      config_hash: 'a'.repeat(64),
      pi_sdk_version: '0.80.3',
      status: 'active',
      created_by: USER,
      created_at: knex.fn.now(3),
    });
    await conversations.create({
      conversationId: CONVERSATION,
      orgId: ORG,
      userId: USER,
      agentId: AGENT,
      title: 'Release gate SSE',
      status: 'active',
    });
    await sessions.create({
      agentSessionId: SESSION,
      orgId: ORG,
      userId: USER,
      conversationId: CONVERSATION,
      agentVersionId: VERSION,
      sandboxSessionId: SANDBOX_SESSION,
      workspaceId: WORKSPACE,
      status: 'ACTIVE',
    });
    await messages.append({
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      orgId: ORG,
      userId: USER,
      agentSessionId: SESSION,
      role: 'user',
      messageType: 'text',
      contentJson: { text: 'release gate' },
    });
    await runs.create({
      runId: RUN,
      orgId: ORG,
      userId: USER,
      conversationId: CONVERSATION,
      agentSessionId: SESSION,
      agentVersionId: VERSION,
      triggeringMessageId: MESSAGE,
      source: 'web',
      status: 'RUNNING',
      queueName: 'agent-runs',
      traceId: TRACE,
    });
    await runEvents.append({
      eventId: SSE_EVENT_1,
      runId: RUN,
      orgId: ORG,
      userId: USER,
      eventType: 'run.started',
      payloadJson: { status: 'RUNNING' },
      traceId: TRACE,
    });

    const createRepositories = (db = knex) => ({
      organizations: new mysql.OrganizationRepository(db),
      externalRefs: new ExternalReferenceRepository(db),
      runs: new mysql.RunRepository(db),
      runEvents: new mysql.RunEventRepository(db),
    });
    const eventQueryService = new RunEventQueryService({
      createRepositories,
      db: knex,
      defaultProvider: 'bff',
    });

    let outageInjected = false;
    const frames = [];
    const service = new RunEventSseService({
      eventQueryService,
      runEventStream: new redisMod.RunEventStream(client),
      pollMs: 1,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 60_000,
      sleep: async () => {
        if (outageInjected) return;
        outageInjected = true;
        await docker('stop', '--time', '1', TEST_REDIS_CONTAINER);
        await runEvents.append({
          eventId: SSE_EVENT_2,
          runId: RUN,
          orgId: ORG,
          userId: USER,
          eventType: 'run.completed',
          payloadJson: { status: 'SUCCEEDED' },
          traceId: TRACE,
        });
        await runs.updateStatus(RUN, scope, {
          status: 'SUCCEEDED',
          completedAt: new Date(),
        });
      },
    });

    let result;
    try {
      result = await service.openStream(
        {
          runId: RUN,
          auth: {
            provider: 'bff',
            externalOrgId: 'release-gate-org',
            externalUserId: 'release-gate-user',
          },
        },
        {
          write(frame) {
            frames.push(frame);
            return true;
          },
          isClosed: () => false,
        },
      );

      const inspected = await docker(
        'inspect',
        '--format',
        '{{.State.Running}}',
        TEST_REDIS_CONTAINER,
      );
      assertStrict.equal(inspected.stdout.trim(), 'false');
    } finally {
      await docker('start', TEST_REDIS_CONTAINER);
      await waitForRedis(client);
    }

    const body = frames.join('');
    assertStrict.equal(outageInjected, true);
    assertStrict.equal(result.mode, 'mysql-poll-fallback');
    assertStrict.equal(result.status, 'SUCCEEDED');
    assertStrict.equal(result.lastSequence, 2);
    assertStrict.equal((body.match(/"sequence":1/g) || []).length, 1);
    assertStrict.equal((body.match(/"sequence":2/g) || []).length, 1);
    assertStrict.match(body, /event: end/);
  });
});
