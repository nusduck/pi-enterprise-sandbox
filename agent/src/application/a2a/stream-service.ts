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
import {
  prepareA2aStreamResult,
  streamKindsForMethod,
} from './stream-event-schema.js';
import type { ExternalAuth } from '../parent/external-identity-resolver.js';

/** 过渡期宽松类型：注入的依赖多数还是 JS 类，形状由各自的模块负责。 */
type Loose = any;

/** SSE comment keep-alive — not a `data:` frame (plan: every data is JSON-RPC). */
export function formatA2aSseHeartbeatComment(timestampIso = new Date().toISOString()) {
  return `: ping ${timestampIso}\n\n`;
}

export class A2aStreamService {
  // TS 要求类字段显式声明（JS 里它们只在构造器里赋值）。
  taskService: Loose;
  eventQuery: Loose;
  getRunService: Loose;
  runEventStream: Loose;
  pollMs: Loose;
  heartbeatMs: Loose;
  mysqlCatchupMs: Loose;
  historyPageSize: Loose;
  now: Loose;
  sleep: Loose;
  buildArtifactDownloadUri: Loose;

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
  constructor(deps: { taskService: { getTask: Function, resolveOwnedTask: Function, runAuthForPrincipal: Function, }, eventQueryService: { listEvents: Function, resolveEventSequence?: Function, }, getRunService: { execute: Function }, runEventStream?: { readAfter: Function } | null, pollMs?: number, heartbeatMs?: number, mysqlCatchupMs?: number, historyPageSize?: number, now?: () => number, sleep?: typeof sleepMs, buildArtifactDownloadUri?: Function | null, }) {
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
   *   method?: string | null,
   * }} input
   * @param {{
   *   write: (chunk: string) => boolean | void | Promise<boolean | void>,
   *   waitDrain?: () => Promise<'drained' | 'closed' | 'aborted'>,
   *   stream?: object,
   *   isClosed: () => boolean,
   *   signal?: AbortSignal,
   * }} sinks
   */
  async openTaskStream(input: { principal: Record<string, any>, agentId: string, taskId: string, rpcId: string | number | null, afterSequence?: number, lastEventId?: string | null, includeInitialTask?: boolean, method?: string | null, }, sinks: { write: (chunk: string) => boolean | void | Promise<boolean | void>, waitDrain?: () => Promise<'drained' | 'closed' | 'aborted'>, stream?: Record<string, any>, isClosed: () => boolean, signal?: AbortSignal, }) {
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
        ok = await Promise.resolve(write(frame));
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
    const emitRpc = async (
      rpcBody: unknown,
      meta: { omitId?: boolean; eventId?: unknown; sequence?: unknown } = {},
    ) => {
      // Snapshot frames must omit SSE id so Last-Event-ID is never a task ULID.
      // JSON-RPC A2A streams carry kind on result — do not set SSE `event:`.
      const id = meta.omitId
        ? null
        : meta.eventId != null && String(meta.eventId)
          ? String(meta.eventId)
          : meta.sequence != null && Number.isSafeInteger(Number(meta.sequence))
            ? String(meta.sequence)
            : null;
      const frame = formatA2aSseRpcFrame(rpcBody, { id });
      return pushFrame(frame);
    };

    const allowedKinds = new Set(streamKindsForMethod(input.method));
    let lastA2aStatus: string | null = null;
    // A2A 0.3 §3.1.2: a task-lifecycle stream closes on a `final: true` frame.
    let emittedFinal = false;

    // Initial Task snapshot — no SSE id (PR-12 severe: do not use taskId as event id).
    if (input.includeInitialTask !== false) {
      const task = await this.taskService.getTask({
        principal,
        agentId: input.agentId,
        taskId: mapping.a2aTaskId,
      });
      const outboundTask = prepareA2aStreamResult(task);
      if (outboundTask && allowedKinds.has('task')) {
        if (
          !(await emitRpc(jsonRpcSuccess(input.rpcId, outboundTask), {
            omitId: true,
          }))
        ) {
          return {
            lastSequence: lastEmitted,
            status: outboundTask.status?.state ?? null,
          };
        }
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
        lastA2aStatus,
      });
      // Non-A2A platform events still advance the journal cursor (no hole on reconnect).
      if (!projected) {
        lastEmitted = Number(envelope.sequence);
        return true;
      }
      if (
        projected.kind === 'status-update' &&
        typeof projected.result?.status?.state === 'string'
      ) {
        lastA2aStatus = projected.result.status.state;
      }
      if (projected.result?.final === true) {
        terminalStatus = projected.result.status?.state ?? terminalStatus;
      }
      // Drop kinds outside the official 0.3 StreamResponse union.
      if (!allowedKinds.has(projected.kind)) {
        lastEmitted = Number(envelope.sequence);
        return true;
      }
      const outbound = prepareA2aStreamResult(projected.result);
      if (!outbound) {
        lastEmitted = Number(envelope.sequence);
        return true;
      }
      const ok = await emitRpc(jsonRpcSuccess(input.rpcId, outbound), {
        eventId: projected.eventId,
        sequence: projected.sequence,
      });
      if (!ok) return false;
      // Advance only after successful write (matches PR-10 emitEnvelope).
      lastEmitted = projected.sequence;
      if (projected.result?.final === true) emittedFinal = true;
      return true;
    };

    /**
     * Close the task-lifecycle stream on a terminal frame.
     *
     * The journal normally carries a projectable terminal transition
     * (`run.completed` / `run.failed` / `run.cancelled`). When it does not —
     * resume past it, or a Run whose terminal event never projected — the
     * authoritative Run status still terminates the subscription, and a client
     * that only reads the stream would otherwise never see a terminal state.
     *
     * @param {string | null} status — A2A task status
     */
    const ensureFinalFrame = async (status) => {
      if (emittedFinal || stopped()) return;
      if (!status || !isTerminalA2aTaskStatus(status)) return;
      if (!allowedKinds.has('status-update')) return;
      const outbound = prepareA2aStreamResult({
        kind: 'status-update',
        taskId: mapping.a2aTaskId,
        contextId: mapping.contextId || mapping.a2aTaskId,
        status: {
          state: status,
          timestamp: new Date(this.now()).toISOString(),
        },
        final: true,
        metadata: { sequence: lastEmitted },
      });
      if (!outbound) return;
      // Synthesized frame is not journal-backed — no SSE id to resume from.
      if (await emitRpc(jsonRpcSuccess(input.rpcId, outbound), { omitId: true })) {
        emittedFinal = true;
      }
    };

    /** Drain MySQL after lastEmitted (contiguous pages). */
    const drainMysql = async (opts: { maxPages?: number } = {}) => {
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
          await ensureFinalFrame(terminalStatus);
          return { lastSequence: lastEmitted, status: terminalStatus, mode };
        }
      }
    }

    if (terminalStatus || stopped()) {
      await ensureFinalFrame(terminalStatus);
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
          // A full page may hide later events (the terminal one included) —
          // only trust an ambient terminal status once the journal is drained.
          const drained =
            !page.events?.length || page.events.length < this.historyPageSize;
          if (page.terminal && drained) {
            terminalStatus =
              terminalStatus || projectRunStatusToA2a(page.status);
            break;
          }
          if (runStatus && isTerminalRunStatus(runStatus) && drained) {
            terminalStatus =
              terminalStatus || projectRunStatusToA2a(runStatus);
            break;
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

    await ensureFinalFrame(terminalStatus);
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
  async #resolveCursor(input: { runId: string, auth: ExternalAuth, afterSequence?: number, lastEventId?: string | null, }) {
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
