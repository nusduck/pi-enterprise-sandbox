/**
 * Per-run SSE Manager (ADR 0003 §14).
 *
 * Tracks lastEventId, connectionStatus, retryCount, abortController per runId.
 * Supports Last-Event-ID resume, auto-reconnect, event dedupe, sequence-gap recovery.
 * Conversation switches do NOT cancel background run connections.
 *
 * Sequence gap policy:
 *   - Reducer does not apply gap events or advance the cursor.
 *   - Manager aborts the live subscription and re-subscribes from the previous
 *     lastSequence / lastEventId (never jumps to the gap sequence).
 *   - Gap recovery is bounded (maxGapRecoveries) to avoid infinite loops.
 *   - Duplicates / out-of-order do not trigger reconnect.
 *   - Gap recovery is scoped to the affected run only.
 */
import type { ConnectionStatus, EntityStore, RunSSEState } from '../../entities/types';
import { isTerminalRunStatus } from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import { parseRuntimeEvent } from '../schemas/events';
import { reduceRuntimeEvent, type ReduceResult } from '../state/runReducer';
import { normalizeToRuntimeEvent } from '../state/platformEventNormalize';
import { createSSEParser, type SSEEvent } from './parser';
import { authHeaders } from '../api/client';

export type RunSSEManagerOptions = {
  /** Base path for run events, default `/api/runs`. */
  basePath?: string;
  /** Max reconnect attempts before giving up (transport errors). */
  maxRetries?: number;
  /** Max sequence-gap recoveries per run before reconcile/error. */
  maxGapRecoveries?: number;
  /** Base delay (ms) for exponential backoff. */
  retryBaseMs?: number;
  /** Cap for backoff delay. */
  retryMaxMs?: number;
  /** Called after each applied (or skipped) event. */
  onEvent?: (runId: string, result: ReduceResult, event: RuntimeEvent) => void;
  /** Called when entity store updates. */
  onStoreChange?: (store: EntityStore) => void;
  /** Called when connection status changes. */
  onStatusChange?: (runId: string, status: ConnectionStatus, retryCount: number) => void;
  /** Inject fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Optional sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Fetch authoritative run/tool state after reconnect exhaustion. */
  reconcileRun?: (runId: string) => Promise<unknown>;
};

export type RunSSEManager = {
  /** Current entity store snapshot. */
  getStore: () => EntityStore;
  /** Replace store (e.g. after external rehydrate). */
  setStore: (store: EntityStore) => void;
  /** Connection bookkeeping for a run. */
  getConnection: (runId: string) => RunSSEState | null;
  /** All active connection states. */
  listConnections: () => RunSSEState[];
  /**
   * Subscribe to a run's event stream.
   * Safe to call when already connected (no-op if live).
   * Does NOT cancel other runs.
   */
  connect: (runId: string, opts?: { lastEventId?: string | null; lastSequence?: number }) => void;
  /** Disconnect a single run (e.g. user Stop). Does not cancel the server run. */
  disconnect: (runId: string) => void;
  /** Disconnect all runs (page unload). */
  disconnectAll: () => void;
  /** Feed a raw/parsed event (tests + Agent event adapter). */
  handleEvent: (raw: unknown) => ReduceResult;
  /** Apply a RuntimeEvent that already belongs to a run. */
  handleRuntimeEvent: (ev: RuntimeEvent) => ReduceResult;
  /** Whether any run is still streaming. */
  hasActiveConnections: () => boolean;
  /** Gap recovery attempts for a run (tests). */
  getGapRecoveryCount: (runId: string) => number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function createConnectionState(
  runId: string,
  partial: Partial<RunSSEState> = {},
): RunSSEState {
  const { seenEventIds, ...rest } = partial;
  return {
    runId,
    lastEventId: null,
    lastSequence: 0,
    connectionStatus: 'idle',
    retryCount: 0,
    ...rest,
    seenEventIds: seenEventIds || new Set(),
  };
}

/**
 * Create a multi-run SSE manager bound to an entity store.
 */
export function createRunSSEManager(
  initialStore: EntityStore,
  options: RunSSEManagerOptions = {},
): RunSSEManager {
  const basePath = options.basePath || '/api/runs';
  const maxRetries = options.maxRetries ?? 8;
  const maxGapRecoveries = options.maxGapRecoveries ?? options.maxRetries ?? 8;
  const retryBaseMs = options.retryBaseMs ?? 500;
  const retryMaxMs = options.retryMaxMs ?? 15_000;
  const fetchImpl = options.fetchImpl || fetch.bind(globalThis);
  const sleep = options.sleep || defaultSleep;

  let store = initialStore;
  const connections = new Map<string, RunSSEState>();
  /** AbortControllers keyed by runId — not stored on RunSSEState (not serializable). */
  const abortControllers = new Map<string, AbortController>();
  /** Generation tokens so stale reconnect loops exit after disconnect. */
  const generations = new Map<string, number>();
  /** Bounded gap-recovery counter per run (not reset on successful apply). */
  const gapRecoveryCounts = new Map<string, number>();
  /** When set, AbortError should re-enter streamLoop with the same cursor. */
  const gapReconnectPending = new Set<string>();

  function setStatus(runId: string, status: ConnectionStatus): void {
    const conn = connections.get(runId);
    if (!conn) return;
    conn.connectionStatus = status;
    options.onStatusChange?.(runId, status, conn.retryCount);
  }

  function getOrCreateConn(
    runId: string,
    seed: Partial<RunSSEState> = {},
  ): RunSSEState {
    let conn = connections.get(runId);
    if (!conn) {
      // Seed from store if available
      const run = store.runsById[runId];
      conn = createConnectionState(runId, {
        lastEventId: seed.lastEventId ?? run?.lastEventId ?? null,
        lastSequence: seed.lastSequence ?? run?.lastSequence ?? 0,
        ...seed,
      });
      connections.set(runId, conn);
    } else {
      if (seed.lastEventId != null) conn.lastEventId = seed.lastEventId;
      if (seed.lastSequence != null) conn.lastSequence = seed.lastSequence;
    }
    return conn;
  }

  /**
   * Abort the live body so streamLoop re-subscribes from conn.lastSequence.
   * Does not bump generation (user disconnect does). Does not touch other runs.
   */
  function requestGapReconnect(runId: string): void {
    const conn = connections.get(runId);
    if (!conn) return;

    const count = (gapRecoveryCounts.get(runId) || 0) + 1;
    gapRecoveryCounts.set(runId, count);

    if (count > maxGapRecoveries) {
      gapReconnectPending.delete(runId);
      void (async () => {
        try {
          await options.reconcileRun?.(runId);
          const recovered = store.runsById[runId];
          if (recovered && isTerminalRunStatus(recovered.status)) {
            setStatus(runId, 'closed');
            return;
          }
        } catch {
          /* keep error visible */
        }
        setStatus(runId, 'error');
      })();
      // Abort live stream if any; do not schedule another gap loop.
      const ctrl = abortControllers.get(runId);
      if (ctrl) {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // Mark pending before abort so streamLoop treats AbortError as gap recovery.
    gapReconnectPending.add(runId);
    setStatus(runId, 'reconnecting');
    const ctrl = abortControllers.get(runId);
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    // If no live stream (pure handleEvent path), reconnect only when connect() is live.
    // Pure path: gap is reported; caller may connect() later with same cursor.
  }

  function syncConnCursor(runId: string, conn: RunSSEState): void {
    const run = store.runsById[runId];
    if (!run) return;
    conn.lastEventId = run.lastEventId;
    conn.lastSequence = run.lastSequence;
  }

  function handleRuntimeEvent(ev: RuntimeEvent): ReduceResult {
    const conn = getOrCreateConn(ev.run_id);
    // Keep conn cursor aligned with store before classify (rehydrate may have set store).
    syncConnCursor(ev.run_id, conn);

    const result = reduceRuntimeEvent(store, ev, {
      seenEventIds: conn.seenEventIds,
    });

    if (result.outcome === 'applied') {
      store = result.store;
      // Cursor only advances on applied — never on gap.
      conn.lastEventId = ev.event_id;
      conn.lastSequence = ev.sequence;
      // Successful contiguous apply resets transport retry, not gap budget
      // (gap budget is lifetime per run until disconnect).
      options.onStoreChange?.(store);

      const run = store.runsById[ev.run_id];
      if (run && isTerminalRunStatus(run.status)) {
        queueMicrotask(() => {
          disconnect(ev.run_id);
          setStatus(ev.run_id, 'closed');
        });
      }
    } else if (result.outcome === 'gap') {
      // Store/cursor unchanged. Trigger bounded resubscribe from old cursor when live.
      const live =
        conn.connectionStatus === 'connected' ||
        conn.connectionStatus === 'connecting' ||
        conn.connectionStatus === 'reconnecting';
      if (live) {
        requestGapReconnect(ev.run_id);
      }
    }
    // duplicate / out_of_order / invalid: no reconnect

    options.onEvent?.(ev.run_id, result, ev);
    return result;
  }

  function handleEvent(raw: unknown): ReduceResult {
    const ev =
      normalizeToRuntimeEvent(raw) ||
      parseRuntimeEvent(raw);
    if (!ev) {
      return {
        store,
        outcome: 'invalid',
        sequenceGap: false,
        appliedSequence: null,
        eventId: null,
      };
    }
    return handleRuntimeEvent(ev);
  }

  /**
   * Parse SSE wire into RuntimeEvent.
   * Supports:
   * - Platform envelope: { eventId, sequence, type, data, context }
   * - Runtime envelope: { event_id, sequence, run_id, type, payload }
   * - BFF relay: { sequence, event, ts }
   * - SSE with `id:` field already consumed by caller as lastEventId
   */
  function coerceEvent(raw: SSEEvent, runId: string, conn: RunSSEState): RuntimeEvent | null {
    // Prefer unified normalize (platform + legacy + BFF relay).
    const normalized = normalizeToRuntimeEvent(raw, runId);
    if (normalized) {
      // Fill synthetic sequence when stream omitted it but we are live-tailing
      if (
        normalized.sequence === 0 &&
        conn.lastSequence > 0 &&
        !raw.sequence &&
        !(raw as { eventId?: string }).eventId
      ) {
        return {
          ...normalized,
          sequence: conn.lastSequence + 1,
        };
      }
      return normalized;
    }

    // BFF relay envelope: { sequence, event, ts }. Preserve the outer
    // sequence so replay/dedupe remains stable even when Agent event IDs are
    // absent from the inner legacy payload.
    if (raw.event && typeof raw.event === 'object') {
      return coerceEvent(
        {
          ...(raw.event as SSEEvent),
          sequence: raw.sequence,
          event_id: (raw.event as SSEEvent).event_id || raw.event_id || raw.id,
        },
        runId,
        conn,
      );
    }
    // Already a runtime event
    if (raw.event_id && raw.run_id && typeof raw.sequence === 'number') {
      return parseRuntimeEvent(raw);
    }

    // Agent event response shape: { run_id, sequence, event_id, type, payload }
    if (raw.event_id && typeof raw.sequence === 'number' && raw.type) {
      return parseRuntimeEvent({
        ...raw,
        run_id: raw.run_id || runId,
      });
    }

    // Fallback: synthesize envelope from loose event (should be rare for run-centric API)
    if (raw.type) {
      const seq =
        typeof raw.sequence === 'number' ? raw.sequence : conn.lastSequence + 1;
      const eventId =
        raw.event_id != null
          ? String(raw.event_id)
          : raw.id != null
            ? String(raw.id)
            : `synth_${runId}_${seq}`;
      return parseRuntimeEvent({
        event_id: eventId,
        sequence: seq,
        run_id: String(raw.run_id || runId),
        session_id: raw.session_id ?? null,
        type: String(raw.type),
        timestamp: raw.timestamp ?? null,
        payload: (raw.payload as Record<string, unknown>) || { ...raw, type: undefined },
      });
    }

    return null;
  }

  async function streamLoop(runId: string, generation: number): Promise<void> {
    const conn = connections.get(runId);
    if (!conn) return;

    while (generations.get(runId) === generation) {
      // Align cursor from store (authoritative after rehydrate / applied events)
      syncConnCursor(runId, conn);

      const ctrl = new AbortController();
      abortControllers.set(runId, ctrl);

      const isRetry = conn.retryCount > 0 || gapReconnectPending.has(runId);
      setStatus(runId, isRetry ? 'reconnecting' : 'connecting');

      try {
        const headers = authHeaders({
          Accept: 'text/event-stream',
        });
        // Resume from the last *applied* event — never from a gap sequence.
        if (conn.lastEventId) {
          headers['Last-Event-ID'] = conn.lastEventId;
        }

        const url = `${basePath}/${encodeURIComponent(runId)}/events`;
        const qs =
          conn.lastSequence > 0
            ? `?after_sequence=${encodeURIComponent(String(conn.lastSequence))}`
            : '';

        const resp = await fetchImpl(`${url}${qs}`, {
          method: 'GET',
          headers,
          signal: ctrl.signal,
        });

        if (generations.get(runId) !== generation) return;

        if (!resp.ok) {
          throw new Error(`SSE HTTP ${resp.status}`);
        }

        if (!resp.body?.getReader) {
          throw new Error('SSE response body is not readable');
        }

        // Clear gap pending once a new subscription is established
        gapReconnectPending.delete(runId);
        setStatus(runId, 'connected');
        conn.retryCount = 0;

        const reader = resp.body.getReader();
        let gapAbort = false;
        const parser = createSSEParser({
          onEvent: (raw) => {
            if (generations.get(runId) !== generation) return;
            const ev = coerceEvent(raw, runId, conn);
            if (!ev) return;
            const result = handleRuntimeEvent(ev);
            // Mid-stream gap: stop reading; requestGapReconnect already aborted.
            if (result.outcome === 'gap') {
              gapAbort = true;
              try {
                reader.cancel();
              } catch {
                /* ignore */
              }
            }
          },
        });

        const onAbort = () => {
          parser.abort();
          try {
            reader.cancel();
          } catch {
            /* ignore */
          }
        };
        ctrl.signal.addEventListener('abort', onAbort, { once: true });

        try {
          while (true) {
            if (generations.get(runId) !== generation || ctrl.signal.aborted || gapAbort) {
              break;
            }
            const { done, value } = await reader.read();
            if (done) {
              parser.flush();
              break;
            }
            parser.feed(value);
            if (gapAbort) break;
          }
        } finally {
          ctrl.signal.removeEventListener('abort', onAbort);
          try {
            reader.releaseLock?.();
          } catch {
            /* ignore */
          }
        }

        if (generations.get(runId) !== generation) return;

        // Gap recovery: re-subscribe from unchanged lastSequence (bounded).
        if (gapReconnectPending.has(runId) || gapAbort) {
          const count = gapRecoveryCounts.get(runId) || 0;
          if (count > maxGapRecoveries) {
            gapReconnectPending.delete(runId);
            setStatus(runId, 'error');
            return;
          }
          setStatus(runId, 'reconnecting');
          const delay = Math.min(
            retryMaxMs,
            retryBaseMs * Math.pow(2, Math.max(0, count - 1)),
          );
          await sleep(delay);
          continue;
        }

        // Stream ended cleanly — if run still non-terminal, reconnect
        const run = store.runsById[runId];
        if (run && isTerminalRunStatus(run.status)) {
          setStatus(runId, 'closed');
          return;
        }
        throw new Error('SSE stream ended');
      } catch (err) {
        if (generations.get(runId) !== generation) return;
        const error = err as Error & { name?: string };

        // Gap recovery abort: continue loop with same cursor (not user disconnect).
        if (error.name === 'AbortError' && gapReconnectPending.has(runId)) {
          const count = gapRecoveryCounts.get(runId) || 0;
          if (count > maxGapRecoveries) {
            gapReconnectPending.delete(runId);
            setStatus(runId, 'error');
            return;
          }
          setStatus(runId, 'reconnecting');
          const delay = Math.min(
            retryMaxMs,
            retryBaseMs * Math.pow(2, Math.max(0, count - 1)),
          );
          await sleep(delay);
          continue;
        }

        if (error.name === 'AbortError') {
          setStatus(runId, 'closed');
          return;
        }

        conn.retryCount += 1;
        if (conn.retryCount > maxRetries) {
          try {
            await options.reconcileRun?.(runId);
            const recovered = store.runsById[runId];
            if (recovered && isTerminalRunStatus(recovered.status)) {
              setStatus(runId, 'closed');
              return;
            }
          } catch {
            // Keep the connection error visible when authoritative recovery
            // itself is unavailable; callers can retry from the UI.
          }
          setStatus(runId, 'error');
          return;
        }

        setStatus(runId, 'reconnecting');
        const delay = Math.min(
          retryMaxMs,
          retryBaseMs * Math.pow(2, conn.retryCount - 1),
        );
        await sleep(delay);
      }
    }
  }

  function connect(
    runId: string,
    opts: { lastEventId?: string | null; lastSequence?: number } = {},
  ): void {
    if (!runId) return;
    const existing = connections.get(runId);
    if (
      existing &&
      (existing.connectionStatus === 'connected' ||
        existing.connectionStatus === 'connecting' ||
        existing.connectionStatus === 'reconnecting')
    ) {
      return; // already live
    }

    getOrCreateConn(runId, {
      lastEventId: opts.lastEventId,
      lastSequence: opts.lastSequence,
      retryCount: 0,
    });
    // Fresh connect resets gap budget for this subscription generation
    gapRecoveryCounts.set(runId, 0);
    gapReconnectPending.delete(runId);

    const gen = (generations.get(runId) || 0) + 1;
    generations.set(runId, gen);
    void streamLoop(runId, gen);
  }

  function disconnect(runId: string): void {
    gapReconnectPending.delete(runId);
    generations.set(runId, (generations.get(runId) || 0) + 1);
    const ctrl = abortControllers.get(runId);
    if (ctrl) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
      abortControllers.delete(runId);
    }
    const conn = connections.get(runId);
    if (conn) {
      conn.connectionStatus = 'closed';
    }
  }

  function disconnectAll(): void {
    for (const runId of [...connections.keys()]) {
      disconnect(runId);
    }
  }

  return {
    getStore: () => store,
    setStore: (s) => {
      store = s;
    },
    getConnection: (runId) => connections.get(runId) || null,
    listConnections: () => [...connections.values()],
    connect,
    disconnect,
    disconnectAll,
    handleEvent,
    handleRuntimeEvent,
    hasActiveConnections: () =>
      [...connections.values()].some(
        (c) =>
          c.connectionStatus === 'connected' ||
          c.connectionStatus === 'connecting' ||
          c.connectionStatus === 'reconnecting',
      ),
    getGapRecoveryCount: (runId) => gapRecoveryCounts.get(runId) || 0,
  };
}
