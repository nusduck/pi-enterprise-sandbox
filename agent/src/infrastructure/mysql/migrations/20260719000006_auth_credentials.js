/**
 * Browser auth credentials (Sandbox register/login).
 *
 * Agent `users` rows remain platform identity (ULID + external_subject).
 * Passwords live here, keyed by external username, so Sandbox can issue JWT
 * without stuffing secrets into the platform users table.
 *
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  const has = await knex.schema.hasTable('auth_credentials');
  if (!has) {
    await knex.schema.createTable('auth_credentials', (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');
      t.bigIncrements('id').primary();
      t.string('username', 64).notNullable();
      t.string('password_hash', 255).notNullable();
      t.string('external_user_id', 128).notNullable();
      t.string('external_org_id', 128).notNullable();
      t.string('display_name', 255).nullable();
      t.string('email', 320).nullable();
      t.string('role', 32).notNullable().defaultTo('user');
      t.boolean('is_active').notNullable().defaultTo(true);
      t.specificType('created_at', 'DATETIME(3)').notNullable();
      t.specificType('updated_at', 'DATETIME(3)').notNullable();
      t.specificType('last_login_at', 'DATETIME(3)').nullable();
      t.unique(['username'], { indexName: 'uk_auth_credentials_username' });
      t.unique(['external_user_id'], { indexName: 'uk_auth_credentials_external_user' });
      t.index(['external_org_id'], 'idx_auth_credentials_org');
    });
  }
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('auth_credentials');
}
