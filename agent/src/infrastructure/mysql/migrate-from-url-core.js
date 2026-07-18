/**
 * Testable control flow for migrateLatestFromUrl (no knex import required).
 *
 * Destroy semantics:
 * - Knex pool is destroyed **at most once** (success path when destroy=true,
 *   or failure path always).
 * - If destroy fails after a migrate error, both errors are reported via
 *   AggregateError so the original migration error is never masked.
 *
 * @param {{
 *   createKnex: (url: string) => import('knex').Knex,
 *   destroyKnex: (knex: import('knex').Knex) => Promise<void>,
 *   migrateLatest: (knex: import('knex').Knex) => Promise<[number, string[]]>,
 *   connectionUrl: string,
 *   opts?: { destroy?: boolean },
 * }} deps
 * @returns {Promise<{ result: [number, string[]], knex?: import('knex').Knex }>}
 */
export async function runMigrateLatestFromUrl(deps) {
  const destroy = deps.opts?.destroy !== false;
  const knex = deps.createKnex(deps.connectionUrl);
  let destroyed = false;

  /**
   * Destroy exactly once. Subsequent calls are no-ops.
   * @returns {Promise<void>}
   */
  async function destroyOnce() {
    if (destroyed) return;
    destroyed = true;
    await deps.destroyKnex(knex);
  }

  try {
    const result = await deps.migrateLatest(knex);
    if (destroy) {
      await destroyOnce();
      return { result };
    }
    return { knex, result };
  } catch (err) {
    // Always release the pool on failure (even when destroy=false), exactly once.
    try {
      await destroyOnce();
    } catch (destroyErr) {
      throw new AggregateError(
        [err, destroyErr],
        'Migration failed and knex cleanup also failed',
      );
    }
    throw err;
  }
}
