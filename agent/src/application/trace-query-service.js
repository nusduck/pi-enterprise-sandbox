/** Owner-scoped durable Trace query service (MySQL is the restart authority). */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { assertUlid, isLegacyOrUuidIdentity } from '../domain/shared/ulid.js';
import {
  normalizeTraceId,
  normalizeSpanId,
} from '../infrastructure/mysql/repositories/trace-span-repository.js';

export class TraceQueryService {
  /**
   * @param {{ createRepositories: (db?: any) => any, db?: any, defaultProvider?: string }} deps
   */
  constructor(deps) {
    if (typeof deps?.createRepositories !== 'function') {
      throw new Error('TraceQueryService requires createRepositories');
    }
    this.createRepositories = deps.createRepositories;
    this.db = deps.db ?? null;
    this.defaultProvider = deps.defaultProvider;
  }

  async #owner(auth, repos) {
    if (!auth) throw new ValidationError('auth is required');
    const resolver = new ExternalIdentityResolver(
      {
        organizations: repos.organizations,
        externalRefs: repos.externalRefs,
      },
      { defaultProvider: this.defaultProvider },
    );
    try {
      return await resolver.resolveOwner(auth);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) {
        throw new OwnerScopedNotFoundError('Trace not found', {
          resource: 'trace_spans',
        });
      }
      throw err;
    }
  }

  async #loadRun(runIdRaw, auth) {
    if (typeof runIdRaw !== 'string' || !runIdRaw.trim()) {
      throw new ValidationError('runId is required');
    }
    if (isLegacyOrUuidIdentity(runIdRaw)) {
      throw new OwnerScopedNotFoundError('Trace not found', {
        resource: 'trace_spans',
        id: runIdRaw,
      });
    }
    let runId;
    try {
      runId = assertUlid(runIdRaw, 'runId');
    } catch {
      throw new OwnerScopedNotFoundError('Trace not found', {
        resource: 'trace_spans',
        id: runIdRaw,
      });
    }
    const repos = this.createRepositories(this.db);
    const owner = await this.#owner(auth, repos);
    const scope = { orgId: owner.orgId, userId: owner.userId };
    const run = await repos.runs.getById(runId, scope);
    if (!run) {
      throw new OwnerScopedNotFoundError('Trace not found', {
        resource: 'trace_spans',
        id: runId,
      });
    }
    return { run, scope, repos, runId };
  }

  /**
   * Return the complete owner-scoped tree for one Run. Calling this after a
   * worker restart is safe: materializeRunFacts reads only durable MySQL rows
   * and upserts deterministic span identities.
   */
  async listForRun({ runId, auth, limit = 500, cursor = null }) {
    const { run, scope, repos, runId: id } = await this.#loadRun(runId, auth);
    await repos.traceSpans.materializeRunFacts(run, scope);
    let normalizedCursor = null;
    if (cursor != null && cursor !== '') {
      try {
        normalizedCursor = normalizeSpanId(cursor);
      } catch {
        throw new ValidationError('cursor must be a non-zero W3C span id');
      }
    }
    const page = await repos.traceSpans.listByRun(
      id,
      normalizeTraceId(run.traceId),
      scope,
      { limit, cursor: normalizedCursor, includePageInfo: true },
    );
    // Keep compatibility with an older injected repository while making the
    // HTTP contract explicit for the current implementation.
    const spans = Array.isArray(page) ? page : page.spans;
    const truncated = Array.isArray(page) ? false : page.truncated === true;
    const nextCursor = Array.isArray(page) ? null : page.nextCursor ?? null;
    return {
      traceId: normalizeTraceId(run.traceId),
      trace_id: normalizeTraceId(run.traceId),
      runId: id,
      run_id: id,
      spans,
      truncated,
      nextCursor,
      next_cursor: nextCursor,
    };
  }

  /** Query by trace id while still requiring an owner and an owned Run. */
  async listByTrace({ traceId: rawTraceId, auth, limit = 500 }) {
    let traceId;
    try {
      traceId = normalizeTraceId(rawTraceId);
    } catch {
      throw new ValidationError('traceId must be a non-zero W3C trace id');
    }
    if (!auth) throw new ValidationError('auth is required');
    const repos = this.createRepositories(this.db);
    const owner = await this.#owner(auth, repos);
    const scope = { orgId: owner.orgId, userId: owner.userId };
    const rows = await repos.runs.listByTraceId?.(traceId, scope, { limit: 2 });
    const run = Array.isArray(rows) ? rows[0] : null;
    if (!run) {
      throw new OwnerScopedNotFoundError('Trace not found', {
        resource: 'trace_spans',
        id: traceId,
      });
    }
    return this.listForRun({ runId: run.runId, auth, limit });
  }
}
