/**
 * GetRunService (PR-04 T2) — read MySQL Run under owner scope only.
 *
 * Resolves trusted external auth → internal owner ULIDs, then loads the Run
 * from MySQL. Unknown/foreign runs return owner-scoped not found (no leak).
 * Immediate GET after Create works without process Map / Sandbox.
 *
 * When the Run is WAITING_INPUT, attaches the oldest pending interaction so
 * browser refresh / GET can rebuild the Composer without relying on SSE alone.
 */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import { RUN_STATUS } from '../domain/run/run-status.js';
import { INTERACTION_STATUS } from '../domain/interaction/interaction-status.js';

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

      const scope = { orgId: owner.orgId, userId: owner.userId };
      const run = await repos.runs.getById(runId, scope);
      if (!run) {
        throw new OwnerScopedNotFoundError('Run not found', {
          resource: 'runs',
          id: runId,
        });
      }

      // Attach sandbox_session_id from AgentSession so browser download/export
      // /upload can rehydrate without a separate conversation GET.
      // @ts-expect-error 遗留JS占位类型object未展开，访问sessions需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'sessions' does not exist on type '{ organizations:
      if (run.agentSessionId && repos.sessions?.getById) {
        try {
          // @ts-expect-error 遗留JS占位类型object未展开，访问sessions需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'sessions' does not exist on type '{ organizations:
          const session = await repos.sessions.getById(run.agentSessionId, scope);
          if (session?.sandboxSessionId) {
            run.sandboxSessionId = session.sandboxSessionId;
          }
          if (session?.workspaceId) {
            run.workspaceId = session.workspaceId;
          }
        } catch {
          // Fail open: Run status remains authoritative; FE may fall back to
          // conversation.sandbox_session_id.
        }
      }

      if (
        run.status === RUN_STATUS.WAITING_INPUT &&
        // @ts-expect-error 遗留JS占位类型object未展开，访问interactions需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'interactions' does not exist on type '{ organizati
        repos.interactions?.getPendingForRun
      ) {
        try {
          // @ts-expect-error 遗留JS占位类型object未展开，访问interactions需收窄，存活代码先用expect-error收敛 —— TS2339: Property 'interactions' does not exist on type '{ organizati
          const pending = await repos.interactions.getPendingForRun(runId, scope);
          if (pending && pending.status === INTERACTION_STATUS.PENDING) {
            const request =
              pending.requestJson && typeof pending.requestJson === 'object'
                ? pending.requestJson
                : {};
            run.pendingInput = {
              interactionId: pending.interactionId,
              interactionType: pending.interactionType,
              title:
                request.title != null
                  ? String(request.title)
                  : request.prompt != null
                    ? String(request.prompt)
                    : 'Input required',
              message:
                request.message != null
                  ? String(request.message)
                  : request.prompt != null
                    ? String(request.prompt)
                    : null,
              options: Array.isArray(request.options)
                ? request.options.map((item) => String(item)).filter(Boolean)
                : [],
              status: pending.status,
            };
          }
        } catch {
          // Fail open on projection: Run status remains authoritative.
        }
      }

      return run;
    };

    if (this.tx?.run) {
      return this.tx.run((trx) => load(trx));
    }
    return load(this.db);
  }
}
