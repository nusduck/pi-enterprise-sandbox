/**
 * Production-safe partial DDL recovery for MySQL migrations.
 *
 * MySQL DDL is non-transactional: a failed migration can leave tables/triggers
 * without a knex_migrations row. On failure we drop **only** objects created
 * during this `up` attempt (this-run), then rethrow — never DROP arbitrary
 * production tables that already existed before the run.
 */

/**
 * @typedef {object} PartialDdlTracker
 * @property {(name: string, builder: (t: import('knex').Knex.CreateTableBuilder) => void) => Promise<void>} createTable
 * @property {(name: string, sql: string) => Promise<void>} createTrigger
 * @property {(name: string) => void} recordTable
 * @property {(name: string) => void} recordTrigger
 * @property {() => string[]} getCreatedTables
 * @property {() => string[]} getCreatedTriggers
 * @property {() => Promise<Error[]>} dropThisRunOnly
 */

/**
 * Escape a MySQL identifier for DROP TRIGGER (bare names only).
 * @param {string} name
 */
function quoteIdent(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing unsafe SQL identifier for partial DDL: ${String(name)}`);
  }
  return `\`${name}\``;
}

/**
 * @param {import('knex').Knex} knex
 * @returns {PartialDdlTracker}
 */
export function createPartialDdlTracker(knex) {
  if (!knex || !knex.schema) {
    throw new Error('createPartialDdlTracker requires a knex instance');
  }

  /** @type {string[]} create order */
  const tables = [];
  /** @type {string[]} create order */
  const triggers = [];
  let sealed = false;

  function assertOpen() {
    if (sealed) {
      throw new Error('PartialDdlTracker is sealed after dropThisRunOnly()');
    }
  }

  return {
    /**
     * @param {string} name
     * @param {(t: import('knex').Knex.CreateTableBuilder) => void} builder
     */
    async createTable(name, builder) {
      assertOpen();
      if (typeof name !== 'string' || !name) {
        throw new Error('createTable requires a table name');
      }
      await knex.schema.createTable(name, builder);
      // Record only after successful create — never drop pre-existing tables.
      tables.push(name);
    },

    /**
     * @param {string} name
     * @param {string} sql full CREATE TRIGGER statement
     */
    async createTrigger(name, sql) {
      assertOpen();
      if (typeof name !== 'string' || !name) {
        throw new Error('createTrigger requires a trigger name');
      }
      await knex.raw(sql);
      triggers.push(name);
    },

    /** @param {string} name */
    recordTable(name) {
      assertOpen();
      tables.push(name);
    },

    /** @param {string} name */
    recordTrigger(name) {
      assertOpen();
      triggers.push(name);
    },

    getCreatedTables() {
      return [...tables];
    },

    getCreatedTriggers() {
      return [...triggers];
    },

    /**
     * FK-safe: reverse create order. Collects cleanup errors; does not throw.
     * @returns {Promise<Error[]>}
     */
    async dropThisRunOnly() {
      sealed = true;
      /** @type {Error[]} */
      const errors = [];

      for (const name of [...triggers].reverse()) {
        try {
          await knex.raw(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
        } catch (err) {
          errors.push(/** @type {Error} */ (err));
        }
      }

      for (const name of [...tables].reverse()) {
        try {
          await knex.schema.dropTableIfExists(name);
        } catch (err) {
          errors.push(/** @type {Error} */ (err));
        }
      }

      return errors;
    },
  };
}

/**
 * Run migration body; on failure drop only this-run DDL then rethrow.
 *
 * @template T
 * @param {import('knex').Knex} knex
 * @param {(tracker: PartialDdlTracker) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withPartialDdlCleanup(knex, work) {
  const tracker = createPartialDdlTracker(knex);
  try {
    return await work(tracker);
  } catch (migrationErr) {
    const cleanupErrors = await tracker.dropThisRunOnly();
    if (cleanupErrors.length > 0) {
      const parts = [
        migrationErr instanceof Error ? migrationErr : new Error(String(migrationErr)),
        ...cleanupErrors,
      ];
      throw new AggregateError(
        parts,
        'Migration failed and partial DDL cleanup also failed; schema may still be partial. See docs/runbooks/mysql-partial-migration-recovery.md',
      );
    }
    throw migrationErr;
  }
}

/**
 * Static / unit oracle: Knex MySQL create-table `primaryKeys()` wraps the
 * second primary() argument with formatter.wrap(). Objects become
 * "`value` as `key`" (illegal: "as indexName"). Only a string constraint
 * name is safe for composite primary on create.
 *
 * @param {unknown} primarySecondArg
 * @returns {{ ok: boolean, illegalSqlFragment?: string, reason?: string }}
 */
export function diagnosePrimaryConstraintArg(primarySecondArg) {
  if (primarySecondArg === undefined || primarySecondArg === null || primarySecondArg === '') {
    return { ok: true };
  }
  if (typeof primarySecondArg === 'string') {
    if (/\bas\b/i.test(primarySecondArg)) {
      return {
        ok: false,
        reason: 'constraint name must not contain " as " (Knex wrap alias split)',
        illegalSqlFragment: `constraint ${primarySecondArg} primary key`,
      };
    }
    return { ok: true };
  }
  if (typeof primarySecondArg === 'object') {
    // Mirrors knex wrappingFormatter.parseObject: key→alias of value
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (primarySecondArg));
    if (entries.length === 0) {
      return {
        ok: false,
        reason: 'empty primary options object is not a valid constraint name',
      };
    }
    const fragments = entries.map(
      ([alias, value]) => `${String(value)} as ${alias}`,
    );
    return {
      ok: false,
      reason:
        'Knex MySQL create-table primaryKeys() does not read {constraintName|indexName}; ' +
        'object second arg is wrapped as alias SQL (illegal "as indexName")',
      illegalSqlFragment: `constraint ${fragments.join(', ')} primary key`,
    };
  }
  return {
    ok: false,
    reason: `unsupported primary second arg type: ${typeof primarySecondArg}`,
  };
}
