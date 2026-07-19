/** Persist the opaque W3C tracestate across the durable Run/Worker boundary. */

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await knex.schema.alterTable('runs', (t) => {
    // W3C limits the field to 512 printable bytes; ASCII collation keeps the
    // carrier byte-stable while the repository validates its list grammar.
    t.specificType(
      'trace_state',
      'VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin',
    ).nullable();
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.alterTable('runs', (t) => {
    t.dropColumn('trace_state');
  });
}
