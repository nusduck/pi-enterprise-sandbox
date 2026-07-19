/**
 * A2A SSE streaming (SendStreamingMessage / SubscribeToTask) — plan §20.3, §20.6.
 *
 * Reuses PR-10 contiguous sequence semantics from RunEventSseService:
 * - Redis readAfter(runId, { afterId, count })
 * - Only emit Redis when sequence === lastEmitted + 1
 * - If Redis sequence > last+1 → MySQL catch-up first; never emit later events
 *   or advance cursor past a gap
 * - Client disconnect ends subscription only — never cancels the Run
 * - Initial Task snapshot has NO SSE id (must not poison Last-Event-ID as ULID)
 * - Heartbeat is SSE comment only (every `data:` line is a JSON-RPC response)
 */

import { isTerminalRunStatus } from '../../domain/run/run-status.js';
import {
  isTerminalA2aTaskStatus,
  projectRunStatusToA2a,
} from '../../domain/a2a/status.js';
import {
  sleepMs,
  waitForWritableResume,
  shouldEmitSequence,
  resolveSseAfterSequence,
  projectRedisStreamToSseEnvelope,
  DEFAULT_SSE_POLL_MS,
  DEFAULT_SSE_HEARTBEAT_MS,
  DEFAULT_MYSQL_CATCHUP_MS,
  DEFAULT_HISTORY_PAGE,
} from '../run-event-sse-service.js';
import { projectEnvelopeToA2aResult } from './event-projector.js';
import { formatA2aSseRpcFrame, jsonRpcSuccess } from './json-rpc.js';

/** SSE comment keep-alive — not a `data:` frame (plan: every data is JSON-RPC). */
export function formatA2aSseHeartbeatComment(timestampIso = new Date().toISOString()) {
  return `: ping ${timestampIso}\n\n`;
}

export class A2aStreamService {
  /**
   * @param {{
   *   taskService: {
   *     getTask: Function,
   *     resolveOwnedTask: Function,
   *     runAuthForPrincipal: Function,
   *   },
   *   eventQueryService: {
   *     listEvents: Function,
   *     resolveEventSequence?: Function,
   *   },
   *   getRunService: { execute: Function },
   *   runEventStream?: { readAfter: Function } | null,
   *   pollMs?: number,
   *   heartbeatMs?: number,
   *   mysqlCatchupMs?: number,
   *   historyPageSize?: number,
   *   now?: () => number,
   *   sleep?: typeof sleepMs,
   *   buildArtifactDownloadUri?: Function | null,
   * }} deps
   */
  constructor(deps) {
    if (!deps?.taskService) {
      throw new Error('A2aStreamService requires taskService');
    }
    if (!deps?.eventQueryService?.listEvents) {
      throw new Error('A2aStreamService requires eventQueryService.listEvents');
    }
    if (!deps?.getRunService?.execute) {
      throw new Error('A2aStreamService requires getRunService');
    }
    this.taskService = deps.taskService;
    this.eventQuery = deps.eventQueryService;
    this.getRunService = deps.getRunService;
    this.runEventStream = deps.runEventStream ?? null;
    this.pollMs = deps.pollMs ?? DEFAULT_SSE_POLL_MS;
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS;
    this.mysqlCatchupMs = deps.mysqlCatchupMs ?? DEFAULT_MYSQL_CATCHUP_MS;
    this.historyPageSize = deps.historyPageSize ?? DEFAULT_HISTORY_PAGE;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? sleepMs;
    this.buildArtifactDownloadUri = deps.buildArtifactDownloadUri ?? null;
  }

  /**
   * @param {{
   *   principal: object,
   *   agentId: string,
   *   taskId: string,
   *   rpcId: string | number | null,
   *   afterSequence?: number,
   *   lastEventId?: string | null,
   *   includeInitialTask?: boolean,
   * }} input
   * @param {{
   *   write: (chunk: string) => boolean | void | Promise<boolean | void>,
   *   waitDrain?: () => Promise<'drained' | 'closed' | 'aborted'>,
   *   stream?: object,
   *   isClosed: () => boolean,
   *   signal?: AbortSignal,
   * }} sinks
   */
  async openTaskStream(input, sinks) {
    const { write, isClosed, signal } = sinks;
    const principal = input.principal;
    const mapping = await this.taskService.resolveOwnedTask(
      principal,
      input.taskId,
    );
    const runAuth = this.taskService.runAuthForPrincipal(principal);

    let lastEmitted = await this.#resolveCursor({
      runId: mapping.runId,
      auth: runAuth,
      afterSequence: input.afterSequence,
      lastEventId: input.lastEventId,
    });

    const stopped = () => isClosed() || Boolean(signal?.aborted);

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
     * @param {string} frame
     * @returns {Promise<boolean>}
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
      if (ok === false) {
        return resumeAfterBackpressure();
      }
      return true;
    };

    /**
     * Emit JSON-RPC over SSE.
     * @param {object} rpcBody
     * @param {{
     *   eventId?: string|null,
     *   sequence?: number|null,
     *   event?: string,
     *   omitId?: boolean,
     * }} [meta]
     */
    const emitRpc = async (rpcBody, meta = {}) => {
      // Snapshot frames must omit SSE id so Last-Event-ID is never a task ULID.
      const id = meta.omitId
        ? null
        : meta.eventId != null && String(meta.eventId)
          ? String(meta.eventId)
          : meta.sequence != null && Number.isSafeInteger(Number(meta.sequence))
            ? String(meta.sequence)
            : null;
      const frame = formatA2aSseRpcFrame(rpcBody, {
        id,
        event: meta.event,
      });
      return pushFrame(frame);
    };

    // Initial Task snapshot — no SSE id (PR-12 severe: do not use taskId as event id).
    if (input.includeInitialTask !== false) {
      const task = await this.taskService.getTask({
        principal,
        agentId: input.agentId,
        taskId: mapping.a2aTaskId,
      });
      if (
        !(await emitRpc(jsonRpcSuccess(input.rpcId, task), {
          omitId: true,
          event: 'task',
        }))
      ) {
        return { lastSequence: lastEmitted, status: task.status?.state ?? null };
      }
    }

    let lastHeartbeat = this.now();
    let redisLive = Boolean(this.runEventStream?.readAfter);
    let streamAfterId = '0-0';
    let lastMysqlCatchup = 0;
    let terminalStatus = null;
    let mode = 'mysql-history';

    const projectCtx = () => ({
      a2aTaskId: mapping.a2aTaskId,
      contextId: mapping.contextId,
      runStatus: null,
      principal,
      buildDownloadUri: this.buildArtifactDownloadUri,
    });

    /**
     * @param {object} envelope
     * @param {string | null} runStatus
     * @returns {Promise<boolean>} false → stop stream
     */
    const emitProjected = async (envelope, runStatus) => {
      if (!shouldEmitSequence(envelope, lastEmitted)) return true;
      const projected = projectEnvelopeToA2aResult(envelope, {
        ...projectCtx(),
        runStatus,
      });
      // Non-A2A platform events still advance the journal cursor (no hole on reconnect).
      if (!projected) {
        lastEmitted = Number(envelope.sequence);
        return true;
      }
      const ok = await emitRpc(jsonRpcSuccess(input.rpcId, projected.result), {
        eventId: projected.eventId,
        sequence: projected.sequence,
        event: projected.kind,
      });
      if (!ok) return false;
      // Advance only after successful write (matches PR-10 emitEnvelope).
      lastEmitted = projected.sequence;
      if (projected.result?.final === true) {
        terminalStatus = projected.result.status?.state ?? terminalStatus;
      }
      return true;
    };

    /**
     * Drain MySQL after lastEmitted (contiguous pages).
     * @param {{ maxPages?: number }} [opts]
     */
    const drainMysql = async (opts = {}) => {
      const maxPages = opts.maxPages ?? 50;
      let pages = 0;
      let terminal = false;
      let status = null;
      while (!stopped() && pages < maxPages) {
        pages += 1;
        const page = await this.eventQuery.listEvents({
          runId: mapping.runId,
          auth: runAuth,
          afterSequence: lastEmitted,
          limit: this.historyPageSize,
        });
        status = page.status ?? status;
        terminal = Boolean(page.terminal);
        if (!page.events?.length) break;
        for (const env of page.events) {
          // eslint-disable-next-line no-await-in-loop
          if (!(await emitProjected(env, status))) {
            return { terminal, aborted: true, status };
          }
        }
        if (page.events.length < this.historyPageSize) break;
      }
      lastMysqlCatchup = this.now();
      return { terminal, aborted: false, status };
    };

    // ── Phase 1: historical replay (MySQL only) ─────────────────────
    {
      const hist = await drainMysql({ maxPages: 10_000 });
      if (hist.aborted || stopped()) {
        return { lastSequence: lastEmitted, status: terminalStatus, mode };
      }
      if (hist.status && isTerminalRunStatus(hist.status)) {
        terminalStatus =
          terminalStatus || projectRunStatusToA2a(hist.status);
      }
      if (hist.terminal) {
        const confirm = await this.eventQuery.listEvents({
          runId: mapping.runId,
          auth: runAuth,
          afterSequence: lastEmitted,
          limit: 1,
        });
        if (
          confirm.terminal &&
          (!confirm.events || confirm.events.length === 0)
        ) {
          terminalStatus =
            terminalStatus || projectRunStatusToA2a(confirm.status);
          return { lastSequence: lastEmitted, status: terminalStatus, mode };
        }
      }
    }

    if (terminalStatus || stopped()) {
      return { lastSequence: lastEmitted, status: terminalStatus, mode };
    }

    /**
     * Apply Redis live entries with contiguous-sequence gate (PR-10).
     * @param {Array<object>} entries
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
          if (!(await emitProjected(env, null))) {
            return { sawWork, needMysqlCatchup: false, aborted: true };
          }
          sawWork = true;
          continue;
        }
        // Gap: do NOT emit or advance past lastEmitted; force MySQL first.
        needMysqlCatchup = true;
        break;
      }
      if (needMysqlCatchup) {
        const gap = await drainMysql({ maxPages: 100 });
        if (gap.aborted) {
          return { sawWork, needMysqlCatchup: true, aborted: true };
        }
        // After catch-up, only emit contiguous Redis tails still pending.
        for (const entry of entries) {
          if (entry.streamId) streamAfterId = entry.streamId;
          const env = projectRedisStreamToSseEnvelope(entry);
          if (env && env.sequence === lastEmitted + 1) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await emitProjected(env, null))) {
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
        // Correct PR-10 signature: (runId, { afterId, count })
        const existing = await this.runEventStream.readAfter(mapping.runId, {
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
        return { lastSequence: lastEmitted, status: terminalStatus, mode };
      }
    }

    // ── Phase 3: live loop ──────────────────────────────────────────
    while (!stopped()) {
      const now = this.now();
      if (now - lastHeartbeat >= this.heartbeatMs) {
        lastHeartbeat = now;
        // Comment-only heartbeat — never a non-JSON-RPC `data:` line.
        if (!(await pushFrame(formatA2aSseHeartbeatComment(new Date(now).toISOString())))) {
          return { lastSequence: lastEmitted, status: terminalStatus, mode };
        }
      }

      let sawWork = false;

      if (redisLive) {
        try {
          const live = await this.runEventStream.readAfter(mapping.runId, {
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
            runId: mapping.runId,
            auth: runAuth,
            afterSequence: lastEmitted,
            limit: this.historyPageSize,
          });
          lastMysqlCatchup = this.now();
          const runStatus = page.status || null;
          for (const env of page.events || []) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await emitProjected(env, runStatus))) {
              return { lastSequence: lastEmitted, status: terminalStatus, mode };
            }
            sawWork = true;
          }
          if (page.terminal && (!page.events || page.events.length === 0)) {
            terminalStatus =
              terminalStatus || projectRunStatusToA2a(page.status);
            break;
          }
          if (runStatus && isTerminalRunStatus(runStatus)) {
            terminalStatus =
              terminalStatus || projectRunStatusToA2a(runStatus);
            if (!page.events?.length) break;
          }
        } catch {
          // Transient read — retry while connected.
        }
      }

      if (terminalStatus) break;

      if (!sawWork) {
        try {
          await this.sleep(this.pollMs, signal);
        } catch (err) {
          if (err?.name === 'AbortError') break;
          throw err;
        }
      }
    }

    return { lastSequence: lastEmitted, status: terminalStatus, mode };
  }

  /**
   * @param {{
   *   runId: string,
   *   auth: object,
   *   afterSequence?: number,
   *   lastEventId?: string | null,
   * }} input
   */
  async #resolveCursor(input) {
    // Ignore Last-Event-ID values that are not numeric sequences or event ULIDs
    // that resolve under owner scope (task snapshot id must not advance cursor).
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
}
