/**
 * Unit tests: this-run partial DDL cleanup + orphan schema fail-closed gate.
 * Injectable fakes — no live MySQL / knex required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPartialDdlTracker,
  withPartialDdlCleanup,
} from '../../src/infrastructure/mysql/migration-partial-ddl.js';
import {
  assertNoOrphanPartialSchema,
  inspectOrphanPartialSchema,
  CORE_MIGRATION_NAME,
} from '../../src/infrastructure/mysql/migrate-orphan-gate.js';
import { MysqlOrphanSchemaError } from '../../src/infrastructure/mysql/errors.js';

/**
 * @param {{
 *   tables?: Set<string>,
 *   migrations?: string[],
 *   failDropTables?: Set<string>,
 *   failCreateAt?: string,
 * }} [opts]
 */
function makeFakeKnex(opts = {}) {
  const tables = opts.tables ?? new Set();
  const migrations = opts.migrations ?? [];
  /** @type {string[]} */
  const droppedTables = [];
  /** @type {string[]} */
  const droppedTriggers = [];
  /** @type {string[]} */
  const createdTables = [];
  /** @type {string[]} */
  const rawSql = [];

  const knex = {
    schema: {
      hasTable: async (name) => tables.has(name),
      createTable: async (name, builder) => {
        if (opts.failCreateAt && name === opts.failCreateAt) {
          throw new Error(`injected create failure: ${name}`);
        }
        if (tables.has(name)) {
          throw new Error(`Table '${name}' already exists`);
        }
        // Minimal builder so migrations can run callbacks if needed
        if (typeof builder === 'function') {
          const t = new Proxy(
            {},
            {
              get: () => {
                const chain = () => chain;
                chain.primary = () => chain;
                chain.references = () => ({
                  onDelete: () => ({ onUpdate: () => chain }),
                  onUpdate: () => chain,
                  inTable: () => chain,
                });
                return typeof chain === 'function' ? chain : chain;
              },
            },
          );
          // simpler chainable stub
          const stub = makeTableStub();
          builder(stub);
        }
        tables.add(name);
        createdTables.push(name);
      },
      dropTableIfExists: async (name) => {
        if (opts.failDropTables?.has(name)) {
          throw new Error(`injected drop failure: ${name}`);
        }
        tables.delete(name);
        droppedTables.push(name);
      },
    },
    raw: async (sql) => {
      rawSql.push(String(sql));
      const dropTrig = String(sql).match(
        /DROP\s+TRIGGER\s+IF\s+EXISTS\s+`?([A-Za-z0-9_]+)`?/i,
      );
      if (dropTrig) {
        droppedTriggers.push(dropTrig[1]);
        return;
      }
      // CREATE TRIGGER success no-op
    },
    // knex('knex_migrations')
  };

  function queryBuilder() {
    return {
      select: async () => migrations.map((name) => ({ name })),
      where: () => queryBuilder(),
      orWhere: () => queryBuilder(),
    };
  }

  const callable = Object.assign(
    /** @param {string} table */ (table) => {
      if (table === 'knex_migrations') {
        return {
          select: async () => migrations.map((name) => ({ name })),
        };
      }
      throw new Error(`unexpected table query: ${table}`);
    },
    knex,
  );

  return {
    knex: /** @type {any} */ (callable),
    tables,
    droppedTables,
    droppedTriggers,
    createdTables,
    rawSql,
  };
}

function makeTableStub() {
  const stub = {};
  const methods = [
    'engine',
    'charset',
    'collate',
    'specificType',
    'string',
    'text',
    'integer',
    'bigInteger',
    'json',
    'boolean',
    'index',
    'unique',
    'primary',
    'notNullable',
    'nullable',
    'defaultTo',
    'foreign',
  ];
  for (const m of methods) {
    if (m === 'foreign') {
      stub.foreign = () => ({
        references: () => ({
          onDelete: () => ({ onUpdate: () => stub }),
          onUpdate: () => stub,
          inTable: () => stub,
        }),
      });
    } else if (m === 'specificType' || m === 'string' || m === 'integer' || m === 'bigInteger') {
      const col = {
        primary() {
          return col;
        },
        notNullable() {
          return col;
        },
        nullable() {
          return col;
        },
        defaultTo() {
          return col;
        },
      };
      stub[m] = () => col;
    } else {
      stub[m] = () => stub;
    }
  }
  return stub;
}

describe('createPartialDdlTracker this-run only', () => {
  it('records tables only after successful create', async () => {
    const { knex, tables } = makeFakeKnex();
    const tracker = createPartialDdlTracker(knex);
    await tracker.createTable('organizations', () => {});
    await tracker.createTable('users', () => {});
    assert.deepEqual(tracker.getCreatedTables(), ['organizations', 'users']);
    assert.ok(tables.has('organizations') && tables.has('users'));
  });

  it('does not record a table when create throws', async () => {
    const { knex } = makeFakeKnex({ failCreateAt: 'users' });
    const tracker = createPartialDdlTracker(knex);
    await tracker.createTable('organizations', () => {});
    await assert.rejects(
      () => tracker.createTable('users', () => {}),
      /injected create failure: users/,
    );
    assert.deepEqual(tracker.getCreatedTables(), ['organizations']);
  });

  it('dropThisRunOnly drops reverse order and leaves pre-existing tables', async () => {
    const pre = new Set(['legacy_keep_me']);
    const { knex, tables, droppedTables, droppedTriggers } = makeFakeKnex({
      tables: pre,
    });
    // pre-existing
    tables.add('legacy_keep_me');

    const tracker = createPartialDdlTracker(knex);
    await tracker.createTable('organizations', () => {});
    await tracker.createTable('users', () => {});
    await tracker.createTrigger(
      'trg_messages_forbid_update',
      'CREATE TRIGGER trg_messages_forbid_update ...',
    );

    const errs = await tracker.dropThisRunOnly();
    assert.equal(errs.length, 0);
    assert.deepEqual(droppedTriggers, ['trg_messages_forbid_update']);
    // reverse table drop: users then organizations
    assert.deepEqual(droppedTables, ['users', 'organizations']);
    assert.ok(tables.has('legacy_keep_me'), 'must not drop pre-existing tables');
    assert.equal(tables.has('organizations'), false);
    assert.equal(tables.has('users'), false);
  });

  it('never lists pre-existing tables even if create is skipped', async () => {
    const { knex, tables } = makeFakeKnex({
      tables: new Set(['organizations']),
    });
    const tracker = createPartialDdlTracker(knex);
    // Simulating: we never call createTable for orgs (already existed outside tracker)
    await tracker.createTable('users', () => {});
    assert.deepEqual(tracker.getCreatedTables(), ['users']);
    await tracker.dropThisRunOnly();
    assert.ok(tables.has('organizations'));
    assert.equal(tables.has('users'), false);
  });
});

describe('withPartialDdlCleanup', () => {
  it('on success leaves created tables and does not drop', async () => {
    const { knex, tables, droppedTables } = makeFakeKnex();
    await withPartialDdlCleanup(knex, async (tracker) => {
      await tracker.createTable('organizations', () => {});
      await tracker.createTable('users', () => {});
    });
    assert.ok(tables.has('organizations') && tables.has('users'));
    assert.deepEqual(droppedTables, []);
  });

  it('on mid-run failure drops only this-run tables then rethrows', async () => {
    const { knex, tables, droppedTables } = makeFakeKnex({
      failCreateAt: 'users',
    });
    await assert.rejects(
      () =>
        withPartialDdlCleanup(knex, async (tracker) => {
          await tracker.createTable('organizations', () => {});
          await tracker.createTable('users', () => {});
        }),
      /injected create failure: users/,
    );
    assert.equal(tables.has('organizations'), false);
    assert.deepEqual(droppedTables, ['organizations']);
  });

  it('does not drop pre-existing tables when later create fails', async () => {
    const { knex, tables } = makeFakeKnex({
      tables: new Set(['already_there']),
      failCreateAt: 'users',
    });
    await assert.rejects(
      () =>
        withPartialDdlCleanup(knex, async (tracker) => {
          await tracker.createTable('organizations', () => {});
          await tracker.createTable('users', () => {});
        }),
      /injected create failure/,
    );
    assert.ok(tables.has('already_there'));
    assert.equal(tables.has('organizations'), false);
  });

  it('aggregates cleanup failure with original migration error', async () => {
    const { knex } = makeFakeKnex({
      failCreateAt: 'users',
      failDropTables: new Set(['organizations']),
    });
    try {
      await withPartialDdlCleanup(knex, async (tracker) => {
        await tracker.createTable('organizations', () => {});
        await tracker.createTable('users', () => {});
      });
      assert.fail('expected AggregateError');
    } catch (err) {
      assert.ok(err instanceof AggregateError);
      assert.match(String(err.message), /partial DDL cleanup also failed/i);
      assert.ok(
        err.errors.some((e) => /injected create failure/.test(String(e.message))),
      );
      assert.ok(
        err.errors.some((e) => /injected drop failure/.test(String(e.message))),
      );
    }
  });

  it('CREATE TRIGGER failure drops this-run tables+triggers only (binlog legacy path)', async () => {
    const { knex, tables, droppedTables, droppedTriggers } = makeFakeKnex({
      tables: new Set(['legacy_keep_me']),
    });
    // Inject trigger failure after tables + first trigger succeed
    let triggerCalls = 0;
    const baseRaw = knex.raw;
    knex.raw = async (sql) => {
      const s = String(sql);
      if (/CREATE\s+TRIGGER/i.test(s)) {
        triggerCalls += 1;
        if (triggerCalls === 1) {
          return baseRaw(sql);
        }
        throw new Error(
          'You do not have the SUPER privilege and binary logging is enabled ' +
            '(you *might* want to use the less safe log_bin_trust_function_creators variable)',
        );
      }
      return baseRaw(sql);
    };

    await assert.rejects(
      () =>
        withPartialDdlCleanup(knex, async (tracker) => {
          await tracker.createTable('organizations', () => {});
          await tracker.createTable('users', () => {});
          await tracker.createTrigger(
            'trg_messages_forbid_update',
            'CREATE TRIGGER trg_messages_forbid_update ...',
          );
          await tracker.createTrigger(
            'trg_messages_forbid_delete',
            'CREATE TRIGGER trg_messages_forbid_delete ...',
          );
        }),
      /SUPER privilege|log_bin_trust_function_creators/,
    );

    // First trigger was recorded then dropped; second never recorded.
    assert.ok(droppedTriggers.includes('trg_messages_forbid_update'));
    assert.equal(tables.has('organizations'), false);
    assert.equal(tables.has('users'), false);
    assert.ok(tables.has('legacy_keep_me'), 'must not drop pre-existing tables');
    // reverse order tables
    assert.deepEqual(droppedTables, ['users', 'organizations']);
  });
});

describe('orphan partial schema gate', () => {
  it('passes on empty schema', async () => {
    const { knex } = makeFakeKnex();
    const report = await inspectOrphanPartialSchema(knex);
    assert.deepEqual(report.orphanTables, []);
    await assertNoOrphanPartialSchema(knex);
  });

  it('passes when core tables exist and migration is recorded', async () => {
    const { knex, tables } = makeFakeKnex({
      migrations: [CORE_MIGRATION_NAME],
    });
    tables.add('knex_migrations');
    tables.add('organizations');
    tables.add('users');
    const report = await inspectOrphanPartialSchema(knex);
    assert.deepEqual(report.orphanTables, []);
    await assertNoOrphanPartialSchema(knex);
  });

  it('fail-closed when organizations exists without core migration row', async () => {
    const { knex, tables } = makeFakeKnex({ migrations: [] });
    // knex_migrations may be absent entirely after a failed first migrate
    tables.add('organizations');
    tables.add('users');

    const report = await inspectOrphanPartialSchema(knex);
    assert.ok(report.orphanTables.includes('organizations'));
    assert.ok(report.missingMigrations.includes(CORE_MIGRATION_NAME));

    await assert.rejects(
      () => assertNoOrphanPartialSchema(knex),
      (err) => {
        assert.ok(err instanceof MysqlOrphanSchemaError);
        assert.equal(err.code, 'MYSQL_ORPHAN_SCHEMA');
        assert.match(err.message, /Orphan MySQL schema/i);
        assert.match(err.message, /mysql-partial-migration-recovery/);
        assert.ok(err.orphanTables.includes('organizations'));
        return true;
      },
    );
  });

  it('fail-closed for external_refs without 00003 migration', async () => {
    const { knex, tables } = makeFakeKnex({
      migrations: [CORE_MIGRATION_NAME],
    });
    tables.add('knex_migrations');
    tables.add('organization_external_refs');

    await assert.rejects(
      () => assertNoOrphanPartialSchema(knex),
      /organization_external_refs|20260718000003/,
    );
  });

  it('does not auto-drop when asserting orphan (gate is read-only)', async () => {
    const { knex, tables, droppedTables } = makeFakeKnex();
    tables.add('organizations');
    try {
      await assertNoOrphanPartialSchema(knex);
    } catch {
      // expected
    }
    assert.ok(tables.has('organizations'));
    assert.deepEqual(droppedTables, []);
  });
});
