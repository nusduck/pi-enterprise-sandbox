/**
 * Gated live integration: 同一 Agent Session 的顶层 Run 按提交顺序依次执行（plan §12 follow-up）。
 * 判定逻辑是 SQL，所以对真 MySQL 跑；session 锁的占用情况由测试注入。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const require = createRequire(import.meta.url);

function mysqlDepsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const runLive =
  Boolean(TEST_MYSQL_URL) &&
  mysqlDepsAvailable() &&
  (TEST_MYSQL_URL.startsWith('mysql://') || TEST_MYSQL_URL.startsWith('mysql2://'));

const describeLive = runLive ? describe : describe.skip;

describe('session turn gate integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('session turn gate (TEST_MYSQL_URL)', () => {
  let knex;
  let mysql;
  let ulid;
  let createSessionTurnGate;
  let conversationService;
  let lockOwners;
  let gate;

  before(async () => {
    mysql = await import('../../src/infrastructure/mysql/index.js');
    ({ ulid } = await import('../../src/domain/shared/ulid.js'));
    const containerEnv = await import('../../src/bootstrap/container-env.js');
    const { ConversationService } = await import('../../src/application/conversation-service.js');
    ({ createSessionTurnGate } = await import('../../src/application/session-turn-gate.js'));

    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 4 } });
    await mysql.migrateLatest(knex);
    conversationService = new ConversationService({
      transactionManager: new mysql.TransactionManager(knex),
      createRepositories: (db) =>
        containerEnv.createRepositoryBundle(db ?? knex, { now: () => new Date(), generateId: ulid }),
      db: knex,
      generateId: ulid,
    });
    lockOwners = new Map();
    gate = createSessionTurnGate({
      db: knex,
      sessionLockOwner: async (agentSessionId) => lockOwners.get(agentSessionId) ?? null,
    });
  });

  after(async () => {
    if (knex) await mysql.destroyMysqlKnex(knex);
  });

  /** 新会话：返回写 runs 需要的父行 id。 */
  async function newSession() {
    const suffix = ulid();
    const created = await conversationService.create(
      { provider: 'bff', externalOrgId: `gate-org-${suffix}`, externalUserId: `gate-user-${suffix}` },
      {},
    );
    const conversation = await knex('conversations').where({ conversation_id: created.id }).first();
    const session = await knex('agent_sessions').where({ conversation_id: created.id }).first();
    return {
      orgId: session.org_id,
      userId: conversation.user_id,
      conversationId: session.conversation_id,
      agentSessionId: session.agent_session_id,
      agentVersionId: session.agent_version_id,
    };
  }

  let clock = Date.parse('2026-09-18T00:00:00.000Z');
  async function addRun(parents, status, extra = {}) {
    const runId = ulid();
    clock += 1000;
    await knex('runs').insert({
      run_id: runId,
      org_id: parents.orgId,
      user_id: parents.userId,
      conversation_id: parents.conversationId,
      agent_session_id: parents.agentSessionId,
      agent_version_id: parents.agentVersionId,
      triggering_message_id: ulid(),
      source: 'test',
      status,
      queue_name: 'agent-runs',
      trace_id: '0af7651916cd43dd8448eb211c80319c',
      created_at: new Date(clock),
      updated_at: new Date(clock),
      ...extra,
    });
    return runId;
  }

  it('waits while the session lock is held by the run in front', async () => {
    const s = await newSession();
    await addRun(s, 'RUNNING');
    const followUp = await addRun(s, 'QUEUED');
    lockOwners.set(s.agentSessionId, 'w1:token');
    assert.equal(await gate({ runId: followUp, orgId: s.orgId }), true);
    lockOwners.delete(s.agentSessionId);
    assert.equal(await gate({ runId: followUp, orgId: s.orgId }), false, 'runs as soon as the lock is free');
  });

  it('keeps queued follow-ups in submission order', async () => {
    const s = await newSession();
    await addRun(s, 'SUCCEEDED');
    const first = await addRun(s, 'QUEUED');
    const second = await addRun(s, 'QUEUED');
    assert.equal(await gate({ runId: first, orgId: s.orgId }), false);
    assert.equal(await gate({ runId: second, orgId: s.orgId }), true);
    await knex('runs').where({ run_id: first }).update({ status: 'SUCCEEDED' });
    assert.equal(await gate({ runId: second, orgId: s.orgId }), false);
  });

  it('does not wait behind parked or lock-less runs, nor for another session', async () => {
    const s = await newSession();
    await addRun(s, 'WAITING_INPUT');
    await addRun(s, 'RUNNING');
    const followUp = await addRun(s, 'QUEUED');
    assert.equal(await gate({ runId: followUp, orgId: s.orgId }), false);

    const other = await newSession();
    await addRun(other, 'QUEUED');
    lockOwners.set(other.agentSessionId, 'w2:token');
    const mine = await addRun(s, 'QUEUED');
    // followUp 仍排在前面；把它结束后，别的会话的锁与排队不影响本会话。
    await knex('runs').where({ run_id: followUp }).update({ status: 'SUCCEEDED' });
    assert.equal(await gate({ runId: mine, orgId: s.orgId }), false);
  });

  it('never gates subagent runs or runs that are already executing', async () => {
    const s = await newSession();
    const parent = await addRun(s, 'RUNNING');
    lockOwners.set(s.agentSessionId, 'w1:token');
    const child = await addRun(s, 'QUEUED', { parent_run_id: parent, subagent_depth: 1 });
    assert.equal(await gate({ runId: child, orgId: s.orgId }), false);
    assert.equal(await gate({ runId: parent, orgId: s.orgId }), false);
    lockOwners.delete(s.agentSessionId);
  });

  it('does not match a run of another org', async () => {
    const s = await newSession();
    const followUp = await addRun(s, 'QUEUED');
    lockOwners.set(s.agentSessionId, 'w1:token');
    const otherOrg = await newSession();
    assert.equal(await gate({ runId: followUp, orgId: otherOrg.orgId }), false);
    lockOwners.delete(s.agentSessionId);
  });
});
