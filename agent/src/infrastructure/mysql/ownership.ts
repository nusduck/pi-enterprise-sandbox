/**
 * Ownership filter helpers for multi-tenant repository queries.
 */

export type OwnerScope = {
  orgId: string;
  userId: string;
};

/**
 * @param scope
 * @returns {OwnerScope}
 */
export function requireOwnerScope(scope: Partial<OwnerScope> | null | undefined) {
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
 * @param query
 * @param scope
 * @param [cols]
 */
export function applyOwnerScope(query: import('knex').Knex.QueryBuilder, scope: OwnerScope, cols: { orgColumn?: string, userColumn?: string } = {}) {
  const orgColumn = cols.orgColumn || 'org_id';
  const userColumn = cols.userColumn || 'user_id';
  return query.where(orgColumn, scope.orgId).andWhere(userColumn, scope.userId);
}
