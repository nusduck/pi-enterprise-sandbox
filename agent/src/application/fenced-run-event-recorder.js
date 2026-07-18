/**
 * FencedRunEventRecorder — sole durability owner for Run events (plan §15.3).
 *
 * Each record() runs in one MySQL transaction:
 *   1. assert ACTIVE + executionFenceToken
 *   2. append run_events
 *   3. append domain_outbox
 * External emit only after commit (no ghost events on rollback).
 *
 * Dedupe keys use pending/serialized CAS: concurrent same-key writers
 * collapse to one durable row; failed writers release the pending slot so
 * retries can succeed.
 */

import { assertUlid } from '../domain/shared/ulid.js';
import { SessionFenceConflictError } from '../domain/session/errors.js';
import { AGGREGATE_TYPE_RUN } from '../infrastructure/outbox/outbox-status.js';
import {
  redactPayload,
  redactInlineSecrets,
} from '../infrastructure/pi/platform-event-projector.js';
import { createPromiseTail } from './promise-tail.js';

/**
 * @typedef {{
 *   orgId: string,
 *   userId: string,
 *   conversationId: string,
 *   agentSessionId: string,
 *   runId: string,
 *   traceId: string,
 *   sandboxSessionId?: string | null,
 * }} RunEventContext
 */

/**
 * @typedef {{
 *   eventId: string,
 *   eventVersion: number,
 *   sequence: number,
 *   type: string,
 *   timestamp: string,
 *   context: {
 *     orgId: string,
 *     userId: string,
 *     conversationId: string,
 *     agentSessionId: string,
 *     runId: string,
 *     traceId: string,
 *     spanId: string | null,
 *   },
 *   data: Record<string, unknown>,
 * }} CanonicalRunEventEnvelope
 */

/**
 * Build plan §15.3 envelope (pure).
 *
 * @param {{
 *   eventId: string,
 *   sequence: number,
 *   type: string,
 *   timestamp: string | Date,
 *   context: RunEventContext & { spanId?: string | null },
 *   data?: Record<string, unknown>,
 *   eventVersion?: number,
 * }} input
 * @returns {CanonicalRunEventEnvelope}
 */
export function buildCanonicalEnvelope(input) {
  const ts =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : String(input.timestamp);
  const ctx = input.context;
  return Object.freeze({
    eventId: String(input.eventId),
    eventVersion: input.eventVersion ?? 1,
    sequence: Number(input.sequence),
    type: String(input.type),
    timestamp: ts,
    context: Object.freeze({
      orgId: String(ctx.orgId),
      userId: String(ctx.userId),
      conversationId: String(ctx.conversationId),
      agentSessionId: String(ctx.agentSessionId),
      runId: String(ctx.runId),
      traceId: String(ctx.traceId ?? ''),
      spanId: ctx.spanId != null ? String(ctx.spanId) : null,
    }),
    data: Object.freeze(
      input.data && typeof input.data === 'object' && !Array.isArray(input.data)
        ? { ...input.data }
        : {},
    ),
  });
}

/**
 * Redact event data for durable storage (secrets never stored).
 * @param {unknown} data
 * @returns {Record<string, unknown>}
 */
export function redactEventData(data) {
  if (data == null) return {};
  if (typeof data === 'string') {
    return { text: redactInlineSecrets(data) };
  }
  const redacted = redactPayload(data);
  if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
    return /** @type {Record<string, unknown>} */ (redacted);
  }
  return { value: redacted };
}

export class FencedRunEventRecorder {
  /**
   * @param {{
   *   transactionManager: { run: (fn: (trx: any) => Promise<any>) => Promise<any> },
   *   createRepositories: (db: any) => any,
   *   generateId: () => string,
   *   context: RunEventContext,
   *   executionFenceToken: number,
   *   now?: () => Date,
   *   emit?: ((envelope: CanonicalRunEventEnvelope) => Promise<void> | void) | null,
   *   isLockLost?: () => boolean,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.transactionManager?.run) {
      throw new Error('FencedRunEventRecorder requires transactionManager');
    }
    if (typeof deps.createRepositories !== 'function') {
      throw new Error('FencedRunEventRecorder requires createRepositories');
    }
    if (typeof deps.generateId !== 'function') {
      throw new Error('FencedRunEventRecorder requires generateId');
    }
    if (!deps.context?.runId || !deps.context?.agentSessionId) {
      throw new Error('FencedRunEventRecorder requires run context');
    }
    if (
      deps.executionFenceToken == null ||
      !Number.isFinite(Number(deps.executionFenceToken))
    ) {
      throw new Error('FencedRunEventRecorder requires executionFenceToken');
    }

    this.tx = deps.transactionManager;
    this.createRepositories = deps.createRepositories;
    this.generateId = deps.generateId;
    this.context = Object.freeze({ ...deps.context });
    this.executionFenceToken = Number(deps.executionFenceToken);
    this.now = deps.now ?? (() => new Date());
    this.emit = typeof deps.emit === 'function' ? deps.emit : null;
    this.isLockLost = deps.isLockLost ?? (() => false);

    /** @type {Set<string>} committed successful dedupe keys */
    this._seenDedupeKeys = new Set();
    /**
     * In-flight dedupe CAS: key → Promise resolving to envelope | null.
     * Losers await the winner; failure deletes the pending entry for retry.
     * @type {Map<string, Promise<CanonicalRunEventEnvelope | null>>}
     */
    this._pendingDedupe = new Map();
    this._tail = createPromiseTail();
    this._sequenceHint = 0;
  }

  /**
   * Sequential enqueue (same ordering as PiRunExecutor event tail).
   * @param {() => Promise<void>} fn
   */
  enqueue(fn) {
    return this._tail.enqueue(fn);
  }

  async flush() {
    await this._tail.flush();
  }

  /**
   * Claim a dedupe key (CAS). Returns:
   * - { kind: 'duplicate' } if already committed
   * - { kind: 'join', promise } if another writer is in flight
   * - { kind: 'owner', release } if this caller owns the write
   *
   * @param {string} key
   */
  #claimDedupeKey(key) {
    if (this._seenDedupeKeys.has(key)) {
      return { kind: /** @type {const} */ ('duplicate') };
    }
    const pending = this._pendingDedupe.get(key);
    if (pending) {
      return { kind: /** @type {const} */ ('join'), promise: pending };
    }

    /** @type {{ resolve: (v: CanonicalRunEventEnvelope | null) => void }} */
    const gate = { resolve: () => {} };
    /** @type {Promise<CanonicalRunEventEnvelope | null>} */
    const promise = new Promise((resolve) => {
      gate.resolve = resolve;
    });
    this._pendingDedupe.set(key, promise);

    return {
      kind: /** @type {const} */ ('owner'),
      /**
       * @param {CanonicalRunEventEnvelope | null} result
       * @param {{ success: boolean }} meta
       */
      release: (result, meta) => {
        if (meta.success && result) {
          this._seenDedupeKeys.add(key);
        }
        // Always drop pending so failures can retry.
        this._pendingDedupe.delete(key);
        gate.resolve(result);
      },
    };
  }

  /**
   * Record one platform event under the execution fence.
   *
   * @param {{
   *   type: string,
   *   data?: Record<string, unknown>,
   *   dedupeKey?: string | null,
   *   spanId?: string | null,
   * }} input
   * @returns {Promise<CanonicalRunEventEnvelope | null>} null when deduped
   */
  async record(input) {
    if (!input?.type || typeof input.type !== 'string') {
      throw new Error('FencedRunEventRecorder.record requires type');
    }
    if (this.isLockLost()) {
      throw new SessionFenceConflictError(
        'session lock lost; refusing durable event write',
        {
          agentSessionId: this.context.agentSessionId,
          expectedToken: this.executionFenceToken,
        },
      );
    }

    const dedupeKey =
      typeof input.dedupeKey === 'string' && input.dedupeKey
        ? input.dedupeKey
        : null;

    /** @type {null | { release: (r: any, m: { success: boolean }) => void }} */
    let claim = null;
    if (dedupeKey) {
      const c = this.#claimDedupeKey(dedupeKey);
      if (c.kind === 'duplicate') return null;
      if (c.kind === 'join') {
        return c.promise;
      }
      claim = c;
    }

    try {
      const data = redactEventData(input.data ?? {});
      const spanId = input.spanId ?? null;
      const timestamp = this.now();
      const eventId = assertUlid(this.generateId(), 'eventId');
      const outboxId = assertUlid(this.generateId(), 'outboxId');

      /** @type {CanonicalRunEventEnvelope | null} */
      let envelope = null;

      await this.tx.run(async (trx) => {
        const repos = this.createRepositories(trx);
        await repos.sessions.assertExecutionFence(
          this.context.agentSessionId,
          {
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
          this.executionFenceToken,
          { forUpdate: true, requireActive: true },
        );

        const stored = await repos.runEvents.append({
          eventId,
          runId: this.context.runId,
          orgId: this.context.orgId,
          userId: this.context.userId,
          eventType: input.type,
          eventVersion: 1,
          payloadJson: {
            context: {
              orgId: this.context.orgId,
              userId: this.context.userId,
              conversationId: this.context.conversationId,
              agentSessionId: this.context.agentSessionId,
              runId: this.context.runId,
              traceId: this.context.traceId,
              spanId,
            },
            data,
          },
          traceId: this.context.traceId,
          spanId,
          createdAt: timestamp,
        });

        envelope = buildCanonicalEnvelope({
          eventId: stored.eventId,
          sequence: stored.sequenceNo,
          type: input.type,
          timestamp,
          context: {
            ...this.context,
            spanId,
          },
          data,
          eventVersion: 1,
        });

        await repos.outbox.insert({
          outboxId,
          aggregateType: AGGREGATE_TYPE_RUN,
          aggregateId: this.context.runId,
          eventType: input.type,
          payloadJson: {
            eventId: envelope.eventId,
            eventVersion: envelope.eventVersion,
            sequence: envelope.sequence,
            type: envelope.type,
            timestamp: envelope.timestamp,
            context: envelope.context,
            data: envelope.data,
            runId: this.context.runId,
            orgId: this.context.orgId,
            userId: this.context.userId,
          },
        });
      });

      // Commit succeeded — mark dedupe (via claim release) and emit externally.
      if (claim) {
        claim.release(envelope, { success: true });
        claim = null;
      } else if (dedupeKey && envelope) {
        this._seenDedupeKeys.add(dedupeKey);
      }

      if (envelope) {
        this._sequenceHint = envelope.sequence;
        if (this.emit) {
          await this.emit(envelope);
        }
      }
      return envelope;
    } catch (err) {
      if (claim) {
        claim.release(null, { success: false });
        claim = null;
      }
      throw err;
    }
  }

  /**
   * Projected events helper: record each projected { type, payload } item.
   * Payload context fields are stripped from data (context comes from recorder).
   *
   * @param {Array<{ type: string, payload?: Record<string, unknown> }>} projected
   * @param {{ dedupeKeyFor?: (ev: { type: string, payload?: object }) => string | null }} [opts]
   * @returns {Promise<Array<CanonicalRunEventEnvelope>>}
   */
  async recordProjected(projected, opts = {}) {
    /** @type {CanonicalRunEventEnvelope[]} */
    const out = [];
    for (const ev of projected || []) {
      if (!ev?.type) continue;
      const payload =
        ev.payload && typeof ev.payload === 'object' ? { ...ev.payload } : {};
      for (const k of [
        'orgId',
        'userId',
        'conversationId',
        'agentSessionId',
        'runId',
        'traceId',
        'spanId',
      ]) {
        delete payload[k];
      }
      const dedupeKey =
        typeof opts.dedupeKeyFor === 'function'
          ? opts.dedupeKeyFor(ev)
          : null;
      const env = await this.record({
        type: ev.type,
        data: payload,
        dedupeKey,
      });
      if (env) out.push(env);
    }
    return out;
  }
}
