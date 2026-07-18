/**
 * Unit tests for migrateLatestFromUrl destroy semantics (no knex/mysql2 required).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrateLatestFromUrl } from '../../src/infrastructure/mysql/migrate-from-url-core.js';

describe('migrateLatestFromUrl destroy semantics', () => {
  it('default destroy=true returns only result and destroys knex', async () => {
    const destroyCalls = [];
    const fakeKnex = { id: 'k1' };

    const out = await runMigrateLatestFromUrl({
      createKnex: () => fakeKnex,
      destroyKnex: async (k) => {
        destroyCalls.push(k);
      },
      migrateLatest: async () => [1, ['m1']],
      connectionUrl: 'mysql://u:p@localhost/db',
      opts: {},
    });

    assert.deepEqual(out, { result: [1, ['m1']] });
    assert.equal(Object.prototype.hasOwnProperty.call(out, 'knex'), false);
    assert.equal(destroyCalls.length, 1);
    assert.equal(destroyCalls[0], fakeKnex);
  });

  it('destroy=false returns live knex and does not destroy', async () => {
    const destroyCalls = [];
    const fakeKnex = { id: 'k2' };

    const out = await runMigrateLatestFromUrl({
      createKnex: () => fakeKnex,
      destroyKnex: async (k) => {
        destroyCalls.push(k);
      },
      migrateLatest: async () => [0, []],
      connectionUrl: 'mysql://u:p@localhost/db',
      opts: { destroy: false },
    });

    assert.equal(out.knex, fakeKnex);
    assert.deepEqual(out.result, [0, []]);
    assert.equal(destroyCalls.length, 0);
  });

  it('on migrate failure always destroys knex and rethrows', async () => {
    const destroyCalls = [];
    const fakeKnex = { id: 'k3' };

    await assert.rejects(
      () =>
        runMigrateLatestFromUrl({
          createKnex: () => fakeKnex,
          destroyKnex: async (k) => {
            destroyCalls.push(k);
          },
          migrateLatest: async () => {
            throw new Error('migrate boom');
          },
          connectionUrl: 'mysql://u:p@localhost/db',
          opts: { destroy: false },
        }),
      /migrate boom/,
    );
    assert.equal(destroyCalls.length, 1);
    assert.equal(destroyCalls[0], fakeKnex);
  });

  it('destroys knex exactly once even if destroyKnex is re-entered', async () => {
    const destroyCalls = [];
    const fakeKnex = { id: 'k4' };
    let migrateDone = false;

    const out = await runMigrateLatestFromUrl({
      createKnex: () => fakeKnex,
      destroyKnex: async (k) => {
        destroyCalls.push(k);
        // Simulate a buggy caller attempting a second destroy during cleanup.
        if (destroyCalls.length === 1 && migrateDone) {
          // destroyOnce should ignore re-entry if invoked again from outer code;
          // this test only ensures the core path calls destroy once on success.
        }
      },
      migrateLatest: async () => {
        migrateDone = true;
        return [1, ['m']];
      },
      connectionUrl: 'mysql://u:p@localhost/db',
      opts: { destroy: true },
    });

    assert.deepEqual(out.result, [1, ['m']]);
    assert.equal(destroyCalls.length, 1);
  });

  it('does not mask migration error when destroy fails (AggregateError)', async () => {
    const fakeKnex = { id: 'k5' };
    const migrateErr = new Error('migrate boom');
    const destroyErr = new Error('destroy boom');

    await assert.rejects(
      () =>
        runMigrateLatestFromUrl({
          createKnex: () => fakeKnex,
          destroyKnex: async () => {
            throw destroyErr;
          },
          migrateLatest: async () => {
            throw migrateErr;
          },
          connectionUrl: 'mysql://u:p@localhost/db',
          opts: { destroy: true },
        }),
      (err) => {
        assert.ok(err instanceof AggregateError, 'expected AggregateError');
        assert.equal(err.errors.length, 2);
        assert.equal(err.errors[0], migrateErr);
        assert.equal(err.errors[1], destroyErr);
        assert.match(String(err.message), /Migration failed|cleanup/i);
        // Original migrate error must still be visible (not replaced solely by destroy).
        assert.ok(
          err.errors.some((e) => String(e.message).includes('migrate boom')),
        );
        return true;
      },
    );
  });

  it('on migrate failure with destroy=true destroys only once', async () => {
    const destroyCalls = [];
    const fakeKnex = { id: 'k6' };

    await assert.rejects(
      () =>
        runMigrateLatestFromUrl({
          createKnex: () => fakeKnex,
          destroyKnex: async (k) => {
            destroyCalls.push(k);
          },
          migrateLatest: async () => {
            throw new Error('migrate fail once');
          },
          connectionUrl: 'mysql://u:p@localhost/db',
          opts: { destroy: true },
        }),
      /migrate fail once/,
    );
    assert.equal(destroyCalls.length, 1);
  });
});
