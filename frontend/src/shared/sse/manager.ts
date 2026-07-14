/**
 * Per-run SSE Manager (ADR 0003 §14).
 *
 * Tracks lastEventId, connectionStatus, retryCount, abortController per runId.
 * Supports Last-Event-ID resume, auto-reconnect, event dedupe, out-of-order detection.
 * Conversation switches do NOT cancel background run connections.
 */
import type { ConnectionStatus, EntityStore, RunSSEState } from '../../entities/types';
import { isTerminalRunStatus } from '../../entities/store';
import type { RuntimeEvent } from '../schemas/events';
import { parseRuntimeEvent } from '../schemas/events';
import { reduceRuntimeEvent, type ReduceResult } from '../state/runReducer';
import { createSSEParser, type SSEEvent } from './parser';
import { authHeaders } from '../api/client';

export type RunSSEManagerOptions = {
  /** Base path for run events, default `/api/runs`. */
  basePath?: string;
  /** Max reconnect attempts before giving up. */
  maxRetries?: number;
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

  function handleRuntimeEvent(ev: RuntimeEvent): ReduceResult {
    const conn = getOrCreateConn(ev.run_id);
    const result = reduceRuntimeEvent(store, ev, {
      seenEventIds: conn.seenEventIds,
    });

    if (result.outcome === 'applied' || result.outcome === 'gap') {
      store = result.store;
      conn.lastEventId = ev.event_id;
      conn.lastSequence = ev.sequence;
      options.onStoreChange?.(store);

      // Auto-close when run reaches terminal status
      const run = store.runsById[ev.run_id];
      if (run && isTerminalRunStatus(run.status)) {
        // Schedule disconnect without cancelling mid-handler
        queueMicrotask(() => {
          disconnect(ev.run_id);
          setStatus(ev.run_id, 'closed');
        });
      }
    }

    options.onEvent?.(ev.run_id, result, ev);
    return result;
  }

  function handleEvent(raw: unknown): ReduceResult {
    const ev = parseRuntimeEvent(raw);
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
   * Supports both:
   * - Runtime envelope: { event_id, sequence, run_id, type, payload }
   * - SSE with `id:` field already consumed by caller as lastEventId
   */
  function coerceEvent(raw: SSEEvent, runId: string, conn: RunSSEState): RuntimeEvent | null {
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
      const ctrl = new AbortController();
      abortControllers.set(runId, ctrl);

      const isRetry = conn.retryCount > 0;
      setStatus(runId, isRetry ? 'reconnecting' : 'connecting');

      try {
        const headers = authHeaders({
          Accept: 'text/event-stream',
        });
        // Last-Event-ID for sequence resume (ADR §14)
        if (conn.lastEventId) {
          headers['Last-Event-ID'] = conn.lastEventId;
        }

        const url = `${basePath}/${encodeURIComponent(runId)}/events`;
        // Also pass after_sequence as query for backends that prefer it
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

        setStatus(runId, 'connected');
        conn.retryCount = 0;

        const reader = resp.body.getReader();
        const parser = createSSEParser({
          onEvent: (raw) => {
            if (generations.get(runId) !== generation) return;
            const ev = coerceEvent(raw, runId, conn);
            if (ev) handleRuntimeEvent(ev);
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
            if (generations.get(runId) !== generation || ctrl.signal.aborted) break;
            const { done, value } = await reader.read();
            if (done) {
              parser.flush();
              break;
            }
            parser.feed(value);
          }
        } finally {
          ctrl.signal.removeEventListener('abort', onAbort);
          try {
            reader.releaseLock?.();
          } catch {
            /* ignore */
          }
        }

        // Stream ended cleanly — if run still non-terminal, reconnect
        if (generations.get(runId) !== generation) return;
        const run = store.runsById[runId];
        if (run && isTerminalRunStatus(run.status)) {
          setStatus(runId, 'closed');
          return;
        }
        // Fall through to reconnect
        throw new Error('SSE stream ended');
      } catch (err) {
        if (generations.get(runId) !== generation) return;
        const error = err as Error & { name?: string };
        if (error.name === 'AbortError') {
          setStatus(runId, 'closed');
          return;
        }

        conn.retryCount += 1;
        if (conn.retryCount > maxRetries) {
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

    const gen = (generations.get(runId) || 0) + 1;
    generations.set(runId, gen);
    void streamLoop(runId, gen);
  }

  function disconnect(runId: string): void {
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
  };
}
