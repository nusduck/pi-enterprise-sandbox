/**
 * In-process agent run registry.
 * - Creates runs with durable-in-memory sequenced event logs
 * - Streams events via SSE subscribers (supports ?after=N resume)
 * - Cancel is idempotent
 *
 * Multi-replica note: only one worker should execute a given run; this registry
 * is process-local. Sandbox DB agent-runs provide cross-process lease/status.
 */
import { randomUUID } from 'node:crypto';
import { runAgentTurn } from './chat-runner.js';

/** @typedef {'queued'|'running'|'completed'|'cancelled'|'failed'} RunStatus */

/**
 * @typedef {object} AgentRun
 * @property {string} id
 * @property {RunStatus} status
 * @property {string|null} conversation_id
 * @property {string|null} sandbox_run_id
 * @property {string|null} error
 * @property {number} created_at
 * @property {number} updated_at
 * @property {Array<{ sequence: number, event: object, ts: number }>} events
 * @property {number} nextSequence
 * @property {Set<(entry: { sequence: number, event: object, ts: number }) => void>} subscribers
 * @property {boolean} cancelled
 * @property {{ session?: object, sandboxSessionId?: string, client?: object }|null} handles
 * @property {Promise<object>|null} done
 */

/** @type {Map<string, AgentRun>} */
const runs = new Map();

const MAX_RUNS = 500;
const RUN_TTL_MS = 30 * 60 * 1000;

function now() {
  return Date.now();
}

function pruneOldRuns() {
  if (runs.size <= MAX_RUNS) {
    const cutoff = now() - RUN_TTL_MS;
    for (const [id, run] of runs) {
      if (
        (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') &&
        run.updated_at < cutoff
      ) {
        runs.delete(id);
      }
    }
    return;
  }
  // Drop oldest terminal runs first
  const terminal = [...runs.entries()]
    .filter(([, r]) => r.status !== 'queued' && r.status !== 'running')
    .sort((a, b) => a[1].updated_at - b[1].updated_at);
  while (runs.size > MAX_RUNS && terminal.length) {
    const [id] = terminal.shift();
    runs.delete(id);
  }
}

/**
 * Append an event to the run log and fan out to live subscribers.
 * @param {AgentRun} run
 * @param {object} event
 */
function appendEvent(run, event) {
  const sequence = run.nextSequence++;
  const entry = { sequence, event, ts: now() };
  run.events.push(entry);
  run.updated_at = entry.ts;
  for (const sub of run.subscribers) {
    try {
      sub(entry);
    } catch {
      /* ignore subscriber errors */
    }
  }
  return entry;
}

/**
 * Create and start an agent run.
 *
 * @param {{
 *   messages: unknown[],
 *   conversation_id?: string|null,
 *   auth?: object|null,
 *   trace_id?: string|null,
 * }} body
 */
export function createRun(body) {
  pruneOldRuns();
  const id = `arun_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  /** @type {AgentRun} */
  const run = {
    id,
    status: 'queued',
    conversation_id: body.conversation_id || null,
    sandbox_run_id: null,
    error: null,
    created_at: now(),
    updated_at: now(),
    events: [],
    nextSequence: 1,
    subscribers: new Set(),
    cancelled: false,
    handles: null,
    done: null,
  };
  runs.set(id, run);

  run.done = (async () => {
    run.status = 'running';
    run.updated_at = now();
    try {
      const result = await runAgentTurn({
        messages: body.messages || [],
        conversation_id: body.conversation_id || null,
        auth: body.auth || null,
        trace_id: body.trace_id || null,
        emit: (event) => {
          if (run.cancelled && event?.type !== 'session_closed' && event?.type !== 'done' && event?.type !== 'error') {
            // Still record late terminal-ish events after cancel
          }
          appendEvent(run, event);
          // Capture conversation_id from session event
          if (event?.type === 'session' && event.conversation_id) {
            run.conversation_id = event.conversation_id;
          }
          if (event?.type === 'session' && event.run_id) {
            run.sandbox_run_id = event.run_id;
          }
        },
        isCancelled: () => run.cancelled,
        onSessionReady: (handles) => {
          run.handles = handles;
        },
      });

      if (run.cancelled) {
        run.status = 'cancelled';
      } else if (result.status === 'failed') {
        run.status = 'failed';
        run.error = result.error || 'failed';
      } else if (result.status === 'cancelled') {
        run.status = 'cancelled';
      } else {
        run.status = 'completed';
      }
      if (result.conversation_id) run.conversation_id = result.conversation_id;
      if (result.run_id) run.sandbox_run_id = result.run_id;
    } catch (err) {
      run.status = 'failed';
      run.error = err?.message || String(err);
      appendEvent(run, { type: 'error', message: run.error });
      appendEvent(run, { type: 'done' });
    } finally {
      run.updated_at = now();
      run.handles = null;
      // Notify subscribers that stream may end
      for (const sub of run.subscribers) {
        try {
          sub({ sequence: -1, event: { type: '__run_terminal__' }, ts: now() });
        } catch {
          /* ignore */
        }
      }
    }
    return {
      id: run.id,
      status: run.status,
      conversation_id: run.conversation_id,
      sandbox_run_id: run.sandbox_run_id,
      error: run.error,
    };
  })();

  return {
    run_id: id,
    status: run.status,
    conversation_id: run.conversation_id,
  };
}

/**
 * @param {string} runId
 */
export function getRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;
  return {
    run_id: run.id,
    status: run.status,
    conversation_id: run.conversation_id,
    sandbox_run_id: run.sandbox_run_id,
    error: run.error,
    created_at: run.created_at,
    updated_at: run.updated_at,
    event_count: run.events.length,
    next_sequence: run.nextSequence,
  };
}

/**
 * Subscribe to events after a given sequence (exclusive).
 * Returns an unsubscribe function.
 *
 * @param {string} runId
 * @param {number} after
 * @param {(entry: { sequence: number, event: object, ts: number }) => void} onEvent
 * @returns {(() => void)|null}
 */
export function subscribeEvents(runId, after, onEvent) {
  const run = runs.get(runId);
  if (!run) return null;

  // Replay existing events with sequence > after
  for (const entry of run.events) {
    if (entry.sequence > after) {
      try {
        onEvent(entry);
      } catch {
        /* ignore */
      }
    }
  }

  // If already terminal, send sentinel after replay
  if (run.status !== 'queued' && run.status !== 'running') {
    try {
      onEvent({ sequence: -1, event: { type: '__run_terminal__' }, ts: now() });
    } catch {
      /* ignore */
    }
    return () => {};
  }

  run.subscribers.add(onEvent);
  return () => {
    run.subscribers.delete(onEvent);
  };
}

/**
 * Idempotent cancel.
 * @param {string} runId
 */
export async function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;

  if (run.status === 'completed' || run.status === 'cancelled' || run.status === 'failed') {
    return {
      run_id: run.id,
      status: run.status,
      cancelled: run.status === 'cancelled',
    };
  }

  run.cancelled = true;
  run.updated_at = now();

  // Best-effort abort of live SDK session + sandbox work
  const handles = run.handles;
  if (handles) {
    try {
      if (handles.session && typeof handles.session.abort === 'function') {
        handles.session.abort();
      }
    } catch {
      /* ignore */
    }
    try {
      if (handles.client && handles.sandboxSessionId) {
        await handles.client.cancelActiveExecution(handles.sandboxSessionId).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  appendEvent(run, { type: 'error', message: 'run cancelled' });
  // Wait briefly for runner to finish if in-flight
  if (run.done) {
    try {
      await Promise.race([
        run.done,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* ignore */
    }
  }

  if (run.status === 'queued' || run.status === 'running') {
    run.status = 'cancelled';
    run.updated_at = now();
    // Ensure terminal markers for SSE consumers
    const hasDone = run.events.some((e) => e.event?.type === 'done');
    if (!hasDone) appendEvent(run, { type: 'done' });
    for (const sub of run.subscribers) {
      try {
        sub({ sequence: -1, event: { type: '__run_terminal__' }, ts: now() });
      } catch {
        /* ignore */
      }
    }
  }

  return {
    run_id: run.id,
    status: run.status,
    cancelled: true,
  };
}

/** Active running/queued count — used by /ready */
export function activeRunCount() {
  let n = 0;
  for (const run of runs.values()) {
    if (run.status === 'queued' || run.status === 'running') n += 1;
  }
  return n;
}

/** Test helper — wipe all runs */
export function _resetForTests() {
  runs.clear();
}
