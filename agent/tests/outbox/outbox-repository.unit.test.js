/**
 * Offline unit tests for OutboxRepository (fake knex, no MySQL/Redis).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeOutboxKnex,
  createFakeState,
  seedOutboxRow,
} from './fake-outbox-knex.js';
import {
  OutboxRepository,
  OUTBOX_STATUS,
  sanitizeOutboxError,
  computeRetryDelayMs,
  parseRawSelectRows,
  parseAffectedRows,
  RUN_STREAM_CLAIM_ELIGIBILITY,
  buildEligibilitySql,
} from '../../src/infrastructure/outbox/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const OB1 = '01K0G2PAV8FPMVC9QHJG7JPN61';
const OB2 = '01K0G2PAV8FPMVC9QHJG7JPN62';
const OB3 = '01K0G2PAV8FPMVC9QHJG7JPN63';
const ORG_OB = '01K0G2PAV8FPMVC9QHJG7JPN64';
const FIXED_NOW = new Date('2026-07-18T05:00:00.000Z');

describe('outbox helpers', () => {
  it('sanitizes and bounds last_error', () => {
    const long = 'x'.repeat(600);
    const s = sanitizeOutboxError(new Error(long), 512);
    assert.ok(s.length <= 512);
    assert.ok(s.endsWith('…'));
    const redacted = sanitizeOutboxError(
      'connect mysql://admin:SuperSecret@db/prod failed',
    );
    assert.doesNotMatch(redacted, /SuperSecret/);
    assert.match(redacted, /mysql:\/\/\*\*\*/);
  });

  it('computes exponential bounded retry delay', () => {
    assert.equal(computeRetryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 60_000 }), 1000);
    assert.equal(computeRetryDelayMs(2, { baseDelayMs: 1000, maxDelayMs: 60_000 }), 2000);
    assert.equal(computeRetryDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 60_000 }), 4000);
    assert.equal(computeRetryDelayMs(20, { baseDelayMs: 1000, maxDelayMs: 60_000 }), 60_000);
  });

  it('parses raw select and affectedRows shapes', () => {
    assert.deepEqual(parseRawSelectRows([[{ a: 1 }], []]), [{ a: 1 }]);
    assert.deepEqual(parseRawSelectRows([{ a: 2 }]), [{ a: 2 }]);
    assert.equal(parseAffectedRows([{ affectedRows: 3 }]), 3);
    assert.equal(parseAffectedRows({ affectedRows: 1 }), 1);
  });

  it('buildEligibilitySql is parameterized for run-stream filter', () => {
    const { sql, bindings } = buildEligibilitySql(RUN_STREAM_CLAIM_ELIGIBILITY);
    assert.match(sql, /aggregate_type = \?/);
    assert.match(sql, /JSON_EXTRACT/);
    assert.deepEqual(bindings, ['run']);
    assert.doesNotMatch(sql, /'run'/); // value not inlined
  });
});

describe('OutboxRepository option validation', () => {
  it('rejects non-positive options', () => {
    const knex = createFakeOutboxKnex();
    assert.throws(
      () => new OutboxRepository(knex, { maxAttempts: 0 }),
      /maxAttempts/,
    );
    assert.throws(
      () => new OutboxRepository(knex, { staleClaimMs: -1 }),
      /staleClaimMs/,
    );
    assert.throws(
      () => new OutboxRepository(knex, { baseDelayMs: 1000, maxDelayMs: 100 }),
      /maxDelayMs/,
    );
    assert.throws(
      () => new OutboxRepository(knex, { baseDelayMs: 0 }),
      /baseDelayMs/,
    );
  });
});

describe('OutboxRepository unit (fake knex)', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeOutboxKnex>} */
  let knex;
  /** @type {OutboxRepository} */
  let repo;
  let tokenSeq;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeOutboxKnex(state);
    tokenSeq = 0;
    repo = new OutboxRepository(knex, {
      now: () => FIXED_NOW,
      maxAttempts: 3,
      staleClaimMs: 30_000,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      generateClaimToken: () => {
        tokenSeq += 1;
        return `CLAIMTOKEN${String(tokenSeq).padStart(15, '0')}`.slice(0, 26);
      },
    });
  });

  it('insert writes PENDING row suitable for same-transaction domain commit', async () => {
    const row = await repo.insert({
      outboxId: OB1,
      aggregateType: 'run',
      aggregateId: RUN,
      eventType: 'run.started',
      payloadJson: { eventId: OB1, sequence: 1, runId: RUN },
    });
    assert.equal(row.status, OUTBOX_STATUS.PENDING);
    assert.equal(row.attempts, 0);
    assert.equal(row.claimToken, null);
    assert.equal(state.tables.domain_outbox.length, 1);
    assert.equal(state.tables.domain_outbox[0].status, 'PENDING');
  });

  it('claimBatch emits SKIP LOCKED SQL and marks PUBLISHING with token + attempts', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    seedOutboxRow(state, {
      outbox_id: OB2,
      created_at: '2026-07-18 04:31:23.000',
    });

    const claimed = await repo.claimBatch({
      limit: 10,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(claimed.length, 2);
    assert.equal(claimed[0].status, OUTBOX_STATUS.PUBLISHING);
    assert.equal(claimed[0].attempts, 1);
    assert.ok(claimed[0].claimToken);
    assert.equal(claimed[1].attempts, 1);

    const claimSql = state.rawCalls.find((c) =>
      /FOR UPDATE SKIP LOCKED/i.test(c.sql),
    );
    assert.ok(claimSql, 'must use SELECT … FOR UPDATE SKIP LOCKED');
    assert.equal(claimSql.bindings[0], 'PENDING');
    assert.ok(claimSql.bindings.includes('run'));
    assert.equal(claimSql.bindings[claimSql.bindings.length - 1], 10);
    for (const b of claimSql.bindings) {
      assert.ok(b !== undefined);
    }
  });

  it('claimBatch with run-stream eligibility neither claims nor touches unrelated rows', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    seedOutboxRow(state, {
      outbox_id: ORG_OB,
      aggregate_type: 'organization',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      event_type: 'org.updated',
      payload_json: JSON.stringify({ name: 'acme' }),
      created_at: '2026-07-18 04:31:20.000',
    });
    seedOutboxRow(state, {
      outbox_id: OB2,
      aggregate_type: 'conversation',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
      event_type: 'message.created',
      payload_json: JSON.stringify({ text: 'hi' }),
      created_at: '2026-07-18 04:31:21.000',
    });
    // non-run but intentionally carries runId → eligible
    seedOutboxRow(state, {
      outbox_id: OB3,
      aggregate_type: 'tool',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN99',
      event_type: 'tool.execution.completed',
      payload_json: JSON.stringify({
        eventId: OB3,
        sequence: 2,
        runId: RUN,
      }),
      created_at: '2026-07-18 04:31:24.000',
    });

    const claimed = await repo.claimBatch({
      limit: 50,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    const ids = claimed.map((c) => c.outboxId).sort();
    assert.deepEqual(ids, [OB1, OB3].sort());

    const org = state.tables.domain_outbox.find((r) => r.outbox_id === ORG_OB);
    const conv = state.tables.domain_outbox.find((r) => r.outbox_id === OB2);
    assert.equal(org.status, 'PENDING');
    assert.equal(org.claim_token, null);
    assert.equal(org.attempts, 0);
    assert.equal(conv.status, 'PENDING');
    assert.equal(conv.attempts, 0);
  });

  it('simulates concurrent claim: second publisher skips already-locked rows', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    seedOutboxRow(state, {
      outbox_id: OB2,
      created_at: '2026-07-18 04:31:23.000',
    });

    const knexA = createFakeOutboxKnex(state);
    const knexB = createFakeOutboxKnex(state);
    const repoA = new OutboxRepository(knexA, {
      now: () => FIXED_NOW,
      generateClaimToken: () => 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    const repoB = new OutboxRepository(knexB, {
      now: () => FIXED_NOW,
      generateClaimToken: () => 'BBBBBBBBBBBBBBBBBBBBBBBBBB',
    });

    const first = await repoA.claimBatch({
      limit: 1,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].outboxId, OB1);

    const second = await repoB.claimBatch({
      limit: 10,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].outboxId, OB2);
    assert.notEqual(second[0].claimToken, first[0].claimToken);
  });

  it('reclaims stale PUBLISHING then allows re-claim (crash recovery)', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      status: 'PUBLISHING',
      claim_token: 'STALETOKENSTALETOKENSTALET',
      claimed_at: '2026-07-18 04:00:00.000',
      attempts: 1,
    });

    const reclaimed = await repo.reclaimStalePublishing({
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(reclaimed, 1);
    assert.equal(state.tables.domain_outbox[0].status, 'PENDING');
    assert.equal(state.tables.domain_outbox[0].claim_token, null);

    const claimed = await repo.claimBatch({
      limit: 5,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].outboxId, OB1);
    assert.equal(claimed[0].attempts, 2);
  });

  it('does not reclaim stale PUBLISHING for unrelated aggregates', async () => {
    seedOutboxRow(state, {
      outbox_id: ORG_OB,
      aggregate_type: 'organization',
      aggregate_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      event_type: 'org.updated',
      payload_json: JSON.stringify({ name: 'x' }),
      status: 'PUBLISHING',
      claim_token: 'ORGTOKENORGTOKENORGTOKENOR',
      claimed_at: '2026-07-18 04:00:00.000',
      attempts: 1,
    });

    const reclaimed = await repo.reclaimStalePublishing({
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(reclaimed, 0);
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHING');
    assert.equal(state.tables.domain_outbox[0].claim_token, 'ORGTOKENORGTOKENORGTOKENOR');
  });

  it('markPublished is token-guarded', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      status: 'PUBLISHING',
      claim_token: 'GOODTOKENGOODTOKENGOODTOKE',
      claimed_at: '2026-07-18 04:59:00.000',
      attempts: 1,
    });

    const bad = await repo.markPublished(OB1, 'WRONGTOKENWRONGTOKENWRONG');
    assert.equal(bad, false);
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHING');

    const ok = await repo.markPublished(OB1, 'GOODTOKENGOODTOKENGOODTOKE');
    assert.equal(ok, true);
    assert.equal(state.tables.domain_outbox[0].status, 'PUBLISHED');
    assert.equal(state.tables.domain_outbox[0].claim_token, null);
    assert.ok(state.tables.domain_outbox[0].published_at);
  });

  it('markPendingForRetry applies backoff and sanitizes error', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      status: 'PUBLISHING',
      claim_token: 'GOODTOKENGOODTOKENGOODTOKE',
      claimed_at: '2026-07-18 04:59:00.000',
      attempts: 1,
    });

    const outcome = await repo.markPendingForRetry(
      OB1,
      'GOODTOKENGOODTOKENGOODTOKE',
      new Error('redis down mysql://u:secret@h/db'),
    );
    assert.equal(outcome, 'retry');
    const row = state.tables.domain_outbox[0];
    assert.equal(row.status, 'PENDING');
    assert.ok(row.next_attempt_at);
    assert.doesNotMatch(String(row.last_error), /secret/);
  });

  it('markPendingForRetry becomes markFailed after max attempts', async () => {
    seedOutboxRow(state, {
      outbox_id: OB1,
      status: 'PUBLISHING',
      claim_token: 'GOODTOKENGOODTOKENGOODTOKE',
      claimed_at: '2026-07-18 04:59:00.000',
      attempts: 3,
    });

    const outcome = await repo.markPendingForRetry(
      OB1,
      'GOODTOKENGOODTOKENGOODTOKE',
      'still failing',
    );
    assert.equal(outcome, 'failed');
    assert.equal(state.tables.domain_outbox[0].status, 'FAILED');
  });

  it('listPending and listForRecovery return due / stale rows', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    seedOutboxRow(state, {
      outbox_id: OB2,
      status: 'PENDING',
      next_attempt_at: '2026-07-19 00:00:00.000',
      created_at: '2026-07-18 04:31:23.000',
    });
    seedOutboxRow(state, {
      outbox_id: OB3,
      status: 'PUBLISHING',
      claim_token: 'STALETOKENSTALETOKENSTALET',
      claimed_at: '2026-07-18 04:00:00.000',
      created_at: '2026-07-18 04:31:24.000',
    });

    const pending = await repo.listPending({
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].outboxId, OB1);

    const recovery = await repo.listForRecovery({
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    const ids = recovery.map((r) => r.outboxId).sort();
    assert.deepEqual(ids, [OB1, OB3].sort());
  });

  it('does not reference runs table or mutate business state', async () => {
    seedOutboxRow(state, { outbox_id: OB1 });
    state.tables.runs = [
      { run_id: RUN, status: 'RUNNING', org_id: 'x', user_id: 'y' },
    ];
    const claimed = await repo.claimBatch({
      limit: 1,
      eligibility: RUN_STREAM_CLAIM_ELIGIBILITY,
    });
    await repo.markPendingForRetry(
      claimed[0].outboxId,
      claimed[0].claimToken,
      'redis fail',
    );
    assert.equal(state.tables.runs[0].status, 'RUNNING');
    const allSql = state.rawCalls.map((c) => c.sql).join('\n');
    assert.doesNotMatch(allSql, /\bruns\b/i);
  });

  it('rejects invalid claimBatch limit', async () => {
    await assert.rejects(
      () => repo.claimBatch({ limit: 0 }),
      /claimBatch\.limit/,
    );
    await assert.rejects(
      () => repo.claimBatch({ limit: -5 }),
      /claimBatch\.limit/,
    );
  });
});

describe('outbox delivery migration static', () => {
  it('is additive, reversible, and preserves plan base columns', () => {
    const migrationPath = path.join(
      __dirname,
      '../../src/infrastructure/mysql/migrations/20260718000002_outbox_delivery.js',
    );
    const src = readFileSync(migrationPath, 'utf8');
    assert.match(src, /export async function up/);
    assert.match(src, /export async function down/);
    for (const col of [
      'claim_token',
      'claimed_at',
      'next_attempt_at',
      'last_error',
    ]) {
      assert.match(src, new RegExp(col));
    }
    assert.match(src, /idx_outbox_claim/);
    assert.match(src, /idx_outbox_stale_claim/);
    assert.match(src, /dropIndex/);
    assert.match(src, /idx_outbox_pending/);
    assert.doesNotMatch(src, /dropTable/);
    assert.doesNotMatch(src, /dropColumn\('outbox_id'\)/);
    assert.doesNotMatch(src, /dropColumn\('payload_json'\)/);
  });
});
