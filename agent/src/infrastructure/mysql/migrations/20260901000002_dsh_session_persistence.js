/** Native DSH session header/event log used by ctx.sessionPersistence. */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const DSH_SESSIONS_TABLE = 'dsh_sessions';
export const DSH_SESSION_EVENTS_TABLE = 'dsh_session_events';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(DSH_SESSIONS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('session_id', 'CHAR(26)').notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.json('header_json').notNullable();
      t.string('revision', 128).notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));
      t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));
      t.primary(['session_id'], 'pk_dsh_sessions');
      t.index(['org_id', 'user_id', 'session_id'], 'idx_dsh_sessions_owner');
    });
    await tracker.createTable(DSH_SESSION_EVENTS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.specificType('session_id', 'CHAR(26)').notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.specificType('seq', 'BIGINT UNSIGNED').notNullable();
      t.json('record_json').notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));
      t.primary(['session_id', 'seq'], 'pk_dsh_session_events');
      t.index(['org_id', 'user_id', 'session_id', 'seq'], 'idx_dsh_session_events_owner');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(DSH_SESSION_EVENTS_TABLE);
  await knex.schema.dropTableIfExists(DSH_SESSIONS_TABLE);
}
