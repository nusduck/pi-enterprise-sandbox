/**
 * User-installed skills as durable bundles instead of shared-filesystem state.
 *
 * Today a user's installed skills live only on a volume that several Agent
 * worker pods write to concurrently, which forces ReadWriteMany — the single
 * storage constraint left in the Kubernetes deployment — and leaves the content
 * with no authority: if the volume is lost or two workers race, nothing can say
 * what a user actually had installed.
 *
 * Storing the bundle here makes MySQL that authority. Each pod materialises a
 * local read-only copy from it, so the filesystem becomes a cache that can be
 * rebuilt rather than state that must be preserved.
 *
 * The blob is a gzipped tar of the skill package directory. MEDIUMBLOB caps a
 * single skill at 16 MiB; skills are documentation and small scripts, and a
 * skill approaching that size is a packaging mistake worth failing on.
 */

export const UK_USER_SKILL_OWNER_NAME = 'uk_user_skill_owner_name';
export const IDX_USER_SKILLS_OWNER = 'idx_user_skills_owner';

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.raw('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');

  await knex.schema.createTable('user_skills', (t) => {
    t.engine('InnoDB');
    t.charset('utf8mb4');
    t.collate('utf8mb4_unicode_ci');

    t.specificType('user_skill_id', 'CHAR(26)').primary();
    t.specificType('org_id', 'CHAR(26)').notNullable();
    t.specificType('user_id', 'CHAR(26)').notNullable();
    // Skill package name. Already constrained to a safe directory-name shape
    // by the installer; the length here matches that validator.
    t.string('skill_name', 128).notNullable();

    // Gzipped tar of the package directory.
    t.specificType('bundle', 'MEDIUMBLOB').notNullable();
    // Content digest. A pod materialises only when its local copy differs, so
    // this is what keeps a warm cache from re-extracting on every run.
    t.specificType(
      'sha256',
      'CHAR(64) CHARACTER SET ascii COLLATE ascii_bin',
    ).notNullable();
    t.bigInteger('size_bytes').notNullable();

    // Provenance, for auditing what a user installed and from where.
    t.string('source_type', 32).nullable();
    t.string('source', 1024).nullable();
    t.string('resolved_commit', 128).nullable();

    t.specificType('created_at', 'DATETIME(3)').notNullable();
    t.specificType('updated_at', 'DATETIME(3)').notNullable();

    // One row per (owner, skill name): installing again replaces in place,
    // which is what the filesystem install already did atomically.
    t.unique(['org_id', 'user_id', 'skill_name'], {
      indexName: UK_USER_SKILL_OWNER_NAME,
    });
    // Materialisation lists every skill for one owner.
    t.index(['org_id', 'user_id', 'updated_at'], IDX_USER_SKILLS_OWNER);

    t.foreign('org_id').references('organizations.org_id');
    t.foreign('user_id').references('users.user_id');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('user_skills');
}
