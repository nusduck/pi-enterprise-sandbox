/**
 * Real MySQL integration tests (plan §24 PR-02 acceptance).
 *
 * Gated: set TEST_MYSQL_URL=mysql://user:pass@host:3306/dbname
 * Requires: knex + mysql2 installed (see agent/package.json).
 *
 * Covers: empty migrate up/down, FK enforcement, message append-only API +
 * DB triggers, concurrent run_event sequence allocation (LAST_INSERT_ID).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  CORE_TABLES_CREATE_ORDER,
  SANDBOX_EXECUTION_DOMAIN_TABLES,
} from '../../src/infrastructure/mysql/schema-tables.js';

const TEST_URL = process.env.TEST_MYSQL_URL || '';
const runIntegration = Boolean(TEST_URL.trim());

const require = createRequire(import.meta.url);

function depsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const hasDeps = depsAvailable();
const describeMysql =
  runIntegration && hasDeps ? describe : describe.skip;

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
const TRACE = 'c'.repeat(32);

/** Child → parent truncate order (FK-safe with checks off; TRUNCATE skips row DELETE triggers). */
const TRUNCATE_ORDER = Object.freeze([
  'idempotency_records',
  'domain_outbox',
  'approvals',
  'artifacts',
  'datasets',
  'sandbox_audit_events',
  'sandbox_executions',
  'process_executions',
  'sandbox_sessions',
  'tool_executions',
  'run_events',
  'runs',
  'messages',
  'agent_session_snapshots',
  'agent_sessions',
  'conversations',
  'agent_versions',
  'agent_definitions',
  'organization_memberships',
  'users',
  'organizations',
]);

describe('mysql integration gate', () => {
  it('documents skip conditions when URL or deps missing', () => {
    if (!runIntegration) {
      assert.ok(true, 'skipped: TEST_MYSQL_URL unset');
      return;
    }
    if (!hasDeps) {
      assert.ok(true, 'skipped: knex/mysql2 not installed');
      return;
    }
    assert.ok(
      TEST_URL.startsWith('mysql://') || TEST_URL.startsWith('mysql2://'),
      'TEST_MYSQL_URL must use mysql:// or mysql2://',
    );
  });
});

describeMysql('mysql integration (TEST_MYSQL_URL)', () => {
  /** @type {import('knex').Knex} */
  let knex;
  /** @type {typeof import('../../src/infrastructure/mysql/index.js')} */
  let mysql;

  /**
   * Explicit FK-order data wipe. No silent catch.
   * Uses TRUNCATE so messages DELETE triggers do not block cleanup.
   */
  async function clearAllData() {
    await knex.raw('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const table of TRUNCATE_ORDER) {
        await knex.raw(`TRUNCATE TABLE \`${table}\``);
      }
    } finally {
      await knex.raw('SET FOREIGN_KEY_CHECKS = 1');
    }
  }

  before(async () => {
    mysql = await import('../../src/infrastructure/mysql/index.js');
    knex = mysql.createMysqlKnex(TEST_URL, { pool: { min: 0, max: 20 } });
    await mysql.migrateRollbackAll(knex);
    await mysql.migrateLatest(knex);
  });

  after(async () => {
    if (!knex) return;
    /** @type {unknown} */
    let rollbackError = null;
    try {
      await mysql.migrateRollbackAll(knex);
    } catch (err) {
      rollbackError = err;
    }
    try {
      await mysql.destroyMysqlKnex(knex);
    } catch (destroyErr) {
      if (rollbackError) {
        throw new AggregateError(
          [rollbackError, destroyErr],
          'mysql integration after() cleanup failed (rollback + destroy)',
        );
      }
      throw destroyErr;
    }
    if (rollbackError) {
      throw rollbackError;
    }
  });

  it('migrates empty database creating all core tables (utf8mb4)', async () => {
    const [rows] = await knex.raw(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS coll
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
    );
    const names = new Set(rows.map((r) => r.name || r.NAME));
    for (const t of CORE_TABLES_CREATE_ORDER) {
      assert.ok(names.has(t), `missing table ${t}`);
    }
    assert.ok(names.has('knex_migrations'));

    const runsMeta = rows.find((r) => (r.name || r.NAME) === 'runs');
    assert.ok(runsMeta);
    assert.match(String(runsMeta.engine || runsMeta.ENGINE), /InnoDB/i);
    assert.match(
      String(runsMeta.coll || runsMeta.COLL || runsMeta.TABLE_COLLATION || ''),
      /utf8mb4/i,
    );

    const [cols] = await knex.raw(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'runs'
         AND COLUMN_NAME = 'next_event_sequence'`,
    );
    assert.equal(cols.length, 1);

    const [outboxCols] = await knex.raw(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'domain_outbox'
         AND COLUMN_NAME = 'published_at'`,
    );
    assert.equal(outboxCols.length, 1, 'published_at must exist exactly once');

    const [triggers] = await knex.raw(
      `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = 'messages'`,
    );
    const triggerNames = new Set(triggers.map((r) => r.name || r.NAME));
    assert.ok(triggerNames.has(mysql.MESSAGES_FORBID_UPDATE_TRIGGER));
    assert.ok(triggerNames.has(mysql.MESSAGES_FORBID_DELETE_TRIGGER));

    for (const t of SANDBOX_EXECUTION_DOMAIN_TABLES) {
      assert.ok(names.has(t), `missing sandbox domain table ${t}`);
    }

    // process_executions tenant ownership columns
    const [procCols] = await knex.raw(
      `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'process_executions'
         AND COLUMN_NAME IN ('org_id', 'user_id')`,
    );
    assert.equal(procCols.length, 2, 'process_executions must have org_id and user_id');

    // No cyclic FK agent_sessions ↔ sandbox_sessions
    const [fkRows] = await knex.raw(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE()
         AND (
           (TABLE_NAME = 'agent_sessions' AND COLUMN_NAME = 'sandbox_session_id'
             AND REFERENCED_TABLE_NAME IS NOT NULL)
           OR
           (TABLE_NAME = 'sandbox_sessions' AND COLUMN_NAME = 'agent_session_id'
             AND REFERENCED_TABLE_NAME IS NOT NULL)
         )`,
    );
    assert.equal(
      fkRows.length,
      0,
      'agent_sessions.sandbox_session_id and sandbox_sessions.agent_session_id must not be FKs',
    );
  });

  it('rolls back all migrations then re-applies', async () => {
    await mysql.migrateRollbackAll(knex);
    const [afterDown] = await knex.raw(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
         AND TABLE_NAME = 'runs'`,
    );
    assert.equal(afterDown.length, 0);

    const [triggersAfterDown] = await knex.raw(
      `SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE()
         AND TRIGGER_NAME IN (?, ?)`,
      [
        mysql.MESSAGES_FORBID_UPDATE_TRIGGER,
        mysql.MESSAGES_FORBID_DELETE_TRIGGER,
      ],
    );
    assert.equal(triggersAfterDown.length, 0, 'triggers must drop on migrate down');

    await mysql.migrateLatest(knex);
    const [afterUp] = await knex.raw(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
         AND TABLE_NAME = 'runs'`,
    );
    assert.equal(afterUp.length, 1);
  });

  it('enforces foreign keys', async () => {
    await assert.rejects(
      () =>
        knex('organization_memberships').insert({
          org_id: ORG,
          user_id: USER,
          role: 'member',
          status: 'active',
          created_at: knex.fn.now(3),
        }),
      (err) => {
        const code = err?.code || err?.errno;
        assert.ok(
          code === 'ER_NO_REFERENCED_ROW_2' ||
            code === 1452 ||
            String(err.message).includes('foreign key'),
          `expected FK error, got ${code} ${err.message}`,
        );
        return true;
      },
    );
  });

  async function seedGraph() {
    const orgs = new mysql.OrganizationRepository(knex);
    await orgs.createOrganization({
      orgId: ORG,
      name: 'Test Org',
      status: 'active',
    });
    await orgs.createUser({
      userId: USER,
      externalSubject: `sub-${USER}`,
      status: 'active',
      displayName: 'Tester',
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
      name: 'default',
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

    const conversations = new mysql.ConversationRepository(knex);
    await conversations.create({
      conversationId: CONV,
      orgId: ORG,
      userId: USER,
      agentId: AGENT,
      title: 'c1',
      status: 'active',
    });

    const sessions = new mysql.AgentSessionRepository(knex);
    await sessions.create({
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentVersionId: VER,
      sandboxSessionId: SBX,
      workspaceId: WSP,
      status: 'ACTIVE',
    });

    const messages = new mysql.MessageRepository(knex);
    await messages.append({
      messageId: MSG,
      conversationId: CONV,
      orgId: ORG,
      userId: USER,
      agentSessionId: SESS,
      role: 'user',
      messageType: 'text',
      contentJson: { text: 'seed' },
    });

    const runs = new mysql.RunRepository(knex);
    await runs.create({
      runId: RUN,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: SESS,
      agentVersionId: VER,
      triggeringMessageId: MSG,
      source: 'web',
      status: 'RUNNING',
      queueName: 'runs',
      traceId: TRACE,
    });
  }

  it('MessageRepository is append-only; direct SQL UPDATE/DELETE are rejected', async () => {
    await clearAllData();
    await seedGraph();

    const messages = new mysql.MessageRepository(knex);
    const m2 = await messages.append({
      messageId: '01K0G2PAV8FPMVC9QHJG7JPN59',
      conversationId: CONV,
      orgId: ORG,
      userId: USER,
      role: 'assistant',
      messageType: 'text',
      contentJson: { text: 'reply' },
    });
    assert.equal(m2.sequenceNo, 2);

    const list = await messages.listByConversation(CONV, {
      orgId: ORG,
      userId: USER,
    });
    assert.equal(list.length, 2);

    assert.equal(typeof messages.update, 'undefined');
    assert.equal(typeof messages.delete, 'undefined');
    assert.equal(typeof messages.replaceAll, 'undefined');

    await assert.rejects(
      () =>
        messages.append({
          messageId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
          conversationId: CONV,
          orgId: ORG,
          userId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
          role: 'user',
          messageType: 'text',
          contentJson: {},
        }),
      mysql.NotFoundError,
    );

    await assert.rejects(
      () =>
        knex('messages')
          .where({ message_id: MSG })
          .update({ role: 'system' }),
      (err) => {
        assert.match(
          String(err.message),
          /append-only|UPDATE is forbidden|45000/i,
        );
        return true;
      },
    );

    await assert.rejects(
      () => knex('messages').where({ message_id: MSG }).del(),
      (err) => {
        assert.match(
          String(err.message),
          /append-only|DELETE is forbidden|45000/i,
        );
        return true;
      },
    );

    const stillThere = await knex('messages').where({ message_id: MSG }).first();
    assert.ok(stillThere);
    assert.equal(stillThere.role, 'user');
  });

  it('RunEventRepository concurrent appends produce contiguous unique sequences', async () => {
    await clearAllData();
    await seedGraph();

    const events = new mysql.RunEventRepository(knex);
    const N = 32;
    const eventIds = Array.from({ length: N }, (_, i) => {
      const n = String(i).padStart(4, '0');
      return `01EVENTSEQTEST${n}XXXXXX`.slice(0, 26);
    });

    const results = await Promise.all(
      eventIds.map((eventId, i) =>
        events.append({
          eventId,
          runId: RUN,
          orgId: ORG,
          userId: USER,
          eventType: 'token.delta',
          eventVersion: 1,
          payloadJson: { i },
          traceId: TRACE,
        }),
      ),
    );

    const seqs = results.map((r) => r.sequenceNo).sort((a, b) => a - b);
    assert.equal(seqs.length, N);
    assert.deepEqual(
      seqs,
      Array.from({ length: N }, (_, i) => i + 1),
    );

    const run = await knex('runs').where({ run_id: RUN }).first();
    assert.equal(Number(run.next_event_sequence), N);

    const listed = await events.listByRun(RUN, { orgId: ORG, userId: USER });
    assert.equal(listed.length, N);
  });
});
