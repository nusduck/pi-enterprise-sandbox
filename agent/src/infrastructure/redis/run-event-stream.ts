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

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

export type RunStreamEvent = {
  eventId: string;
  sequence: number | string;
  type: string;
  payload: string | Record<string, any>;
  createdAt: string;
};

export type ParsedRunStreamEvent = {
  streamId: string;
  eventId: string;
  sequence: string;
  type: string;
  payload: string;
  createdAt: string;
};

/**
 * Validate and normalize a stream event for XADD.
 *
 * @param event
 * @returns {{ eventId: string, sequence: string, type: string, payload: string, createdAt: string }}
 */
export function validateRunStreamEvent(event: RunStreamEvent) {
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
 * @param flat ioredis flat field array [k, v, k, v, ...]
 * @returns {Record<string, string>}
 */
function fieldsToObject(flat: string[]) {
  const out: Record<string, string> = {};
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(flat[i])] = String(flat[i + 1]);
  }
  return out;
}

/**
 * @param streamId
 * @param fields
 * @returns {ParsedRunStreamEvent}
 */
export function parseStreamEntry(streamId: string, fields: Record<string, string> | string[]) {
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

export type RedisStreamLike = {
  xadd: (key: string, ...args: unknown[]) => Promise<string>;
  xrange: (key: string, start: string, end: string, ...args: unknown[]) => Promise<Array<[string, string[]]>>;
  xrevrange?: (key: string, start: string, end: string, ...args: unknown[]) => Promise<Array<[string, string[]]>>;
  xlen?: (key: string) => Promise<number>;
};

export class RunEventStream {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  redis: Loose;
  maxLen: Loose;

  constructor(redis: RedisStreamLike, options: { maxLen?: number } = {}) {
    if (!redis || typeof redis.xadd !== 'function' || typeof redis.xrange !== 'function') {
      throw new Error('RunEventStream requires a redis client with xadd() and xrange()');
    }
    this.redis = redis;
    this.maxLen = options.maxLen ?? RUN_STREAM_MAXLEN;
  }

  /**
   * @param runId
   * @returns {string}
   */
  key(runId: string) {
    return runStreamKey(runId);
  }

  /**
   * Append event with approximate MAXLEN trim. Returns Redis stream id.
   *
   * @param runId
   * @param event
   * @returns {Promise<string>}
   */
  async append(runId: string, event: RunStreamEvent) {
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
   * @param runId
   * @param [opts]
   * @returns {Promise<ParsedRunStreamEvent[]>}
   */
  async range(runId: string, opts: { start?: string, end?: string, count?: number } = {}) {
    const id = assertRunId(runId);
    const start = opts.start ?? '-';
    const end = opts.end ?? '+';
    const args: unknown[] = [this.key(id), start, end];
    if (opts.count != null) {
      args.push('COUNT', opts.count);
    }
    const rows = await this.redis.xrange(...(args as [string, string, string, ...unknown[]]));
    return normalizeXrangeResult(rows);
  }

  /**
   * Read entries after exclusive stream id (for live tail / resume).
   *
   * @param runId
   * @param [opts]
   * @returns {Promise<ParsedRunStreamEvent[]>}
   */
  async readAfter(runId: string, opts: { afterId?: string, count?: number } = {}) {
    const afterId = opts.afterId ?? '0-0';
    // Exclusive start: Redis supports "(" prefix from 6.2; fake client also supports it.
    const start = afterId === '0-0' || afterId === '0' ? '-' : `(${afterId}`;
    return this.range(runId, { start, end: '+', count: opts.count });
  }

  /**
   * Stream length helper. Missing key → 0 (not a status signal).
   *
   * @param runId
   * @returns {Promise<number>}
   */
  async length(runId: string) {
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
 * @param rows
 * @returns {ParsedRunStreamEvent[]}
 */
function normalizeXrangeResult(rows: unknown) {
  if (rows == null) return [];
  if (!Array.isArray(rows)) return [];
  return rows.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return parseStreamEntry('', {});
    }
    return parseStreamEntry(String(entry[0]), (entry[1] as string[]));
  });
}

export { RUN_STREAM_PAYLOAD_MAX_BYTES };
