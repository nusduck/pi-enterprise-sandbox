/**
 * A user-triggered write against a Run the Worker is busy with contends for
 * the same rows. InnoDB resolves that by rolling one side back — which used
 * to reach the browser as a bare "Internal server error" with no stack in the
 * Agent log and no cancel intent in MySQL.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TransactionManager } from '../../src/infrastructure/mysql/transaction-manager.js';
import { MysqlDependencyError } from '../../src/infrastructure/mysql/errors.js';

function knexWith(outcomes) {
  const attempts = [];
  return {
    attempts,
    knex: {
      async transaction(work) {
        const outcome = outcomes[attempts.length];
        attempts.push(outcome);
        if (outcome instanceof Error) throw outcome;
        return work({ marker: outcome });
      },
    },
  };
}

function mysqlError(code, errno) {
  return Object.assign(new Error(code), { code, errno });
}

describe('TransactionManager contention handling', () => {
  it('retries a deadlock and returns the committed result', async () => {
    const { knex, attempts } = knexWith([mysqlError('ER_LOCK_DEADLOCK', 1213), 'ok']);
    const tx = new TransactionManager(knex, { retryBackoffMs: [0, 0], sleep: async () => {} });
    const result = await tx.run(async (trx) => trx.marker);
    assert.equal(result, 'ok');
    assert.equal(attempts.length, 2);
  });

  it('retries a lock wait timeout signalled by errno alone', async () => {
    const { knex } = knexWith([mysqlError(undefined, 1205), 'ok']);
    const tx = new TransactionManager(knex, { retryBackoffMs: [0], sleep: async () => {} });
    assert.equal(await tx.run(async (trx) => trx.marker), 'ok');
  });

  it('reports exhausted contention as a dependency failure, not a 500', async () => {
    const deadlock = mysqlError('ER_LOCK_DEADLOCK', 1213);
    const { knex, attempts } = knexWith([deadlock, deadlock, deadlock, deadlock]);
    const tx = new TransactionManager(knex, { retryBackoffMs: [0, 0], sleep: async () => {} });
    await assert.rejects(() => tx.run(async () => 'unreachable'), (err) => {
      assert.ok(err instanceof MysqlDependencyError);
      assert.equal(err.code, 'MYSQL_DEPENDENCY_ERROR');
      assert.equal(err.cause, deadlock);
      return true;
    });
    assert.equal(attempts.length, 3, 'initial attempt plus the retry budget');
  });

  it('labels a dropped connection without retrying it', async () => {
    const lost = mysqlError('PROTOCOL_CONNECTION_LOST');
    const { knex, attempts } = knexWith([lost, 'ok']);
    const tx = new TransactionManager(knex, { retryBackoffMs: [0], sleep: async () => {} });
    await assert.rejects(
      () => tx.run(async () => 'unreachable'),
      (err) => err instanceof MysqlDependencyError,
    );
    assert.equal(attempts.length, 1);
  });

  it('leaves an application error exactly as thrown', async () => {
    const boom = new Error('validation failed');
    const { knex, attempts } = knexWith([boom, 'ok']);
    const tx = new TransactionManager(knex, { retryBackoffMs: [0], sleep: async () => {} });
    await assert.rejects(() => tx.run(async () => 'unreachable'), (err) => err === boom);
    assert.equal(attempts.length, 1);
  });
});
