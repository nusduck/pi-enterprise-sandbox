/**
 * PR-04 T1: Run authority compatibility tables.
 *
 * Additive mapping so existing BFF/Sandbox external UUID/string identities
 * resolve to plan CHAR(26) ULIDs without storing UUIDs in domain id columns:
 *
 * - organization_external_refs(provider, external_subject) → org_id
 * - conversation_external_refs(org_id, user_id, provider, external_subject)
 *     → conversation_id
 *
 * User mapping continues to use users.external_subject with an explicit
 * provider prefix (application convention; no schema change required).
 *
 * utf8mb4 / InnoDB, bounded columns, unique keys, FKs, reversible down.
 * Composite primary: string constraint names only (no {indexName} options —
 * Knex MySQL create path emits illegal `as indexName` SQL for objects).
 * Partial DDL cleanup: withPartialDdlCleanup drops only this-run tables.
 *
 * Does not provision full conversation/session/agent parent graph or HTTP.
 *
 * @param {import('knex').Knex} knex
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const ORG_EXTERNAL_REFS_TABLE = 'organization_external_refs';
export const CONV_EXTERNAL_REFS_TABLE = 'conversation_external_refs';

/** Column bounds (must match ExternalReferenceRepository validators). */
export const EXTERNAL_PROVIDER_MAX_LEN = 64;
export const EXTERNAL_SUBJECT_MAX_LEN = 255;

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await tracker.createTable(ORG_EXTERNAL_REFS_TABLE, (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.string('provider', EXTERNAL_PROVIDER_MAX_LEN).notNullable();
    t.string('external_subject', EXTERNAL_SUBJECT_MAX_LEN).notNullable();
    // Domain id is always plan CHAR(26) ULID — never store UUID here.
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.primary(['provider', 'external_subject'], 'pk_organization_external_refs');
    t.index(['org_id'], 'idx_org_external_refs_org');
    t.foreign('org_id')
      .references('organizations.org_id')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });

  await tracker.createTable(CONV_EXTERNAL_REFS_TABLE, (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    t.string('provider', EXTERNAL_PROVIDER_MAX_LEN).notNullable();
    t.string('external_subject', EXTERNAL_SUBJECT_MAX_LEN).notNullable();
    t.specificType('conversation_id', 'CHAR(26)').notNullable();
    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.primary(
      ['org_id', 'user_id', 'provider', 'external_subject'],
      'pk_conversation_external_refs',
    );
    t.index(['conversation_id'], 'idx_conv_external_refs_conversation');
    t.foreign('org_id')
      .references('organizations.org_id')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
    t.foreign('user_id')
      .references('users.user_id')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
    t.foreign('conversation_id')
      .references('conversations.conversation_id')
      .onDelete('RESTRICT')
      .onUpdate('RESTRICT');
  });
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  // Child mapping tables first (FK-safe reverse of up).
  await knex.schema.dropTableIfExists(CONV_EXTERNAL_REFS_TABLE);
  await knex.schema.dropTableIfExists(ORG_EXTERNAL_REFS_TABLE);
}
