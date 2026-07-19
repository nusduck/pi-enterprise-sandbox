/**
 * IdempotencyRepository unit tests (plan §8.18, PR-04 T1).
 * Offline fake knex — no MySQL/network.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  IdempotencyRepository,
  IDEMPOTENCY_KEY_MAX_LEN,
  IDEMPOTENCY_REQUEST_HASH_LEN,
} from '../../src/infrastructure/mysql/repositories/idempotency-repository.js';
import { ConflictError, NotFoundError } from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER2 = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const FIXED_NOW = new Date('2026-07-18T05:00:00.000Z');
const EXPIRES = new Date('2026-07-19T05:00:00.000Z');
const EXPIRED = new Date('2026-07-17T05:00:00.000Z');

/**
 * @param {unknown} left
 * @param {string} op
 * @param {unknown} right
 */
function cmp(left, op, right) {
  // MySQL DATETIME string / ISO compare via Date when both parse.
  const lv = Date.parse(String(left).includes('T') ? String(left) : `${String(left).replace(' ', 'T')}Z`);
  const rv = Date.parse(String(right).includes('T') ? String(right) : `${String(right).replace(' ', 'T')}Z`);
  if (Number.isFinite(lv) && Number.isFinite(rv)) {
    if (op === '<=') return lv <= rv;
    if (op === '<') return lv < rv;
    if (op === '>') return lv > rv;
    if (op === '>=') return lv >= rv;
  }
  const ls = String(left);
  const rs = String(right);
  if (op === '<=') return ls <= rs;
  if (op === '<') return ls < rs;
  if (op === '>') return ls > rs;
  if (op === '>=') return ls >= rs;
  return false;
}

/**
 * Ownership-aware fake for idempotency_records with CAS filter support.
 * @param {{ concurrentCasBarrier?: boolean }} [opts]
 */
function createIdempotencyFake(opts = {}) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  /** @type {Array<{ filters: unknown[], nullCols: string[], patch: Record<string, unknown> }>} */
  const updateLog = [];
  let forUpdateCount = 0;

  /** @type {Array<{ resolve: (n: number) => void, run: () => number }>} */
  let casBarrier = [];
  const concurrentCasBarrier = opts.concurrentCasBarrier === true;

  function rowMatches(row, filters, nullCols) {
    for (const col of nullCols) {
      if (row[col] != null) return false;
    }
    for (const f of filters) {
      if (Array.isArray(f) && f.length === 2 && f[1] && typeof f[1] === 'object' && 'op' in f[1]) {
        const [col, pred] = f;
        if (!cmp(row[col], pred.op, pred.value)) return false;
      } else if (Array.isArray(f) && f.length === 2) {
        const [col, val] = f;
        if (row[col] !== val) return false;
      }
    }
    return true;
  }

  function query() {
    /** @type {Array<[string, unknown] | [string, { op: string, value: unknown }]>} */
    const filters = [];
    /** @type {string[]} */
    const nullCols = [];
    /** @type {'select'|'insert'|'update'} */
    let type = 'select';
    /** @type {Record<string, unknown>|null} */
    let insertRow = null;
    /** @type {Record<string, unknown>|null} */
    let updates = null;
    let limitN = null;

    const api = {
      where(colOrObj, val) {
        if (typeof colOrObj === 'object' && colOrObj !== null) {
          for (const [k, v] of Object.entries(colOrObj)) filters.push([k, v]);
        } else {
          filters.push([String(colOrObj), val]);
        }
        return api;
      },
      andWhere(col, opOrVal, maybeVal) {
        if (maybeVal !== undefined) {
          filters.push([String(col), { op: String(opOrVal), value: maybeVal }]);
        } else if (typeof col === 'object' && col !== null) {
          for (const [k, v] of Object.entries(col)) filters.push([k, v]);
        } else {
          filters.push([String(col), opOrVal]);
        }
        return api;
      },
      whereNull(col) {
        nullCols.push(String(col));
        return api;
      },
      forUpdate() {
        forUpdateCount += 1;
        return api;
      },
      insert(row) {
        type = 'insert';
        insertRow = row;
        return Promise.resolve().then(() => {
          const dup = rows.some(
            (r) =>
              r.org_id === row.org_id &&
              r.user_id === row.user_id &&
              r.idempotency_key === row.idempotency_key &&
              r.operation === row.operation,
          );
          if (dup) {
            const err = new Error('Duplicate entry');
            // @ts-ignore
            err.code = 'ER_DUP_ENTRY';
            // @ts-ignore
            err.errno = 1062;
            throw err;
          }
          rows.push({ ...row });
          return 1;
        });
      },
      update(patch) {
        type = 'update';
        updates = patch;
        const snapshotFilters = filters.map((f) =>
          Array.isArray(f) ? [...f] : f,
        );
        const snapshotNulls = [...nullCols];

        const apply = () => {
          updateLog.push({
            filters: snapshotFilters,
            nullCols: snapshotNulls,
            patch: { ...patch },
          });
          let n = 0;
          for (const r of rows) {
            if (rowMatches(r, snapshotFilters, snapshotNulls)) {
              Object.assign(r, updates);
              n += 1;
            }
          }
          return n;
        };

        if (concurrentCasBarrier) {
          return new Promise((resolve) => {
            casBarrier.push({ resolve, run: apply });
            if (casBarrier.length >= 2) {
              // Deterministic: first waiter wins CAS, second evaluates after.
              const batch = casBarrier.splice(0, casBarrier.length);
              const n0 = batch[0].run();
              batch[0].resolve(n0);
              for (let i = 1; i < batch.length; i += 1) {
                batch[i].resolve(batch[i].run());
              }
            }
          });
        }

        return Promise.resolve().then(apply);
      },
      first() {
        limitN = 1;
        return Promise.resolve().then(() => {
          const found = rows.filter((r) => rowMatches(r, filters, nullCols));
          return found[0] ?? undefined;
        });
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            void type;
            void insertRow;
            let found = rows.filter((r) => rowMatches(r, filters, nullCols));
            if (limitN != null) found = found.slice(0, limitN);
            return found;
          })
          .then(resolve, reject);
      },
    };
    return api;
  }

  /** @type {any} */
  const db = (table) => {
    if (table !== 'idempotency_records') {
      throw new Error(`unexpected table ${table}`);
    }
    return query();
  };
  db.__rows = rows;
  db.__updateLog = updateLog;
  db.__forUpdateCount = () => forUpdateCount;
  return db;
}

describe('IdempotencyRepository begin/complete/replay', () => {
  /** @type {ReturnType<typeof createIdempotencyFake>} */
  let db;
  /** @type {IdempotencyRepository} */
  let repo;

  beforeEach(() => {
    db = createIdempotencyFake();
    repo = new IdempotencyRepository(db, { now: () => FIXED_NOW });
  });

  it('begin inserts a new in-progress record', async () => {
    const r = await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    assert.equal(r.outcome, 'begun');
    assert.equal(r.record.requestHash, HASH_A);
    assert.equal(r.record.responseStatus, null);
    assert.equal(r.record.orgId, ORG);
    assert.equal(r.record.userId, USER);
  });

  it('concurrent begin (duplicate PK) reloads and returns in_progress', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    const again = await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    assert.equal(again.outcome, 'in_progress');
    assert.equal(db.__forUpdateCount(), 1);
  });

  it('detects request hash conflict on same key+operation', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    await assert.rejects(
      () =>
        repo.begin({
          orgId: ORG,
          userId: USER,
          idempotencyKey: 'key-1',
          operation: 'create_run',
          requestHash: HASH_B,
          expiresAt: EXPIRES,
        }),
      ConflictError,
    );
  });

  it('complete then begin yields replay', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    await repo.complete({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      responseStatus: 201,
      responseJson: { runId: '01K0G2PAV8FPMVC9QHJG7JPN53' },
      resourceId: '01K0G2PAV8FPMVC9QHJG7JPN53',
    });
    const r = await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    assert.equal(r.outcome, 'replay');
    assert.equal(r.record.responseStatus, 201);
    assert.equal(r.record.resourceId, '01K0G2PAV8FPMVC9QHJG7JPN53');
  });

  it('expired records can be replaced on begin with CAS predicates', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRED,
    });
    db.__updateLog.length = 0;
    const r = await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_B,
      expiresAt: EXPIRES,
    });
    assert.equal(r.outcome, 'begun');
    assert.equal(r.record.requestHash, HASH_B);

    // SQL-shape: expiry + observed hash (+ created_at) predicates.
    assert.ok(db.__updateLog.length >= 1);
    const log = db.__updateLog[0];
    const hasExpiry = log.filters.some(
      (f) =>
        Array.isArray(f) &&
        f[0] === 'expires_at' &&
        f[1] &&
        typeof f[1] === 'object' &&
        f[1].op === '<=',
    );
    assert.equal(hasExpiry, true, 'CAS must include expires_at <= now');
    const hasHash = log.filters.some(
      (f) => Array.isArray(f) && f[0] === 'request_hash' && f[1] === HASH_A,
    );
    assert.equal(hasHash, true, 'CAS must include observed request_hash');
    const hasCreated = log.filters.some(
      (f) => Array.isArray(f) && f[0] === 'created_at',
    );
    assert.equal(hasCreated, true, 'CAS must include observed created_at');
  });

  it('sequential different hashes on expired: only one begun, other conflicts', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRED,
    });
    const first = await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_B,
      expiresAt: EXPIRES,
    });
    assert.equal(first.outcome, 'begun');
    assert.equal(first.record.requestHash, HASH_B);

    await assert.rejects(
      () =>
        repo.begin({
          orgId: ORG,
          userId: USER,
          idempotencyKey: 'key-1',
          operation: 'create_run',
          requestHash: HASH_C,
          expiresAt: EXPIRES,
        }),
      ConflictError,
    );
    assert.equal(db.__rows[0].request_hash, HASH_B);
  });

  it('never returns another tenant row (owner scope on get)', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    const foreign = await repo.get({
      orgId: ORG,
      userId: USER2,
      idempotencyKey: 'key-1',
      operation: 'create_run',
    });
    assert.equal(foreign, null);
  });

  it('validates bounded key / operation / hash', async () => {
    await assert.rejects(
      () =>
        repo.begin({
          orgId: ORG,
          userId: USER,
          idempotencyKey: 'x'.repeat(IDEMPOTENCY_KEY_MAX_LEN + 1),
          operation: 'create_run',
          requestHash: HASH_A,
          expiresAt: EXPIRES,
        }),
      /max length/,
    );
    await assert.rejects(
      () =>
        repo.begin({
          orgId: ORG,
          userId: USER,
          idempotencyKey: 'k',
          operation: 'op',
          requestHash: 'short',
          expiresAt: EXPIRES,
        }),
      /64/,
    );
    assert.equal(IDEMPOTENCY_REQUEST_HASH_LEN, 64);
  });

  it('complete on missing row throws NotFoundError', async () => {
    await assert.rejects(
      () =>
        repo.complete({
          orgId: ORG,
          userId: USER,
          idempotencyKey: 'missing',
          operation: 'create_run',
          responseStatus: 200,
        }),
      NotFoundError,
    );
  });

  it('rejects missing owner scope', async () => {
    await assert.rejects(
      () =>
        repo.begin({
          orgId: '',
          userId: USER,
          idempotencyKey: 'k',
          operation: 'op',
          requestHash: HASH_A,
          expiresAt: EXPIRES,
        }),
      /Owner scope/,
    );
  });

  it('complete never overwrites an already-completed response', async () => {
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRES,
    });
    const first = await repo.complete({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      responseStatus: 201,
      responseJson: { v: 1 },
      resourceId: '01K0G2PAV8FPMVC9QHJG7JPN53',
    });
    assert.equal(first.responseStatus, 201);
    assert.deepEqual(first.responseJson, { v: 1 });

    // Guards: response_status IS NULL + expires_at > now
    const completeUpdate = db.__updateLog.find((u) =>
      u.nullCols.includes('response_status'),
    );
    assert.ok(completeUpdate, 'complete must whereNull(response_status)');
    const hasExpiryGt = completeUpdate.filters.some(
      (f) =>
        Array.isArray(f) &&
        f[0] === 'expires_at' &&
        f[1] &&
        typeof f[1] === 'object' &&
        f[1].op === '>',
    );
    assert.equal(hasExpiryGt, true);

    const second = await repo.complete({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'key-1',
      operation: 'create_run',
      responseStatus: 500,
      responseJson: { v: 999, hacked: true },
      resourceId: '01K0G2PAV8FPMVC9QHJG7JPN54',
    });
    // Unchanged stored response
    assert.equal(second.responseStatus, 201);
    assert.deepEqual(second.responseJson, { v: 1 });
    assert.equal(second.resourceId, '01K0G2PAV8FPMVC9QHJG7JPN53');
    assert.equal(db.__rows[0].response_status, 201);
    assert.equal(db.__rows[0].resource_id, '01K0G2PAV8FPMVC9QHJG7JPN53');
  });
});

describe('IdempotencyRepository concurrent expired CAS race', () => {
  it('two concurrent different hashes: only one begun, other does not overwrite', async () => {
    const db = createIdempotencyFake({ concurrentCasBarrier: true });
    const repo = new IdempotencyRepository(db, { now: () => FIXED_NOW });

    // Seed expired row under old hash (via direct insert path).
    await repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'race-key',
      operation: 'create_run',
      requestHash: HASH_A,
      expiresAt: EXPIRED,
    });
    assert.equal(db.__rows[0].request_hash, HASH_A);

    // Both callers observe expired; barrier holds both CAS UPDATEs until 2 arrive.
    const p1 = repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'race-key',
      operation: 'create_run',
      requestHash: HASH_B,
      expiresAt: EXPIRES,
    });
    const p2 = repo.begin({
      orgId: ORG,
      userId: USER,
      idempotencyKey: 'race-key',
      operation: 'create_run',
      requestHash: HASH_C,
      expiresAt: EXPIRES,
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one begun; the loser must not also return begun with the other hash.
    assert.equal(fulfilled.length, 1, `expected 1 begun, got ${JSON.stringify(results)}`);
    assert.equal(rejected.length, 1);
    // @ts-ignore
    assert.equal(fulfilled[0].value.outcome, 'begun');
    // @ts-ignore
    const winnerHash = fulfilled[0].value.record.requestHash;
    assert.ok(winnerHash === HASH_B || winnerHash === HASH_C);
    // @ts-ignore
    assert.ok(rejected[0].reason instanceof ConflictError);

    // Row holds only the winner hash — never dual overwrite.
    assert.equal(db.__rows.length, 1);
    assert.equal(db.__rows[0].request_hash, winnerHash);
    assert.notEqual(db.__rows[0].request_hash, HASH_A);
  });
});
