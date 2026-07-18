/**
 * Ownership filter helpers for multi-tenant repository queries.
 */

/**
 * @typedef {{ orgId: string, userId: string }} OwnerScope
 */

/**
 * @param {Partial<OwnerScope> | null | undefined} scope
 * @returns {OwnerScope}
 */
export function requireOwnerScope(scope) {
  const orgId = scope?.orgId != null ? String(scope.orgId).trim() : '';
  const userId = scope?.userId != null ? String(scope.userId).trim() : '';
  if (!orgId || !userId) {
    throw new Error(
      'Owner scope requires non-empty orgId and userId (plan §31.11)',
    );
  }
  return { orgId, userId };
}

/**
 * Apply org_id + user_id equality filters to a knex query builder.
 * @param {import('knex').Knex.QueryBuilder} query
 * @param {OwnerScope} scope
 * @param {{ orgColumn?: string, userColumn?: string }} [cols]
 */
export function applyOwnerScope(query, scope, cols = {}) {
  const orgColumn = cols.orgColumn || 'org_id';
  const userColumn = cols.userColumn || 'user_id';
  return query.where(orgColumn, scope.orgId).andWhere(userColumn, scope.userId);
}
