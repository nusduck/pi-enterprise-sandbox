/**
 * Hybrid Run Event SSE gateway (PR-10 / plan §18.4).
 *
 * Authority:
 *   MySQL run_events  = complete durable journal (history + recovery)
 *   Redis run:stream  = low-latency live notify / accelerate
 *
 * Guarantees:
 *   - Ownership fail-closed before any stream bytes.
 *   - Sequence-monotonic emit with dedupe (reconnect / Redis+MySQL overlap).
 *   - Watermark + MySQL catch-up across history→live cutover (no gap).
 *   - Redis failure falls back to MySQL poll (never treats empty Redis as status).
 *   - Client disconnect only ends the subscription — never cancels the Run.
 *   - No process-local event buffer as state source.
 *   - Async backpressure: write(false) awaits drain before next MySQL/Redis event.
 *   - close/abort/error unblocks drain/sleep waiters and removes all listeners.
 *
 * Wire format (plan §18.4 + frontend envelope unwrap):
 *   id: {eventId|sequence}
 *   event: {type}
 *   data: {"sequence":N,"event":{...},"ts":...,"eventId":"...","event_id":"..."}
 */

import { isUlid } from '../domain/shared/ulid.js';
import {
  projectRunEventToSseEnvelope,
  RunEventQueryService,
} from './run-event-query-service.js';

/** Default live poll when Redis is absent or failed (ms). */
export const DEFAULT_SSE_POLL_MS = 400;
/** Heartbeat interval (ms). */
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
/** How often to re-check MySQL during Redis live for lag/trim catch-up (ms). */
export const DEFAULT_MYSQL_CATCHUP_MS = 2_000;
/** Max events per MySQL page. */
export const DEFAULT_HISTORY_PAGE = 100;

/**
 * Abort-safe sleep. Always removes the abort listener on normal timeout or abort.
 *
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
export function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    const cleanup = () => {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

/**
 * Wait until a writable stream can accept more data, or the connection ends.
 *
 * Accepts either:
 * - Node stream-like: `once`/`on`/`off`/`removeListener` for drain/close/error
 * - Custom `{ waitDrain: () => Promise<'drained'|'closed'|'aborted'> }`
 *
 * Always removes every listener it attaches (no leak across long SSE).
 *
 * @param {{
 *   waitDrain?: () => Promise<'drained' | 'closed' | 'aborted'>,
 *   stream?: {
 *     once?: Function,
 *     on?: Function,
 *     off?: Function,
 *     removeListener?: Function,
 *     writableEnded?: boolean,
 *     destroyed?: boolean,
 *   },
 *   signal?: AbortSignal | null,
 *   isClosed?: () => boolean,
 * }} opts
 * @returns {Promise<'drained' | 'closed' | 'aborted'>}
 */
export function waitForWritableResume(opts = {}) {
  if (typeof opts.waitDrain === 'function') {
    return Promise.resolve(opts.waitDrain()).then((r) => {
      if (r === 'drained' || r === 'closed' || r === 'aborted') return r;
      return 'closed';
    });
  }

  const stream = opts.stream;
  const signal = opts.signal ?? null;
  const isClosed = opts.isClosed ?? (() => false);

  if (isClosed() || signal?.aborted) {
    return Promise.resolve(signal?.aborted ? 'aborted' : 'closed');
  }
  if (stream?.writableEnded || stream?.destroyed) {
    return Promise.resolve('closed');
  }

  if (!stream || (typeof stream.once !== 'function' && typeof stream.on !== 'function')) {
    // No stream and no custom waitDrain: cannot honor backpressure — treat as closed.
    return Promise.resolve('closed');
  }

  return new Promise((resolve) => {
    let settled = false;
    const on = (ev, fn) => {
      if (typeof stream.once === 'function') stream.once(ev, fn);
      else stream.on(ev, fn);
    };
    const off = (ev, fn) => {
      if (typeof stream.off === 'function') stream.off(ev, fn);
      else if (typeof stream.removeListener === 'function') stream.removeListener(ev, fn);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      off('drain', onDrain);
      off('close', onClose);
      off('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const onDrain = () => finish('drained');
    const onClose = () => finish('closed');
    const onError = () => finish('closed');
    const onAbort = () => finish('aborted');

    on('drain', onDrain);
    on('close', onClose);
    on('error', onError);
    if (signal) signal.addEventListener('abort', onAbort);

    // Re-check after attaching (race: already drained / closed).
    if (isClosed() || stream.writableEnded || stream.destroyed) {
      finish('closed');
    } else if (signal?.aborted) {
      finish('aborted');
    }
  });
}

/**
 * Format one SSE frame. Named `event:` line is advisory; clients that only
 * parse `data:` remain compatible.
 *
 * @param {{ sequence: number, event: object, ts?: number, eventId?: string, event_id?: string }} envelope
 * @returns {string}
 */
export function formatSseDataFrame(envelope) {
  const eventId =
    envelope.eventId ||
    envelope.event_id ||
    envelope.event?.eventId ||
    envelope.event?.event_id ||
    null;
  const type =
    envelope.event?.type ||
    envelope.event?.event_type ||
    envelope.type ||
    'message';
  const id = eventId != null && String(eventId) ? String(eventId) : String(envelope.sequence);
  const data = JSON.stringify(envelope);
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
}

/**
 * Heartbeat frame (plan §18.4).
 * @param {string} [timestampIso]
 * @returns {string}
 */
export function formatSsePingFrame(timestampIso = new Date().toISOString()) {
  return `event: ping\ndata: ${JSON.stringify({ timestamp: timestampIso })}\n\n`;
}

/**
 * Terminal end frame.
 * @param {string} status
 * @returns {string}
 */
export function formatSseEndFrame(status) {
  return `event: end\ndata: ${JSON.stringify({ status })}\n\n`;
}

/**
 * Project a Redis stream entry to the same SSE envelope as MySQL rows.
 * Sequence/type/payload come from stream fields; Redis is never status authority.
 *
 * @param {{ eventId?: string, sequence?: string|number, type?: string, payload?: string, createdAt?: string }} entry
 * @returns {{ sequence: number, event: object, ts: number, eventId?: string, event_id?: string } | null}
 */
export function projectRedisStreamToSseEnvelope(entry) {
  const sequence = Number(entry?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0) return null;

  let payload = {};
  if (typeof entry.payload === 'string' && entry.payload) {
    try {
      const parsed = JSON.parse(entry.payload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed;
      }
    } catch {
      payload = {};
    }
  } else if (entry.payload && typeof entry.payload === 'object') {
    payload = { ...entry.payload };
  }

  const eventId = entry.eventId || payload.eventId || payload.event_id || null;
  const type = entry.type || payload.type || payload.event_type || 'message';
  const event = {
    type,
    event_type: type,
    ...(eventId
      ? { eventId: String(eventId), event_id: String(eventId) }
      : {}),
    ...payload,
  };
  // Prefer stream type over any payload collision.
  event.type = type;
  event.event_type = type;

  const ts = entry.createdAt ? Date.parse(entry.createdAt) : Date.now();
  return {
    sequence,
    event,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    ...(eventId
      ? { eventId: String(eventId), event_id: String(eventId) }
      : {}),
  };
}

/**
 * Resolve afterSequence from query + Last-Event-ID (sequence or ULID event id).
 *
 * @param {{
 *   afterSequence?: number|string|null,
 *   lastEventId?: string|null,
 *   resolveEventSequence?: (eventId: string) => Promise<number|null>,
 * }} input
 * @returns {Promise<number>}
 */
export async function resolveSseAfterSequence(input) {
  let after = Math.max(0, Number(input.afterSequence) || 0);

  const last = input.lastEventId != null ? String(input.lastEventId).trim() : '';
  if (!last) return after;

  if (/^\d+$/.test(last)) {
    return Math.max(after, parseInt(last, 10) || 0);
  }

  if (isUlid(last) && typeof input.resolveEventSequence === 'function') {
    const seq = await input.resolveEventSequence(last.toUpperCase());
    if (seq != null && Number.isSafeInteger(seq) && seq >= 0) {
      return Math.max(after, seq);
    }
    // Unknown event id for this owner: keep provided afterSequence.
    return after;
  }

  return after;
}

/**
 * @param {object} envelope
 * @param {number} lastEmitted
 * @returns {boolean}
 */
export function shouldEmitSequence(envelope, lastEmitted) {
  const seq = Number(envelope?.sequence);
  if (!Number.isSafeInteger(seq) || seq < 0) return false;
  return seq > lastEmitted;
}

export class RunEventSseService {
  /**
   * @param {{
   *   eventQueryService: RunEventQueryService | { listEvents: Function, resolveEventSequence?: Function },
   *   runEventStream?: { readAfter: Function } | null,
   *   pollMs?: number,
   *   heartbeatMs?: number,
   *   mysqlCatchupMs?: number,
   *   historyPageSize?: number,
   *   now?: () => number,
   *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.eventQueryService || typeof deps.eventQueryService.listEvents !== 'function') {
      throw new Error('RunEventSseService requires eventQueryService.listEvents');
    }
    this.eventQuery = deps.eventQueryService;
    this.runEventStream = deps.runEventStream ?? null;
    this.pollMs = deps.pollMs ?? DEFAULT_SSE_POLL_MS;
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    this.mysqlCatchupMs = deps.mysqlCatchupMs ?? DEFAULT_MYSQL_CATCHUP_MS;
    this.historyPageSize = deps.historyPageSize ?? DEFAULT_HISTORY_PAGE;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? sleepMs;
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: object,
   *   afterSequence?: number,
   *   lastEventId?: string|null,
   * }} input
   * @returns {Promise<number>}
   */
  async resolveCursor(input) {
    const resolveEventSequence =
      typeof this.eventQuery.resolveEventSequence === 'function'
        ? (eventId) =>
            this.eventQuery.resolveEventSequence({
              runId: input.runId,
              auth: input.auth,
              eventId,
            })
        : null;

    return resolveSseAfterSequence({
      afterSequence: input.afterSequence,
      lastEventId: input.lastEventId,
      resolveEventSequence: resolveEventSequence || undefined,
    });
  }

  /**
   * Drive an SSE response until terminal, disconnect, or abort.
   *
   * Backpressure contract:
   *   write(chunk) → true | false | Promise<boolean>
   *   false means the chunk was accepted into the socket buffer but the
   *   high-water mark is full — openStream awaits waitDrain (or stream drain)
   *   before emitting the next event. close/abort/error ends the wait.
   *
   * @param {{
   *   runId: string,
   *   auth: object,
   *   afterSequence?: number,
   *   lastEventId?: string|null,
   * }} input
   * @param {{
   *   write: (chunk: string) => boolean | void | Promise<boolean | void>,
   *   waitDrain?: () => Promise<'drained' | 'closed' | 'aborted'>,
   *   stream?: object,
   *   isClosed: () => boolean,
   *   signal?: AbortSignal,
   * }} sinks
   * @returns {Promise<{ lastSequence: number, status: string|null, mode: string }>}
   */
  async openStream(input, sinks) {
    const { write, isClosed, signal } = sinks;
    let lastEmitted = await this.resolveCursor(input);
    let status = null;
    let mode = 'mysql-history';
    let redisLive = Boolean(this.runEventStream?.readAfter);
    let streamAfterId = '0-0';
    let lastHeartbeat = this.now();
    let lastMysqlCatchup = 0;

    const stopped = () => isClosed() || Boolean(signal?.aborted);

    /**
     * After write() returned false: wait for drain or disconnect.
     * @returns {Promise<boolean>} true if may continue writing
     */
    const resumeAfterBackpressure = async () => {
      if (stopped()) return false;
      const result = await waitForWritableResume({
        waitDrain: sinks.waitDrain,
        stream: sinks.stream,
        signal,
        isClosed,
      });
      if (result !== 'drained') return false;
      return !stopped();
    };

    /**
     * Write one frame; honor backpressure before returning.
     * @param {string} frame
     * @returns {Promise<boolean>} false → stop the stream (disconnect / error)
     */
    const pushFrame = async (frame) => {
      if (stopped()) return false;
      let ok;
      try {
        ok = write(frame);
        if (ok != null && typeof ok.then === 'function') {
          ok = await ok;
        }
      } catch {
        return false;
      }
      if (stopped()) return false;
      // Node: false = buffered but high-water hit — wait before next frame.
      if (ok === false) {
        return resumeAfterBackpressure();
      }
      return true;
    };

    /**
     * @param {{ sequence: number, event: object, ts?: number, eventId?: string, event_id?: string }} envelope
     * @returns {Promise<boolean>}
     */
    const emitEnvelope = async (envelope) => {
      if (stopped()) return false;
      if (!shouldEmitSequence(envelope, lastEmitted)) return true;
      // Advance cursor only after a successful queue into the writable.
      // write(false) still queued the bytes, so advance then await drain.
      const frame = formatSseDataFrame(envelope);
      if (stopped()) return false;
      let ok;
      try {
        ok = write(frame);
        if (ok != null && typeof ok.then === 'function') {
          ok = await ok;
        }
      } catch {
        return false;
      }
      if (stopped()) return false;
      lastEmitted = envelope.sequence;
      if (ok === false) {
        return resumeAfterBackpressure();
      }
      return true;
    };

    const emitPing = async () => {
      if (stopped()) return false;
      const ok = await pushFrame(
        formatSsePingFrame(new Date(this.now()).toISOString()),
      );
      if (ok) lastHeartbeat = this.now();
      return ok;
    };

    const maybeHeartbeat = async () => {
      if (this.now() - lastHeartbeat >= this.heartbeatMs) {
        return emitPing();
      }
      return true;
    };

    /**
     * Drain MySQL page(s) after lastEmitted. Awaits backpressure per event.
     * @param {{ maxPages?: number }} [opts]
     */
    const drainMysql = async (opts = {}) => {
      const maxPages = opts.maxPages ?? 50;
      let pages = 0;
      let terminal = false;
      while (!stopped() && pages < maxPages) {
        pages += 1;
        const page = await this.eventQuery.listEvents({
          runId: input.runId,
          auth: input.auth,
          afterSequence: lastEmitted,
          limit: this.historyPageSize,
        });
        status = page.status ?? status;
        terminal = Boolean(page.terminal);
        if (!page.events?.length) break;
        for (const env of page.events) {
          // Await each emit so write(false) cannot race the next event.
          // eslint-disable-next-line no-await-in-loop
          if (!(await emitEnvelope(env))) {
            return { terminal, drained: true, aborted: true };
          }
        }
        if (page.events.length < this.historyPageSize) break;
      }
      lastMysqlCatchup = this.now();
      return { terminal, drained: true, aborted: false };
    };

    // ── Phase 1: historical replay (MySQL only) ─────────────────────
    {
      const hist = await drainMysql({ maxPages: 10_000 });
      if (hist.aborted || stopped()) {
        return { lastSequence: lastEmitted, status, mode };
      }
      if (hist.terminal) {
        const confirm = await this.eventQuery.listEvents({
          runId: input.runId,
          auth: input.auth,
          afterSequence: lastEmitted,
          limit: 1,
        });
        status = confirm.status ?? status;
        if (confirm.terminal && (!confirm.events || confirm.events.length === 0)) {
          await pushFrame(formatSseEndFrame(status || 'COMPLETED'));
          return { lastSequence: lastEmitted, status, mode: 'mysql-history' };
        }
      }
    }

    /**
     * Apply Redis live entries without creating sequence holes.
     * Contiguous seq (lastEmitted+1) may emit from Redis for low latency.
     * Gaps force MySQL catch-up first so history remains gap-free.
     *
     * @param {Array<object>} entries
     * @returns {Promise<{ sawWork: boolean, needMysqlCatchup: boolean }>}
     */
    const applyRedisEntries = async (entries) => {
      let sawWork = false;
      let needMysqlCatchup = false;
      for (const entry of entries) {
        if (entry.streamId) streamAfterId = entry.streamId;
        const env = projectRedisStreamToSseEnvelope(entry);
        if (!env) continue;
        if (env.sequence <= lastEmitted) {
          continue;
        }
        if (env.sequence === lastEmitted + 1) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await emitEnvelope(env))) {
            return { sawWork, needMysqlCatchup: false, aborted: true };
          }
          sawWork = true;
          continue;
        }
        needMysqlCatchup = true;
        break;
      }
      if (needMysqlCatchup) {
        const gap = await drainMysql({ maxPages: 100 });
        if (gap.aborted) {
          return { sawWork, needMysqlCatchup: true, aborted: true };
        }
        for (const entry of entries) {
          if (entry.streamId) streamAfterId = entry.streamId;
          const env = projectRedisStreamToSseEnvelope(entry);
          if (env && env.sequence === lastEmitted + 1) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await emitEnvelope(env))) {
              return { sawWork: true, needMysqlCatchup: true, aborted: true };
            }
            sawWork = true;
          } else if (env && env.sequence > lastEmitted + 1) {
            break;
          }
        }
      }
      return { sawWork, needMysqlCatchup, aborted: false };
    };

    // ── Phase 2: live cutover ────────────────────────────────────────
    if (redisLive) {
      mode = 'redis-live';
      try {
        const existing = await this.runEventStream.readAfter(input.runId, {
          afterId: streamAfterId,
          count: 200,
        });
        for (const entry of existing) {
          if (entry.streamId) streamAfterId = entry.streamId;
        }
      } catch {
        redisLive = false;
        mode = 'mysql-poll';
      }
    } else {
      mode = 'mysql-poll';
    }

    {
      const gap = await drainMysql({ maxPages: 100 });
      if (gap.aborted || stopped()) {
        return { lastSequence: lastEmitted, status, mode };
      }
    }

    // ── Phase 3: live loop ──────────────────────────────────────────
    while (!stopped()) {
      if (!(await maybeHeartbeat())) break;

      let sawWork = false;

      if (redisLive) {
        try {
          const live = await this.runEventStream.readAfter(input.runId, {
            afterId: streamAfterId,
            count: 100,
          });
          if (live.length > 0) {
            const applied = await applyRedisEntries(live);
            if (applied.aborted) break;
            sawWork = sawWork || applied.sawWork;
          }
        } catch {
          redisLive = false;
          mode = 'mysql-poll-fallback';
        }
      }

      const dueCatchup =
        !redisLive || this.now() - lastMysqlCatchup >= this.mysqlCatchupMs;
      if (dueCatchup) {
        try {
          const page = await this.eventQuery.listEvents({
            runId: input.runId,
            auth: input.auth,
            afterSequence: lastEmitted,
            limit: this.historyPageSize,
          });
          status = page.status ?? status;
          lastMysqlCatchup = this.now();
          for (const env of page.events || []) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await emitEnvelope(env))) {
              sawWork = true;
              return { lastSequence: lastEmitted, status, mode };
            }
            sawWork = true;
          }
          if (page.terminal && (!page.events || page.events.length === 0)) {
            await pushFrame(formatSseEndFrame(status || 'COMPLETED'));
            break;
          }
        } catch {
          // Transient MySQL errors: wait and retry while client connected.
        }
      }

      if (stopped()) break;
      if (!sawWork) {
        try {
          await this.sleep(this.pollMs, signal);
        } catch (err) {
          if (err?.name === 'AbortError') break;
          throw err;
        }
      }
    }

    return { lastSequence: lastEmitted, status, mode };
  }
}

export { projectRunEventToSseEnvelope };
