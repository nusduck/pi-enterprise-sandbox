/**
 * A2A context_id is an opaque protocol string (not an internal ULID).
 * Widen a2a_tasks.context_id so external clients may use UUID / business IDs.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw(
    'ALTER TABLE `a2a_tasks` MODIFY COLUMN `context_id` VARCHAR(255) NULL',
  );
  // Lookup by external context within client+agent scope (list/filter + multi-turn).
  await knex.raw(
    'CREATE INDEX `idx_a2a_tasks_owner_context` ON `a2a_tasks` (`org_id`, `client_id`, `agent_id`, `context_id`)',
  );
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.raw(
    'DROP INDEX `idx_a2a_tasks_owner_context` ON `a2a_tasks`',
  );
  // Truncate non-ULID values before shrinking is operator responsibility.
  await knex.raw(
    'ALTER TABLE `a2a_tasks` MODIFY COLUMN `context_id` CHAR(26) NULL',
  );
}
