/**
 * Reaping tool executions whose Sandbox replica died.
 *
 * The sweeper exists because the replica that needs reaping is the one that
 * cannot do it: a clean shutdown reconciles its own claims, a SIGKILL does not.
 * These tests pin the judgement calls, not the SQL — what it refuses to touch
 * matters more than what it closes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExecutionLeaseSweeper,
  LEASE_EXPIRED_ERROR_CODE,
} from '../../src/application/execution-lease-sweeper.js';

const NOW = new Date('2026-08-06T12:00:00.000Z');

/**
 * Knex stand-in recording the query shape and the updates applied.
 * `rows` are what the claim select returns; `updatable` decides which rows the
 * conditional update still matches.
 */
function fakeDb({ rows = [], updatable = null } = {}) {
  const state = {
    updates: [],
    selectWhere: [],
    usedForUpdate: false,
    usedSkipLocked: false,
    limit: null,
  };
  const allowed = updatable ?? new Set(rows.map((r) => r.tool_execution_id));

  function builder(table) {
    const q = {
      _table: table,
      _where: {},
      where(field, opOrValue, maybeValue) {
        const value = maybeValue === undefined ? opOrValue : maybeValue;
        const op = maybeValue === undefined ? '=' : opOrValue;
        if (typeof field === 'string') {
          q._where[field] = value;
          state.selectWhere.push([field, op, value]);
        }
        return q;
      },
      andWhere(field, value) {
        q._where[field] = value;
        return q;
      },
      whereNotNull(field) {
        state.selectWhere.push([field, 'not null', null]);
        return q;
      },
      orderBy() {
        return q;
      },
      limit(n) {
        state.limit = n;
        return q;
      },
      forUpdate() {
        state.usedForUpdate = true;
        return q;
      },
      skipLocked() {
        state.usedSkipLocked = true;
        return q;
      },
      async select() {
        return rows;
      },
      async update(patch) {
        const id = q._where.tool_execution_id;
        // Mirror the conditional update: only rows still RUNNING change.
        if (!allowed.has(id)) return 0;
        state.updates.push({ id, patch });
        return 1;
      },
    };
    return q;
  }

  const db = (table) => builder(table);
  db.transaction = async (fn) => fn(db);
  db.__state = state;
  return db;
}

const silent = { warn: () => {}, info: () => {} };

function row(id, node = 'sandbox-1') {
  return { tool_execution_id: id, owner_node_id: node, run_id: 'run-1' };
}

describe('execution lease sweeper', () => {
  it('requires a database', () => {
    assert.throws(() => createExecutionLeaseSweeper({}), /knex executor/);
  });

  it('closes an expired execution as UNKNOWN, never FAILED', async () => {
    const db = fakeDb({ rows: [row('exec-1')] });
    const sweeper = createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      logger: silent,
    });

    assert.equal(await sweeper.sweepOnce(), 1);

    const [update] = db.__state.updates;
    // We genuinely do not know whether the command ran. Recording FAILED would
    // be a definite claim about something ambiguous, and the run acts on it.
    assert.equal(update.patch.status, 'UNKNOWN');
    assert.equal(update.patch.error_code, LEASE_EXPIRED_ERROR_CODE);
    // Lease released so the row is never reaped twice.
    assert.equal(update.patch.owner_node_id, null);
    assert.equal(update.patch.lease_expires_at, null);
  });

  it('only considers RUNNING rows whose lease has actually expired', async () => {
    const db = fakeDb({ rows: [] });
    await createExecutionLeaseSweeper({ db, now: () => NOW, logger: silent }).sweepOnce();

    const predicates = db.__state.selectWhere;
    assert.ok(
      predicates.some(([f, , v]) => f === 'status' && v === 'RUNNING'),
      'a terminal row has already been accounted for',
    );
    assert.ok(
      predicates.some(([f, op]) => f === 'lease_expires_at' && op === '<'),
      'an unexpired lease means the owner is still alive',
    );
    assert.ok(
      predicates.some(([f, op]) => f === 'lease_expires_at' && op === 'not null'),
      'a NULL lease predates leasing and has no owner to attribute',
    );
  });

  it('claims rows so concurrent workers divide the batch', async () => {
    const db = fakeDb({ rows: [] });
    await createExecutionLeaseSweeper({ db, now: () => NOW, logger: silent }).sweepOnce();

    // Without SKIP LOCKED, N worker replicas would serialise on the same rows.
    assert.equal(db.__state.usedForUpdate, true);
    assert.equal(db.__state.usedSkipLocked, true);
  });

  it('bounds each pass so one sweep cannot hold a long transaction', async () => {
    const db = fakeDb({ rows: [] });
    await createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      batchSize: 25,
      logger: silent,
    }).sweepOnce();

    assert.equal(db.__state.limit, 25);
  });

  it('does not overwrite a row the real owner finalised mid-sweep', async () => {
    // Selected as expired, but no longer RUNNING by the time we update it.
    const db = fakeDb({ rows: [row('exec-1')], updatable: new Set() });
    const sweeper = createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      logger: silent,
    });

    assert.equal(await sweeper.sweepOnce(), 0);
    assert.deepEqual(db.__state.updates, [], (
      'clobbering a genuine SUCCEEDED with UNKNOWN is worse than leaving a ' +
      'stale row for one more tick'
    ));
  });

  it('reaps only the rows that are still reapable in a mixed batch', async () => {
    const db = fakeDb({
      rows: [row('exec-1'), row('exec-2'), row('exec-3')],
      updatable: new Set(['exec-1', 'exec-3']),
    });
    const sweeper = createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      logger: silent,
    });

    assert.equal(await sweeper.sweepOnce(), 2);
    assert.deepEqual(
      db.__state.updates.map((u) => u.id),
      ['exec-1', 'exec-3'],
    );
  });

  it('survives a database error rather than stopping forever', async () => {
    const db = () => {
      throw new Error('mysql gone');
    };
    db.transaction = async () => {
      throw new Error('mysql gone');
    };
    const sweeper = createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      logger: silent,
    });

    // A sweeper that dies on a transient error stops reaping altogether,
    // which is worse than a pass that accomplishes nothing.
    assert.equal(await sweeper.sweepOnce(), 0);
  });

  it('does nothing when no lease has expired', async () => {
    const db = fakeDb({ rows: [] });
    const sweeper = createExecutionLeaseSweeper({
      db,
      now: () => NOW,
      logger: silent,
    });

    assert.equal(await sweeper.sweepOnce(), 0);
    assert.deepEqual(db.__state.updates, []);
  });
});
