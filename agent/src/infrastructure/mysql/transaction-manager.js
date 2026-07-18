/**
 * Transaction boundary for Agent MySQL repositories.
 */

/**
 * @typedef {import('knex').Knex | import('knex').Knex.Transaction} DbExecutor
 */

export class TransactionManager {
  /**
   * @param {import('knex').Knex} knex
   */
  constructor(knex) {
    if (!knex || typeof knex.transaction !== 'function') {
      throw new Error('TransactionManager requires a knex instance with transaction()');
    }
    this.knex = knex;
  }

  /**
   * Run work inside a single MySQL transaction.
   * The callback receives the transaction-bound executor (use for all repos).
   *
   * @template T
   * @param {(trx: import('knex').Knex.Transaction) => Promise<T>} work
   * @returns {Promise<T>}
   */
  async run(work) {
    if (typeof work !== 'function') {
      throw new Error('TransactionManager.run requires a work function');
    }
    return this.knex.transaction(async (trx) => work(trx));
  }

  /**
   * @returns {import('knex').Knex}
   */
  getExecutor() {
    return this.knex;
  }
}
