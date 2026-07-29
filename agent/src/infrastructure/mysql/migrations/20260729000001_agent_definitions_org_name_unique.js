/**
 * Harden concurrent tenant-default agent creation (triage A3).
 *
 * agent_definitions previously only indexed (org_id, status) non-uniquely, so
 * two concurrent first-time CreateRun paths for a new org could insert two
 * "default" definitions when the advisory FOR UPDATE lock was skipped. A
 * UNIQUE(org_id, name) constraint makes that race fail closed at the storage
 * layer; ensureTenantDefaultAgent already re-reads on ConflictError.
 */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('agent_definitions', (t) => {
    t.unique(['org_id', 'name'], {
      indexName: 'uk_agent_definitions_org_name',
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('agent_definitions', (t) => {
    t.dropUnique(['org_id', 'name'], 'uk_agent_definitions_org_name');
  });
}
