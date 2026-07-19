/** Persist the W3C sampling decision across durable Run recovery boundaries. */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('runs', (table) => {
    table
      .specificType('trace_flags', 'CHAR(2) CHARACTER SET ascii COLLATE ascii_bin')
      .notNullable()
      .defaultTo('01');
    table
      .specificType(
        'trace_parent_span_id',
        'CHAR(16) CHARACTER SET ascii COLLATE ascii_bin',
      )
      .nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('runs', (table) => {
    table.dropColumn('trace_parent_span_id');
    table.dropColumn('trace_flags');
  });
}
