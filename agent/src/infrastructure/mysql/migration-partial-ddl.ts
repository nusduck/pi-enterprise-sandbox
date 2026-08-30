/**
 * Production-safe partial DDL recovery for MySQL migrations.
 *
 * MySQL DDL is non-transactional: a failed migration can leave tables/triggers
 * without a knex_migrations row. On failure we drop **only** objects created
 * during this `up` attempt (this-run), then rethrow — never DROP arbitrary
 * production tables that already existed before the run.
 */

export type PartialDdlTracker = {
  createTable: (name: string, builder: (t: import('knex').Knex.CreateTableBuilder) => void) => Promise<void>;
  createTrigger: (name: string, sql: string) => Promise<void>;
  recordTable: (name: string) => void;
  recordTrigger: (name: string) => void;
  getCreatedTables: () => string[];
  getCreatedTriggers: () => string[];
  dropThisRunOnly: () => Promise<Error[]>;
};

/**
 * Escape a MySQL identifier for DROP TRIGGER (bare names only).
 * @param name
 */
function quoteIdent(name: string) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Refusing unsafe SQL identifier for partial DDL: ${String(name)}`);
  }
  return `\`${name}\``;
}

/**
 * @param knex
 * @returns {PartialDdlTracker}
 */
export function createPartialDdlTracker(knex: import('knex').Knex) {
  if (!knex || !knex.schema) {
    throw new Error('createPartialDdlTracker requires a knex instance');
  }

  const tables: string[] = [];
  const triggers: string[] = [];
  let sealed = false;

  function assertOpen() {
    if (sealed) {
      throw new Error('PartialDdlTracker is sealed after dropThisRunOnly()');
    }
  }

  return {
    async createTable(name: string, builder: (t: import('knex').Knex.CreateTableBuilder) => void) {
      assertOpen();
      if (typeof name !== 'string' || !name) {
        throw new Error('createTable requires a table name');
      }
      await knex.schema.createTable(name, builder);
      // Record only after successful create — never drop pre-existing tables.
      tables.push(name);
    },

    /**
     * @param name
     * @param sql full CREATE TRIGGER statement
     */
    async createTrigger(name: string, sql: string) {
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
      const errors: Error[] = [];

      for (const name of [...triggers].reverse()) {
        try {
          await knex.raw(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
        } catch (err) {
          errors.push((err as Error));
        }
      }

      for (const name of [...tables].reverse()) {
        try {
          await knex.schema.dropTableIfExists(name);
        } catch (err) {
          errors.push((err as Error));
        }
      }

      return errors;
    },
  };
}

/**
 * Run migration body; on failure drop only this-run DDL then rethrow.
 *

 * @param knex
 * @param work
 * @returns {Promise<T>}
 */
export async function withPartialDdlCleanup<T>(knex: import('knex').Knex, work: (tracker: PartialDdlTracker) => Promise<T>) {
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
 * @param primarySecondArg
 * @returns {{ ok: boolean, illegalSqlFragment?: string, reason?: string }}
 */
export function diagnosePrimaryConstraintArg(primarySecondArg: unknown) {
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
    const entries = Object.entries((primarySecondArg as Record<string, unknown>));
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
