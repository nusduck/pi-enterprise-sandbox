/**
 * GetRunService (PR-04 T2) — read MySQL Run under owner scope only.
 *
 * Resolves trusted external auth → internal owner ULIDs, then loads the Run
 * from MySQL. Unknown/foreign runs return owner-scoped not found (no leak).
 * Immediate GET after Create works without process Map / Sandbox.
 */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';

export class GetRunService {
  /**
   * @param {{
   *   createRepositories: (db?: any) => {
   *     organizations: any,
   *     externalRefs: any,
   *     runs: any,
   *   },
   *   db?: any,
   *   defaultProvider?: string,
   *   transactionManager?: { run: (fn: (trx: any) => Promise<any>) => Promise<any> } | null,
   * }} deps
   */
  constructor(deps) {
    if (typeof deps?.createRepositories !== 'function') {
      throw new Error('GetRunService requires createRepositories');
    }
    this.createRepositories = deps.createRepositories;
    this.db = deps.db ?? null;
    this.defaultProvider = deps.defaultProvider;
    this.tx = deps.transactionManager ?? null;
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: {
   *     provider?: string,
   *     externalOrgId: string,
   *     externalUserId: string,
   *   },
   * }} input
   */
  async execute(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('GetRun input is required');
    }
    if (typeof input.runId !== 'string' || !input.runId.trim()) {
      throw new ValidationError('runId is required');
    }
    if (isLegacyOrUuidIdentity(input.runId)) {
      // External/legacy ids are never domain run ids — owner-scoped not found.
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    let runId;
    try {
      runId = assertUlid(input.runId, 'runId');
    } catch {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: input.runId,
      });
    }
    if (!input.auth) {
      throw new ValidationError('auth (trusted external subjects) is required');
    }

    const load = async (db) => {
      const repos = this.createRepositories(db);
      const resolver = new ExternalIdentityResolver(
        {
          organizations: repos.organizations,
          externalRefs: repos.externalRefs,
        },
        { defaultProvider: this.defaultProvider },
      );

      let owner;
      try {
        owner = await resolver.resolveOwner(input.auth);
      } catch (err) {
        if (err instanceof OwnerScopedNotFoundError) {
          // Map missing parent as run not found for cross-tenant uniformity.
          throw new OwnerScopedNotFoundError('Run not found', {
            resource: 'runs',
            id: runId,
          });
        }
        throw err;
      }

      const run = await repos.runs.getById(runId, {
        orgId: owner.orgId,
        userId: owner.userId,
      });
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }
      return run;
    };

    if (this.tx?.run) {
      return this.tx.run((trx) => load(trx));
    }
    return load(this.db);
  }
}
