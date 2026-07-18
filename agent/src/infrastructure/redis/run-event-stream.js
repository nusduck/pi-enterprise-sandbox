/**
 * Low-latency Run event stream via Redis Streams (plan §9.3–9.4).
 *
 * MySQL run_events remains the durable journal. Stream absence or empty range
 * must never be interpreted as Run status (succeeded/failed/cancelled).
 */

import { RUN_STREAM_MAXLEN, runStreamKey } from './constants.js';
import { RedisValidationError } from './errors.js';
import {
  assertCreatedAtUtc,
  assertEventId,
  assertEventType,
  assertRunId,
  assertSequence,
  assertStreamPayload,
  RUN_STREAM_PAYLOAD_MAX_BYTES,
} from './validation.js';

/**
 * @typedef {object} RunStreamEvent
 * @property {string} eventId ULID
 * @property {number | string} sequence nonnegative safe integer
 * @property {string} type bounded event type
 * @property {string | object} payload JSON string or object (serialized for Redis)
 * @property {string} createdAt UTC ISO 8601 ending in Z
 */

/**
 * @typedef {object} ParsedRunStreamEvent
 * @property {string} streamId Redis stream entry id
 * @property {string} eventId
 * @property {string} sequence
 * @property {string} type
 * @property {string} payload
 * @property {string} createdAt
 */

/**
 * Validate and normalize a stream event for XADD.
 *
 * @param {RunStreamEvent} event
 * @returns {{ eventId: string, sequence: string, type: string, payload: string, createdAt: string }}
 */
export function validateRunStreamEvent(event) {
  if (event == null || typeof event !== 'object' || Array.isArray(event)) {
    throw new RedisValidationError('event must be an object', { field: 'event' });
  }

  const eventId = assertEventId(event.eventId);
  const type = assertEventType(event.type);
  const createdAt = assertCreatedAtUtc(event.createdAt);
  const sequence = assertSequence(event.sequence);
  const payload = assertStreamPayload(event.payload);

  return { eventId, sequence, type, payload, createdAt };
}

/**
 * @param {string[]} flat ioredis flat field array [k, v, k, v, ...]
 * @returns {Record<string, string>}
 */
function fieldsToObject(flat) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(flat[i])] = String(flat[i + 1]);
  }
  return out;
}

/**
 * @param {string} streamId
 * @param {Record<string, string> | string[]} fields
 * @returns {ParsedRunStreamEvent}
 */
export function parseStreamEntry(streamId, fields) {
  const obj = Array.isArray(fields) ? fieldsToObject(fields) : fields ?? {};
  return {
    streamId: String(streamId),
    eventId: obj.eventId ?? '',
    sequence: obj.sequence ?? '',
    type: obj.type ?? '',
    payload: obj.payload ?? '',
    createdAt: obj.createdAt ?? '',
  };
}

/**
 * @typedef {object} RedisStreamLike
 * @property {(key: string, ...args: unknown[]) => Promise<string>} xadd
 * @property {(key: string, start: string, end: string, ...args: unknown[]) => Promise<Array<[string, string[]]>>} xrange
 * @property {(key: string, start: string, end: string, ...args: unknown[]) => Promise<Array<[string, string[]]>>} [xrevrange]
 * @property {(key: string) => Promise<number>} [xlen]
 */

export class RunEventStream {
  /**
   * @param {RedisStreamLike} redis
   * @param {{ maxLen?: number }} [options]
   */
  constructor(redis, options = {}) {
    if (!redis || typeof redis.xadd !== 'function' || typeof redis.xrange !== 'function') {
      throw new Error('RunEventStream requires a redis client with xadd() and xrange()');
    }
    this.redis = redis;
    this.maxLen = options.maxLen ?? RUN_STREAM_MAXLEN;
  }

  /**
   * @param {string} runId
   * @returns {string}
   */
  key(runId) {
    return runStreamKey(runId);
  }

  /**
   * Append event with approximate MAXLEN trim. Returns Redis stream id.
   *
   * @param {string} runId
   * @param {RunStreamEvent} event
   * @returns {Promise<string>}
   */
  async append(runId, event) {
    const id = assertRunId(runId);
    const fields = validateRunStreamEvent(event);
    const streamId = await this.redis.xadd(
      this.key(id),
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      'eventId',
      fields.eventId,
      'sequence',
      fields.sequence,
      'type',
      fields.type,
      'payload',
      fields.payload,
      'createdAt',
      fields.createdAt,
    );
    return String(streamId);
  }

  /**
   * Read a closed range [start, end] (inclusive stream ids). Empty when stream missing.
   *
   * @param {string} runId
   * @param {{ start?: string, end?: string, count?: number }} [opts]
   * @returns {Promise<ParsedRunStreamEvent[]>}
   */
  async range(runId, opts = {}) {
    const id = assertRunId(runId);
    const start = opts.start ?? '-';
    const end = opts.end ?? '+';
    /** @type {unknown[]} */
    const args = [this.key(id), start, end];
    if (opts.count != null) {
      args.push('COUNT', opts.count);
    }
    const rows = await this.redis.xrange(.../** @type {[string, string, string, ...unknown[]]} */ (args));
    return normalizeXrangeResult(rows);
  }

  /**
   * Read entries after exclusive stream id (for live tail / resume).
   *
   * @param {string} runId
   * @param {{ afterId?: string, count?: number }} [opts]
   * @returns {Promise<ParsedRunStreamEvent[]>}
   */
  async readAfter(runId, opts = {}) {
    const afterId = opts.afterId ?? '0-0';
    // Exclusive start: Redis supports "(" prefix from 6.2; fake client also supports it.
    const start = afterId === '0-0' || afterId === '0' ? '-' : `(${afterId}`;
    return this.range(runId, { start, end: '+', count: opts.count });
  }

  /**
   * Stream length helper. Missing key → 0 (not a status signal).
   *
   * @param {string} runId
   * @returns {Promise<number>}
   */
  async length(runId) {
    const id = assertRunId(runId);
    if (typeof this.redis.xlen !== 'function') {
      const all = await this.range(id);
      return all.length;
    }
    const n = await this.redis.xlen(this.key(id));
    return Number(n) || 0;
  }
}

/**
 * @param {unknown} rows
 * @returns {ParsedRunStreamEvent[]}
 */
function normalizeXrangeResult(rows) {
  if (rows == null) return [];
  if (!Array.isArray(rows)) return [];
  return rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return parseStreamEntry('', {});
    }
    return parseStreamEntry(String(entry[0]), /** @type {string[]} */ (entry[1]));
  });
}

export { RUN_STREAM_PAYLOAD_MAX_BYTES };
