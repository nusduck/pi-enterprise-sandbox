/**
 * Repository unit tests with injected fake knex (no knex/mysql2 install required).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from './fake-knex.js';
import { OrganizationRepository } from '../../src/infrastructure/mysql/repositories/organization-repository.js';
import { ConversationRepository } from '../../src/infrastructure/mysql/repositories/conversation-repository.js';
import { MessageRepository } from '../../src/infrastructure/mysql/repositories/message-repository.js';
import { AgentSessionRepository } from '../../src/infrastructure/mysql/repositories/agent-session-repository.js';
import { RunRepository } from '../../src/infrastructure/mysql/repositories/run-repository.js';
import {
  RunEventRepository,
  parseLastInsertId,
} from '../../src/infrastructure/mysql/repositories/run-event-repository.js';
import { TransactionManager } from '../../src/infrastructure/mysql/transaction-manager.js';
import { assertMysqlConnectionUrl } from '../../src/infrastructure/mysql/client.js';
import { MysqlConfigError, NotFoundError, ConflictError } from '../../src/infrastructure/mysql/errors.js';
import { CORE_TABLES_CREATE_ORDER } from '../../src/infrastructure/mysql/schema-tables.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER2 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN57';
const EVT = '01K0G2PAV8FPMVC9QHJG7JPN58';
const SBX = '01K0G2PAV8FPMVC9QHJG7JPN55';
const WSP = '01K0G2PAV8FPMVC9QHJG7JPN56';
const TRACE = 'a'.repeat(32);

describe('mysql client config (no driver required)', () => {
  it('accepts only mysql:// and mysql2://', () => {
    assert.equal(
      assertMysqlConnectionUrl('mysql://u:p@localhost:3306/agent'),
      'mysql://u:p@localhost:3306/agent',
    );
    assert.match(
      assertMysqlConnectionUrl('mysql2://u:p@localhost:3306/agent'),
      /^mysql2:\/\//,
    );
  });

  it('rejects empty, sqlite, postgres, mysql+, and bare credential DSNs', () => {
    const secret = 'mysql+pymysql://admin:SuperSecretPassw0rd@db.example.com:3306/prod';
    const bare = 'admin:SuperSecretPassw0rd@db.example.com/prod';
    const cases = [
      '',
      'sqlite:///tmp/x.db',
      ':memory:',
      'postgresql://u:p@localhost/db',
      'postgres://u:p@localhost/db',
      secret,
      bare,
      'nonsense@host/db',
      'http://example.com/db',
    ];
    for (const url of cases) {
      assert.throws(() => assertMysqlConnectionUrl(url), MysqlConfigError);
    }
  });

  it('error messages never echo full DSN or credentials', () => {
    const secret = 'mysql+pymysql://admin:SuperSecretPassw0rd@db.example.com:3306/prod';
    const bare = 'admin:SuperSecretPassw0rd@db.example.com/prod';
    for (const url of [secret, bare, 'nonsense@host/db']) {
      try {
        assertMysqlConnectionUrl(url);
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof MysqlConfigError);
        const msg = String(err.message);
        assert.doesNotMatch(msg, /SuperSecretPassw0rd/);
        assert.doesNotMatch(msg, /admin:/);
        assert.equal(msg.includes(url), false, 'must not echo full rejected DSN');
      }
    }
  });
});

describe('schema table list', () => {
  it('includes plan §8 core tables including domain_outbox and runs', () => {
    assert.ok(CORE_TABLES_CREATE_ORDER.includes('messages'));
    assert.ok(CORE_TABLES_CREATE_ORDER.includes('runs'));
    assert.ok(CORE_TABLES_CREATE_ORDER.includes('run_events'));
    assert.ok(CORE_TABLES_CREATE_ORDER.includes('domain_outbox'));
    assert.ok(CORE_TABLES_CREATE_ORDER.includes('idempotency_records'));
  });

  it('includes Sandbox execution-domain tables with FK-safe create order', () => {
    for (const t of [
      'sandbox_sessions',
      'process_executions',
      'sandbox_executions',
      'sandbox_audit_events',
      'datasets',
      'artifacts',
    ]) {
      assert.ok(CORE_TABLES_CREATE_ORDER.includes(t), `missing ${t}`);
    }
    const ss = CORE_TABLES_CREATE_ORDER.indexOf('sandbox_sessions');
    assert.ok(ss < CORE_TABLES_CREATE_ORDER.indexOf('process_executions'));
    assert.ok(ss < CORE_TABLES_CREATE_ORDER.indexOf('sandbox_executions'));
  });
});

describe('parseLastInsertId', () => {
  it('reads seq from knex mysql2 shapes', () => {
    assert.equal(parseLastInsertId([[{ seq: 3 }]]), 3);
    assert.equal(parseLastInsertId([{ seq: 7 }]), 7);
  });

  it('rejects invalid values', () => {
    assert.throws(() => parseLastInsertId([]));
    assert.throws(() => parseLastInsertId([[{ seq: 0 }]]));
  });
});

describe('repositories with fake knex', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {{ orgId: string, userId: string }} */
  let scope;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    scope = { orgId: ORG, userId: USER };
    state.tables.organizations = [
      {
        org_id: ORG,
        name: 'Acme',
        status: 'active',
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.users = [
      {
        user_id: USER,
        external_subject: 'sub-1',
        display_name: 'U',
        email: null,
        status: 'active',
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.conversations = [
      {
        conversation_id: CONV,
        org_id: ORG,
        user_id: USER,
        agent_id: AGENT,
        title: 't',
        status: 'active',
        current_agent_session_id: null,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
        archived_at: null,
      },
    ];
    state.tables.messages = [];
    state.tables.agent_sessions = [
      {
        agent_session_id: SESS,
        org_id: ORG,
        user_id: USER,
        conversation_id: CONV,
        agent_version_id: VER,
        sandbox_session_id: SBX,
        workspace_id: WSP,
        status: 'ACTIVE',
        pi_session_version: 0,
        last_run_id: null,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
        closed_at: null,
      },
    ];
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        conversation_id: CONV,
        agent_session_id: SESS,
        agent_version_id: VER,
        triggering_message_id: MSG,
        source: 'web',
        status: 'RUNNING',
        status_reason: null,
        queue_name: 'runs',
        attempt: 0,
        trace_id: TRACE,
        next_event_sequence: 0,
        started_at: null,
        completed_at: null,
        created_at: '2026-07-18 00:00:00.000',
        updated_at: '2026-07-18 00:00:00.000',
      },
    ];
    state.tables.run_events = [];
  });

  it('ConversationRepository enforces ownership on get', async () => {
    const repo = new ConversationRepository(knex);
    const owned = await repo.getById(CONV, scope);
    assert.equal(owned?.conversationId, CONV);
    const foreign = await repo.getById(CONV, { orgId: ORG, userId: USER2 });
    assert.equal(foreign, null);
  });

  it('MessageRepository is append-only (no update/replace API)', () => {
    const proto = MessageRepository.prototype;
    assert.equal(typeof proto.append, 'function');
    assert.equal(typeof proto.listByConversation, 'function');
    assert.equal(typeof proto.getById, 'function');
    assert.equal(proto.update, undefined);
    assert.equal(proto.updateMessages, undefined);
    assert.equal(proto.replaceAll, undefined);
    assert.equal(proto.replaceMessages, undefined);
  });

  it('MessageRepository.append assigns monotonic sequence under lock path', async () => {
    const repo = new MessageRepository(knex);
    const m1 = await repo.append({
      messageId: MSG,
      conversationId: CONV,
      orgId: ORG,
      userId: USER,
      role: 'user',
      messageType: 'text',
      contentJson: { text: 'hi' },
    });
    assert.equal(m1.sequenceNo, 1);
    const m2 = await repo.append({
      messageId: '01K0G2PAV8FPMVC9QHJG7JPN59',
      conversationId: CONV,
      orgId: ORG,
      userId: USER,
      role: 'assistant',
      messageType: 'text',
      contentJson: { text: 'yo' },
    });
    assert.equal(m2.sequenceNo, 2);
    const list = await repo.listByConversation(CONV, scope);
    assert.equal(list.length, 2);
    assert.deepEqual(
      list.map((m) => m.sequenceNo),
      [1, 2],
    );
  });

  it('MessageRepository.append rejects foreign ownership', async () => {
    const repo = new MessageRepository(knex);
    await assert.rejects(
      () =>
        repo.append({
          messageId: MSG,
          conversationId: CONV,
          orgId: ORG,
          userId: USER2,
          role: 'user',
          messageType: 'text',
          contentJson: {},
        }),
      NotFoundError,
    );
  });

  it('RunEventRepository uses LAST_INSERT_ID counter SQL (not MAX+1)', async () => {
    const repo = new RunEventRepository(knex);
    const e1 = await repo.append({
      eventId: EVT,
      runId: RUN,
      orgId: ORG,
      userId: USER,
      eventType: 'run.started',
      payloadJson: { ok: true },
      traceId: TRACE,
    });
    assert.equal(e1.sequenceNo, 1);
    assert.equal(state.tables.runs[0].next_event_sequence, 1);

    const e2 = await repo.append({
      eventId: '01K0G2PAV8FPMVC9QHJG7JPN5D',
      runId: RUN,
      orgId: ORG,
      userId: USER,
      eventType: 'token.delta',
      payloadJson: {},
      traceId: TRACE,
    });
    assert.equal(e2.sequenceNo, 2);
    assert.equal(state.tables.runs[0].next_event_sequence, 2);

    const maxSql = state.rawCalls.some((c) =>
      /MAX\s*\(\s*sequence/i.test(c.sql),
    );
    assert.equal(maxSql, false, 'must not use SELECT MAX(sequence)');
    assert.ok(
      state.rawCalls.some((c) =>
        /LAST_INSERT_ID\s*\(\s*next_event_sequence\s*\+\s*1\s*\)/i.test(c.sql),
      ),
    );
  });

  it('RunEventRepository list and get enforce ownership', async () => {
    const repo = new RunEventRepository(knex);
    await repo.append({
      eventId: EVT,
      runId: RUN,
      orgId: ORG,
      userId: USER,
      eventType: 'run.started',
      payloadJson: {},
      traceId: TRACE,
    });
    await assert.rejects(
      () => repo.listByRun(RUN, { orgId: ORG, userId: USER2 }),
      NotFoundError,
    );
    const events = await repo.listByRun(RUN, scope);
    assert.equal(events.length, 1);
  });

  it('RunRepository create/get/list are ownership scoped', async () => {
    const repo = new RunRepository(knex);
    state.tables.runs = [];
    const created = await repo.create({
      runId: RUN,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentSessionId: SESS,
      agentVersionId: VER,
      triggeringMessageId: MSG,
      source: 'web',
      status: 'ACCEPTED',
      queueName: 'runs',
      traceId: TRACE,
    });
    assert.equal(created?.runId, RUN);
    assert.equal(created?.nextEventSequence, 0);
    assert.equal(await repo.getById(RUN, { orgId: ORG, userId: USER2 }), null);
  });

  it('AgentSessionRepository create + list by conversation', async () => {
    const repo = new AgentSessionRepository(knex);
    state.tables.agent_sessions = [];
    await repo.create({
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentVersionId: VER,
      sandboxSessionId: SBX,
      workspaceId: WSP,
      status: 'ACTIVE',
    });
    const list = await repo.listByConversation(CONV, scope);
    assert.equal(list.length, 1);
    assert.equal(list[0].workspaceId, WSP);
  });

  it('OrganizationRepository membership is org+user scoped', async () => {
    const repo = new OrganizationRepository(knex);
    state.tables.organization_memberships = [];
    await repo.addMembership({
      orgId: ORG,
      userId: USER,
      role: 'member',
      status: 'active',
    });
    const m = await repo.getMembership(scope);
    assert.equal(m?.role, 'member');
    assert.equal(
      await repo.getMembership({ orgId: ORG, userId: USER2 }),
      null,
    );
  });

  it('TransactionManager.run requires knex.transaction', async () => {
    const tm = new TransactionManager(knex);
    const result = await tm.run(async (trx) => {
      assert.equal(trx.isTransaction, true);
      return 42;
    });
    assert.equal(result, 42);
  });

  it('requireOwnerScope rejects missing ids', async () => {
    const repo = new RunRepository(knex);
    await assert.rejects(() => repo.getById(RUN, { orgId: '', userId: USER }));
  });
});

describe('migration module exports up/down', async () => {
  it('loads migration file with up and down functions', async () => {
    const mod = await import(
      '../../src/infrastructure/mysql/migrations/20260718000001_core_platform_schema.js'
    );
    assert.equal(typeof mod.up, 'function');
    assert.equal(typeof mod.down, 'function');
  });
});
