/**
 * PR-03: extend domain_outbox for crash-safe concurrent publishing.
 *
 * Base columns (plan §8.17 / PR-02) are preserved:
 *   outbox_id, aggregate_type, aggregate_id, event_type, payload_json,
 *   status, attempts, created_at, published_at
 *
 * Delivery columns:
 *   claim_token     — unique per claim; guards markPublished / retry / fail
 *   claimed_at      — when PUBLISHING started (stale reclaim)
 *   next_attempt_at — backoff gate for PENDING rows (NULL = due immediately)
 *   last_error      — bounded, sanitized last publish error
 *
 * Index strategy:
 *   Replace idx_outbox_pending (status, created_at) with idx_outbox_claim
 *   (status, next_attempt_at, created_at) so claimBatch can filter
 *   status=PENDING AND (next_attempt_at IS NULL OR next_attempt_at <= now)
 *   ORDER BY created_at under SKIP LOCKED.
 *   Add idx_outbox_stale_claim (status, claimed_at) for reclaim of stuck
 *   PUBLISHING rows after worker crash.
 *
 * @param {import('knex').Knex} knex
 */

/** Max stored length for last_error (repository also sanitizes to this bound). */
export const OUTBOX_LAST_ERROR_MAX_LEN = 512;

/**
 * @param {import('knex').Knex} knex
 */
export async function up(knex) {
  await knex.schema.alterTable('domain_outbox', (t) => {
    t.specificType('claim_token', 'CHAR(26)').nullable();
    t.specificType('claimed_at', 'DATETIME(3)').nullable();
    t.specificType('next_attempt_at', 'DATETIME(3)').nullable();
    t.string('last_error', OUTBOX_LAST_ERROR_MAX_LEN).nullable();
  });

  // Replace pending poll index with claim-oriented composite.
  await knex.schema.alterTable('domain_outbox', (t) => {
    t.dropIndex(['status', 'created_at'], 'idx_outbox_pending');
    t.index(
      ['status', 'next_attempt_at', 'created_at'],
      'idx_outbox_claim',
    );
    t.index(['status', 'claimed_at'], 'idx_outbox_stale_claim');
  });
}

/**
 * @param {import('knex').Knex} knex
 */
export async function down(knex) {
  await knex.schema.alterTable('domain_outbox', (t) => {
    t.dropIndex(
      ['status', 'next_attempt_at', 'created_at'],
      'idx_outbox_claim',
    );
    t.dropIndex(['status', 'claimed_at'], 'idx_outbox_stale_claim');
    t.index(['status', 'created_at'], 'idx_outbox_pending');
  });

  await knex.schema.alterTable('domain_outbox', (t) => {
    t.dropColumn('last_error');
    t.dropColumn('next_attempt_at');
    t.dropColumn('claimed_at');
    t.dropColumn('claim_token');
  });
}
