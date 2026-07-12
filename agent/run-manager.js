/**
 * In-process agent run registry.
 * - Creates runs with durable-in-memory sequenced event logs
 * - Streams events via SSE subscribers (supports ?after=N resume)
 * - Cancel is idempotent
 * - B6: steer / follow-up (conversation-scoped), budgets, recoverable approval
 *
 * Multi-replica note: only one worker should execute a given run; this registry
 * is process-local. Sandbox DB agent-runs provide cross-process lease/status.
 */
import { randomUUID } from 'node:crypto';
import { runAgentTurn, resumeAgentTurnAfterApproval } from './chat-runner.js';
import { createBudgetTracker, resolveBudgetLimits } from './services/budget.js';
import {
  resolveApproval,
  getPendingApproval,
  getPendingApprovalForRun,
  clearPendingApproval,
  clearPendingForRun,
  _resetApprovalWaiters,
} from './services/approval-waiter.js';

/**
 * @typedef {'queued'|'running'|'waiting_approval'|'completed'|'cancelled'|'failed'|'budget_exceeded'|'rejected'} RunStatus
 */

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
 * @property {{ session?: object, sandboxSessionId?: string, client?: object, budget?: object }|null} handles
 * @property {Promise<object>|null} done
 * @property {ReturnType<typeof createBudgetTracker>|null} budget
 * @property {object|null} budget_limits
 * @property {object|null} pending_approval
 * @property {object|null} auth
 * @property {string|null} trace_id
 * @property {unknown[]} messages
 */

/** @type {Map<string, AgentRun>} */
const runs = new Map();

const MAX_RUNS = 500;
const RUN_TTL_MS = 30 * 60 * 1000;

/** Terminal statuses that free the run for pruning. */
const TERMINAL = new Set([
  'completed',
  'cancelled',
  'failed',
  'budget_exceeded',
  'rejected',
]);

/** Statuses that still accept steer/follow-up. */
const ACTIVE_STREAMING = new Set(['queued', 'running']);

function now() {
  return Date.now();
}

function pruneOldRuns() {
  if (runs.size <= MAX_RUNS) {
    const cutoff = now() - RUN_TTL_MS;
    for (const [id, run] of runs) {
      if (TERMINAL.has(run.status) && run.updated_at < cutoff) {
        runs.delete(id);
      }
    }
    return;
  }
  const terminal = [...runs.entries()]
    .filter(([, r]) => TERMINAL.has(r.status))
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

function notifyTerminal(run) {
  for (const sub of run.subscribers) {
    try {
      sub({ sequence: -1, event: { type: '__run_terminal__' }, ts: now() });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Public snapshot of a run.
 * @param {AgentRun} run
 */
function toPublic(run) {
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
    budget: run.budget ? run.budget.snapshot() : null,
    budget_limits: run.budget_limits || null,
    pending_approval: run.pending_approval || null,
  };
}

/**
 * Create and start an agent run.
 *
 * @param {{
 *   messages: unknown[],
 *   conversation_id?: string|null,
 *   auth?: object|null,
 *   trace_id?: string|null,
 *   budget?: object|null,
 * }} body
 */
export function createRun(body) {
  pruneOldRuns();
  const id = `arun_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const budgetLimits = resolveBudgetLimits(body.budget || null);
  const budget = createBudgetTracker(budgetLimits);

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
    budget,
    budget_limits: budgetLimits,
    pending_approval: null,
    auth: body.auth || null,
    trace_id: body.trace_id || null,
    messages: Array.isArray(body.messages) ? body.messages : [],
  };
  runs.set(id, run);

  run.done = (async () => {
    run.status = 'running';
    run.updated_at = now();
    try {
      const result = await runAgentTurn({
        messages: run.messages,
        conversation_id: run.conversation_id,
        auth: run.auth,
        trace_id: run.trace_id,
        budget,
        emit: (event) => {
          if (
            run.cancelled &&
            event?.type !== 'session_closed' &&
            event?.type !== 'done' &&
            event?.type !== 'error'
          ) {
            // Still record late terminal-ish events after cancel
          }
          appendEvent(run, event);
          if (event?.type === 'session' && event.conversation_id) {
            run.conversation_id = event.conversation_id;
          }
          if (event?.type === 'session' && event.run_id) {
            run.sandbox_run_id = event.run_id;
          }
        },
        isCancelled: () => run.cancelled,
        onSessionReady: (handles) => {
          run.handles = { ...handles, budget };
        },
        onApprovalSuspend: async (pending) => {
          run.pending_approval = pending;
          run.status = 'waiting_approval';
          run.updated_at = now();
          appendEvent(run, {
            type: 'approval_required',
            approval_id: pending.approval_id,
            tool_name: pending.tool_name,
            command: pending.params?.command,
            path: pending.params?.path,
            reason: pending.reason,
            risk_level: pending.risk_level,
            policy_version: pending.policy_version,
            run_id: run.id,
            conversation_id: run.conversation_id,
          });
          appendEvent(run, {
            type: 'run_status',
            status: 'waiting_approval',
            approval_id: pending.approval_id,
          });
          // Release live SDK handles so waiting does not pin execution resources.
          run.handles = null;
        },
      });

      if (run.cancelled) {
        run.status = 'cancelled';
      } else if (result.status === 'waiting_approval') {
        run.status = 'waiting_approval';
        run.pending_approval = result.pending_approval || run.pending_approval;
        // Do not emit done — run is parked and resumable.
      } else if (result.status === 'budget_exceeded') {
        run.status = 'budget_exceeded';
        run.error = result.error || 'budget_exceeded';
      } else if (result.status === 'failed') {
        run.status = 'failed';
        run.error = result.error || 'failed';
      } else if (result.status === 'cancelled') {
        run.status = 'cancelled';
      } else if (result.status === 'rejected') {
        run.status = 'rejected';
        run.error = result.error || 'rejected';
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
      if (run.status !== 'waiting_approval') {
        run.handles = null;
        notifyTerminal(run);
      }
    }
    return toPublic(run);
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
  return toPublic(run);
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

  for (const entry of run.events) {
    if (entry.sequence > after) {
      try {
        onEvent(entry);
      } catch {
        /* ignore */
      }
    }
  }

  // waiting_approval is non-terminal for SSE (resume may continue the stream)
  if (TERMINAL.has(run.status)) {
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
 * Map text to session.steer — only the bound run's live session.
 * Conversation scoping: rejects if conversation_id is provided and mismatches.
 *
 * @param {string} runId
 * @param {{ text: string, conversation_id?: string|null }} body
 */
export async function steerRun(runId, body) {
  const run = runs.get(runId);
  if (!run) return null;

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return { error: 'text is required', status: 400 };
  }

  if (
    body?.conversation_id &&
    run.conversation_id &&
    body.conversation_id !== run.conversation_id
  ) {
    return {
      error: 'conversation_id does not match run (cross-talk rejected)',
      status: 409,
      conversation_id: run.conversation_id,
    };
  }

  if (!ACTIVE_STREAMING.has(run.status)) {
    return {
      error: `run is ${run.status}; steer only allowed while running`,
      status: 409,
      run_id: run.id,
      status_run: run.status,
    };
  }

  const session = run.handles?.session;
  if (!session || typeof session.steer !== 'function') {
    return {
      error: 'session not ready for steer',
      status: 409,
      run_id: run.id,
    };
  }

  try {
    await session.steer(text);
    appendEvent(run, {
      type: 'steer',
      text: text.slice(0, 4000),
      conversation_id: run.conversation_id,
      run_id: run.id,
    });
    return {
      run_id: run.id,
      status: run.status,
      conversation_id: run.conversation_id,
      accepted: true,
      kind: 'steer',
    };
  } catch (err) {
    return {
      error: err?.message || String(err),
      status: 500,
      run_id: run.id,
    };
  }
}

/**
 * Map text to session.followUp — queues after current work on this run only.
 *
 * @param {string} runId
 * @param {{ text: string, conversation_id?: string|null }} body
 */
export async function followUpRun(runId, body) {
  const run = runs.get(runId);
  if (!run) return null;

  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return { error: 'text is required', status: 400 };
  }

  if (
    body?.conversation_id &&
    run.conversation_id &&
    body.conversation_id !== run.conversation_id
  ) {
    return {
      error: 'conversation_id does not match run (cross-talk rejected)',
      status: 409,
      conversation_id: run.conversation_id,
    };
  }

  if (!ACTIVE_STREAMING.has(run.status) && run.status !== 'waiting_approval') {
    return {
      error: `run is ${run.status}; follow-up only allowed while running or waiting_approval`,
      status: 409,
      run_id: run.id,
      status_run: run.status,
    };
  }

  const session = run.handles?.session;
  if (session && typeof session.followUp === 'function') {
    try {
      await session.followUp(text);
      appendEvent(run, {
        type: 'follow_up',
        text: text.slice(0, 4000),
        conversation_id: run.conversation_id,
        run_id: run.id,
      });
      return {
        run_id: run.id,
        status: run.status,
        conversation_id: run.conversation_id,
        accepted: true,
        kind: 'follow_up',
      };
    } catch (err) {
      return {
        error: err?.message || String(err),
        status: 500,
        run_id: run.id,
      };
    }
  }

  // No live session (e.g. waiting_approval) — queue as pending message for resume.
  run.messages = [
    ...(run.messages || []),
    { role: 'user', content: text },
  ];
  appendEvent(run, {
    type: 'follow_up',
    text: text.slice(0, 4000),
    conversation_id: run.conversation_id,
    run_id: run.id,
    queued: true,
  });
  return {
    run_id: run.id,
    status: run.status,
    conversation_id: run.conversation_id,
    accepted: true,
    kind: 'follow_up',
    queued: true,
  };
}

/**
 * Idempotent cancel.
 * @param {string} runId
 */
export async function cancelRun(runId) {
  const run = runs.get(runId);
  if (!run) return null;

  if (TERMINAL.has(run.status)) {
    return {
      run_id: run.id,
      status: run.status,
      cancelled: run.status === 'cancelled',
    };
  }

  run.cancelled = true;
  run.updated_at = now();
  clearPendingForRun(runId);

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
        if (typeof handles.client.cancelSessionProcesses === 'function') {
          await handles.client
            .cancelSessionProcesses(handles.sandboxSessionId, false)
            .catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
  }

  appendEvent(run, { type: 'error', message: 'run cancelled' });

  if (run.done && run.status !== 'waiting_approval') {
    try {
      await Promise.race([
        run.done,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* ignore */
    }
  }

  if (!TERMINAL.has(run.status)) {
    run.status = 'cancelled';
    run.updated_at = now();
    const hasDone = run.events.some((e) => e.event?.type === 'done');
    if (!hasDone) appendEvent(run, { type: 'done' });
    notifyTerminal(run);
  }

  return {
    run_id: run.id,
    status: run.status,
    cancelled: true,
  };
}

/**
 * Resolve an in-process approval waiter (called after sandbox decide).
 * @param {string} approvalId
 * @param {{ decision: 'approve'|'reject', reason?: string }} body
 */
export function decideApprovalLocal(approvalId, body) {
  const decision =
    body?.decision === 'approve' || body?.decision === 'approved'
      ? 'approved'
      : 'rejected';
  const ok = resolveApproval(approvalId, {
    status: decision,
    reason: body?.reason,
    approval_id: approvalId,
  });
  return {
    approval_id: approvalId,
    resolved: ok,
    status: decision,
    pending: getPendingApproval(approvalId),
  };
}

/**
 * Resume a parked waiting_approval run after operator decide.
 *
 * @param {string} runId
 * @param {{ decision?: 'approve'|'reject'|'approved'|'rejected', reason?: string, approval_id?: string }} [body]
 */
export async function resumeRunAfterApproval(runId, body = {}) {
  const run = runs.get(runId);
  if (!run) return null;

  if (run.status !== 'waiting_approval') {
    return {
      error: `run is ${run.status}; resume only for waiting_approval`,
      status: 409,
      run_id: run.id,
    };
  }

  const pending =
    run.pending_approval ||
    getPendingApprovalForRun(runId) ||
    (body.approval_id ? getPendingApproval(body.approval_id) : null);

  if (!pending?.approval_id) {
    return {
      error: 'no pending approval context on run',
      status: 409,
      run_id: run.id,
    };
  }

  let decision = body.decision;
  if (decision === 'approve') decision = 'approved';
  if (decision === 'reject') decision = 'rejected';
  if (decision !== 'approved' && decision !== 'rejected') {
    return { error: "decision must be 'approve' or 'reject'", status: 400 };
  }

  // Wake any in-process waiter (no-op if already parked fully)
  resolveApproval(pending.approval_id, {
    status: decision,
    reason: body.reason,
    approval_id: pending.approval_id,
  });

  run.status = 'running';
  run.updated_at = now();
  appendEvent(run, {
    type: 'run_status',
    status: 'running',
    approval_id: pending.approval_id,
    decision,
  });

  run.done = (async () => {
    try {
      const result = await resumeAgentTurnAfterApproval({
        conversation_id: run.conversation_id,
        auth: run.auth,
        trace_id: run.trace_id,
        sandbox_run_id: run.sandbox_run_id,
        pending_approval: pending,
        decision,
        decision_reason: body.reason || null,
        budget: run.budget,
        messages: run.messages,
        emit: (event) => {
          appendEvent(run, event);
          if (event?.type === 'session' && event.conversation_id) {
            run.conversation_id = event.conversation_id;
          }
          if (event?.type === 'session' && event.run_id) {
            run.sandbox_run_id = event.run_id;
          }
        },
        isCancelled: () => run.cancelled,
        onSessionReady: (handles) => {
          run.handles = { ...handles, budget: run.budget };
        },
        onApprovalSuspend: async (nextPending) => {
          run.pending_approval = nextPending;
          run.status = 'waiting_approval';
          run.updated_at = now();
          appendEvent(run, {
            type: 'approval_required',
            approval_id: nextPending.approval_id,
            tool_name: nextPending.tool_name,
            run_id: run.id,
            conversation_id: run.conversation_id,
          });
          run.handles = null;
        },
      });

      clearPendingApproval(pending.approval_id);
      run.pending_approval = null;

      if (run.cancelled) {
        run.status = 'cancelled';
      } else if (result.status === 'waiting_approval') {
        run.status = 'waiting_approval';
        run.pending_approval = result.pending_approval || null;
      } else if (result.status === 'budget_exceeded') {
        run.status = 'budget_exceeded';
        run.error = result.error || 'budget_exceeded';
      } else if (result.status === 'failed') {
        run.status = 'failed';
        run.error = result.error || 'failed';
      } else if (result.status === 'rejected') {
        run.status = 'rejected';
        run.error = result.error || 'rejected';
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
      if (run.status !== 'waiting_approval') {
        run.handles = null;
        notifyTerminal(run);
      }
    }
    return toPublic(run);
  })();

  return {
    run_id: run.id,
    status: run.status,
    conversation_id: run.conversation_id,
    resumed: true,
    decision,
  };
}

/**
 * Rehydrate a waiting_approval run into the local registry after agent restart.
 * Does not hold SDK resources — only parks metadata until resume.
 *
 * @param {{
 *   run_id: string,
 *   conversation_id?: string|null,
 *   sandbox_run_id?: string|null,
 *   pending_approval?: object|null,
 *   budget?: object|null,
 *   auth?: object|null,
 *   messages?: unknown[],
 * }} snapshot
 */
export function rehydrateWaitingRun(snapshot) {
  if (!snapshot?.run_id) throw new Error('run_id required');
  if (runs.has(snapshot.run_id)) {
    return toPublic(runs.get(snapshot.run_id));
  }
  const budgetLimits = resolveBudgetLimits(snapshot.budget || null);
  /** @type {AgentRun} */
  const run = {
    id: snapshot.run_id,
    status: 'waiting_approval',
    conversation_id: snapshot.conversation_id || null,
    sandbox_run_id: snapshot.sandbox_run_id || null,
    error: null,
    created_at: now(),
    updated_at: now(),
    events: [],
    nextSequence: 1,
    subscribers: new Set(),
    cancelled: false,
    handles: null,
    done: null,
    budget: createBudgetTracker(budgetLimits),
    budget_limits: budgetLimits,
    pending_approval: snapshot.pending_approval || null,
    auth: snapshot.auth || null,
    trace_id: null,
    messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
  };
  runs.set(run.id, run);
  if (run.pending_approval?.approval_id) {
    // Register waiter so decide can resolve if someone was mid-flight
    // (resume path is the primary after restart)
  }
  appendEvent(run, {
    type: 'run_status',
    status: 'waiting_approval',
    rehydrated: true,
    approval_id: run.pending_approval?.approval_id,
  });
  return toPublic(run);
}

/** Active running/queued count — used by /ready (waiting_approval does not pin workers) */
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
  _resetApprovalWaiters();
}
