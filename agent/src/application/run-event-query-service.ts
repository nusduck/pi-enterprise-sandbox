/**
 * Durable RunEvent history query (PR-04 T4 + PR-10 Last-Event-ID).
 *
 * MySQL is the fact source. Redis live gap-free cutover lives in
 * {@link RunEventSseService} (PR-10). Browser disconnect must only stop
 * polling / SSE subscription — never cancel the Run.
 */

import { ExternalIdentityResolver } from './parent/external-identity-resolver.js';
import { OwnerScopedNotFoundError, ValidationError } from './errors.js';
import { assertUlid, isLegacyOrUuidIdentity, isUlid } from '../domain/shared/ulid.js';
import { isTerminalRunStatus } from '../domain/run/run-status.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/**
 * Project a durable run_events row to the SSE envelope used by BFF/frontend:
 * `{ sequence, event, ts, eventId, event_id }` where event carries platform
 * type + payload fields. Top-level eventId supports Last-Event-ID resume.
 *
 * @param row — mapped RunEvent
 * @returns {{ sequence: number, event: object, ts: number, eventId?: string, event_id?: string }}
 */
export function projectRunEventToSseEnvelope(row: Record<string, any>) {
  const sequence = Number(row.sequenceNo);
  const payload =
    row.payloadJson && typeof row.payloadJson === 'object'
      ? { ...row.payloadJson }
      : {};
  const eventId = row.eventId ? String(row.eventId) : null;
  // One spelling per field on the wire: `type` + snake_case `event_id`, matching
  // the rest of the public contract (run_id, session_id, created_at).
  const event = {
    type: row.eventType,
    ...(eventId ? { event_id: eventId } : {}),
    ...payload,
  };
  // Prefer durable row type over any payload collision.
  event.type = row.eventType;
  if (eventId) event.event_id = eventId;
  // Do not re-run a status machine here — payload status is already durable.
  const ts = row.createdAt ? Date.parse(row.createdAt) : Date.now();
  return {
    sequence,
    event,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    ...(eventId ? { event_id: eventId } : {}),
  };
}

export class RunEventQueryService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  createRepositories: Loose;
  db: Loose;
  defaultProvider: Loose;

  /**
   * @param {{
   *   createRepositories: (db?: any) => {
   *     organizations: any,
   *     externalRefs: any,
   *     runs: any,
   *     runEvents: any,
   *   },
   *   db?: any,
   *   defaultProvider?: string,
   * }} deps
   */
  constructor(deps: { createRepositories: (db?: any) => { organizations: any, externalRefs: any, runs: any, runEvents: any, }, db?: any, defaultProvider?: string, }) {
    if (typeof deps?.createRepositories !== 'function') {
      throw new Error('RunEventQueryService requires createRepositories');
    }
    this.createRepositories = deps.createRepositories;
    this.db = deps.db ?? null;
    this.defaultProvider = deps.defaultProvider;
  }

  /**
   * @param runIdRaw
   * @returns {string}
   */
  #requireRunUlid(runIdRaw: string) {
    if (typeof runIdRaw !== 'string' || !runIdRaw.trim()) {
      throw new ValidationError('runId is required');
    }
    if (isLegacyOrUuidIdentity(runIdRaw)) {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: runIdRaw,
      });
    }
    try {
      return assertUlid(runIdRaw, 'runId');
    } catch {
      throw new OwnerScopedNotFoundError('Run not found', {
        resource: 'runs',
        id: runIdRaw,
      });
    }
  }

  /**
   * Resolve trusted external subjects → internal owner scope, then load run.
   * Cross-tenant / unknown run → OwnerScopedNotFoundError (404).
   *
   * @param runId
   * @param auth
   * @returns {Promise<{ run: object, scope: { orgId: string, userId: string }, repos: object }>}
   */
  async #loadOwnedRun(runId: string, auth: { provider?: string, externalOrgId: string, externalUserId: string }) {
    if (!auth) throw new ValidationError('auth is required');
    const repos = this.createRepositories(this.db);
    const resolver = new ExternalIdentityResolver(
      {
        organizations: repos.organizations,
        externalRefs: repos.externalRefs,
      },
      { defaultProvider: this.defaultProvider },
    );

    let owner;
    try {
      owner = await resolver.resolveOwner(auth);
    } catch (err) {
      if (err instanceof OwnerScopedNotFoundError) {
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
    return { run, scope, repos };
  }

  /**
   * Map Last-Event-ID (ULID) → durable sequence for resume.
   * Returns null when the event is not found under owner scope (caller keeps afterSequence).
   *
   * @param {{
   *   runId: string,
   *   auth: { provider?: string, externalOrgId: string, externalUserId: string },
   *   eventId: string,
   * }} input
   * @returns {Promise<number|null>}
   */
  async resolveEventSequence(input: { runId: string, auth: { provider?: string, externalOrgId: string, externalUserId: string }, eventId: string, }) {
    if (!input?.auth) throw new ValidationError('auth is required');
    const runId = this.#requireRunUlid(input.runId);
    if (typeof input.eventId !== 'string' || !isUlid(input.eventId)) {
      return null;
    }
    const eventId = assertUlid(input.eventId, 'eventId');
    const { scope, repos } = await this.#loadOwnedRun(runId, input.auth);
    const row = await repos.runEvents.getById(eventId, scope);
    if (!row) return null;
    // Event must belong to this run (getById is owner-scoped, not run-scoped).
    if (String(row.runId).toUpperCase() !== runId) {
      return null;
    }
    const seq = Number(row.sequenceNo);
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: { provider?: string, externalOrgId: string, externalUserId: string },
   *   afterSequence?: number,
   *   limit?: number,
   * }} input
   */
  async listEvents(input: { runId: string, auth: { provider?: string, externalOrgId: string, externalUserId: string }, afterSequence?: number, limit?: number, }) {
    if (!input?.auth) throw new ValidationError('auth is required');
    const runId = this.#requireRunUlid(input.runId);
    const { run, scope, repos } = await this.#loadOwnedRun(runId, input.auth);

    const after = Math.max(0, Number(input.afterSequence) || 0);
    const limit = Math.min(500, Math.max(1, Number(input.limit) || 200));
    const rows = await repos.runEvents.listByRun(runId, scope, {
      afterSequence: after,
      limit,
    });

    return {
      run,
      events: rows.map(projectRunEventToSseEnvelope),
      terminal: isTerminalRunStatus(run.status),
      status: run.status,
    };
  }
}
