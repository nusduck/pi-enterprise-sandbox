/**
 * Run-centric API adapters (ADR 0003 §14, §16).
 * Core Run endpoints fail loudly so API contract regressions are visible.
 */
import {
  CreateRunResponseSchema,
  RunDetailSchema,
  ToolExecutionSnapshotSchema,
  RunTraceResponseSchema,
  type CreateRunResponse,
  type RunDetail,
  type ToolExecutionSnapshot,
  type RunTraceResponse,
} from '../schemas/events';
import { parseApiStrict } from '../schemas/api';
import { authHeaders, ApiError } from './client';
import type { SSEEvent } from '../sse/parser';
import { readSSEStream } from '../sse/parser';

export type { CreateRunResponse, RunDetail, ToolExecutionSnapshot };
export type { RunTraceResponse };

const BASE = '/api';

function createIdempotencyKey(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}_${uuid}`
    : `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * POST /runs — create a run and return run_id.
 */
export async function createRun(body: {
  conversation_id?: string | null;
  session_id?: string | null;
  messages?: unknown[];
}): Promise<CreateRunResponse> {
  try {
    const headers = authHeaders({ 'Content-Type': 'application/json' });
    headers['Idempotency-Key'] = createIdempotencyKey('run');
    const resp = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `Create run failed: ${resp.status}`),
        {
          status: resp.status,
          traceId: (err.trace_id as string) || resp.headers.get('x-trace-id'),
        },
      );
    }
    return parseApiStrict(CreateRunResponseSchema, await resp.json(), 'createRun');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Create run failed');
  }
}

/**
 * GET /runs/{run_id} — fetch run detail for rehydrate after refresh.
 */
export async function getRun(runId: string): Promise<RunDetail> {
  try {
    const resp = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || `Get run failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return parseApiStrict(RunDetailSchema, await resp.json(), 'getRun');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Get run failed');
  }
}

/** GET /runs/{run_id}/tools — authoritative durable ledger snapshot. */
export async function listRunTools(runId: string): Promise<ToolExecutionSnapshot[]> {
  try {
    const resp = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}/tools`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || `List run tools failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    const data = await resp.json();
    const rows: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.tools)
        ? data.tools
        : [];
    return rows.map((row) =>
      parseApiStrict(ToolExecutionSnapshotSchema, row, 'listRunTools'),
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'List run tools failed');
  }
}

/** GET /runs/{run_id}/trace — durable owner-scoped trace projection. */
export async function getRunTraceSpans(
  runId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<RunTraceResponse> {
  try {
    const query = new URLSearchParams();
    if (opts.limit != null) query.set('limit', String(opts.limit));
    if (opts.cursor) query.set('cursor', String(opts.cursor));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/trace${suffix}`,
      {
        headers: authHeaders(),
      },
    );
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || `Get run trace failed: ${resp.status}`),
        { status: resp.status, traceId: resp.headers.get('x-trace-id') },
      );
    }
    return parseApiStrict(
      RunTraceResponseSchema,
      await resp.json(),
      'getRunTraceSpans',
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Get run trace failed');
  }
}

/**
 * POST /runs/{run_id}/cancel — user-initiated stop only.
 */
export async function cancelRun(runId: string): Promise<boolean> {
  try {
    const headers = authHeaders({ 'Content-Type': 'application/json' });
    headers['Idempotency-Key'] = createIdempotencyKey('cancel');
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      },
    );
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || `Cancel run failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return true;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Cancel run failed');
  }
}

/**
 * GET /runs/{run_id}/events — open SSE stream with Last-Event-ID.
 * Prefer RunSSEManager for production use; this is a thin helper.
 */
export async function streamRunEvents(
  runId: string,
  onEvent: (ev: SSEEvent) => void,
  opts: {
    signal?: AbortSignal | null;
    lastEventId?: string | null;
    afterSequence?: number | null;
    maxRetries?: number;
    retryBaseMs?: number;
    retryMaxMs?: number;
  } = {},
): Promise<void> {
  let cursor = opts.afterSequence ?? 0;
  let lastEventId = opts.lastEventId || null;
  let lastError: Error | null = null;
  const maxRetries = opts.maxRetries ?? 6;
  const retryBaseMs = opts.retryBaseMs ?? 250;
  const retryMaxMs = opts.retryMaxMs ?? 2_000;
  // Agent MySQL authority uses SUCCEEDED (uppercase). UI/entity layer uses
  // lowercase "succeeded". Accept both, plus BFF/legacy aliases.
  const terminalStatuses = new Set([
    'completed',
    'succeeded',
    'failed',
    'cancelled',
    'canceled',
    'interrupted',
    'budget_exceeded',
    'rejected',
    'waiting_approval',
    'waiting_input',
  ]);
  const isTerminalRunStatus = (status: unknown): boolean =>
    terminalStatuses.has(String(status ?? '').trim().toLowerCase());

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (opts.signal?.aborted) {
      const abort = new Error('Run event stream aborted');
      abort.name = 'AbortError';
      throw abort;
    }
    try {
      const headers = authHeaders({ Accept: 'text/event-stream' });
      if (lastEventId) headers['Last-Event-ID'] = lastEventId;
      const qs = cursor > 0
        ? `?after_sequence=${encodeURIComponent(String(cursor))}`
        : '';
      const resp = await fetch(
        `${BASE}/runs/${encodeURIComponent(runId)}/events${qs}`,
        {
          method: 'GET',
          headers,
          signal: opts.signal ?? undefined,
        },
      );

      if (!resp.ok) {
        throw new ApiError(`Run events failed: ${resp.status}`, {
          status: resp.status,
        });
      }

      await readSSEStream(resp, (event) => {
        if (typeof event.sequence === 'number') cursor = Math.max(cursor, event.sequence);
        if (event.event_id != null) lastEventId = String(event.event_id);
        onEvent(event);
      }, opts.signal);

      // A closed stream is not a completion signal. Ask the authoritative
      // run endpoint before deciding whether to stop or reconnect.
      const snapshot = await getRun(runId);
      if (isTerminalRunStatus(snapshot.status)) return;
      lastError = new Error('Run event stream ended before terminal state');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError' || opts.signal?.aborted) throw error;
      lastError = error;
    }

    if (attempt >= maxRetries) {
      // One final authoritative read distinguishes a lost SSE completion from
      // a genuinely unavailable run. Never synthesize success here.
      try {
        const snapshot = await getRun(runId);
        if (isTerminalRunStatus(snapshot.status)) return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
      throw lastError || new Error('Run event stream recovery exhausted');
    }

    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** attempt);
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const signal = opts.signal;
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delay);
      if (!signal) return;
      onAbort = () => {
        cleanup();
        const abort = new Error('Run event stream aborted');
        abort.name = 'AbortError';
        reject(abort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * List runs, optionally scoped to a conversation and status.
 */
export async function listRuns(opts: {
  conversation_id?: string;
  status?: string;
} = {}): Promise<RunDetail[]> {
  const q = new URLSearchParams();
  if (opts.conversation_id) q.set('conversation_id', opts.conversation_id);
  if (opts.status) q.set('status', opts.status);
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(`${BASE}/runs${qs}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(String(err.error || `List runs failed: ${resp.status}`), {
      status: resp.status,
      traceId: resp.headers.get('x-trace-id'),
    });
  }
  const data = (await resp.json()) as unknown;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { runs?: unknown[] })?.runs)
      ? (data as { runs: unknown[] }).runs
      : [];
  return list.map((item) => parseApiStrict(RunDetailSchema, item, 'listRuns'));
}

/**
 * POST /api/runs/{run_id}/steer — change current execution direction.
 * Contract failures are surfaced to the caller.
 */
export async function steerRun(
  runId: string,
  body: { text: string; conversation_id?: string | null },
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const headers = authHeaders({ 'Content-Type': 'application/json' });
    headers['Idempotency-Key'] = createIdempotencyKey('steer');
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/steer`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: body.text,
          conversation_id: body.conversation_id ?? null,
        }),
      },
    );
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `Steer failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return { ok: true, data: await resp.json().catch(() => ({})) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Steer failed');
  }
}

/**
 * POST /api/conversations/{conversation_id}/follow-ups — create the next Run.
 * The returned Run is durable and must be tracked through its own SSE stream.
 */
export async function followUpRun(
  conversationId: string,
  body: { text: string; agent_id?: string | null },
): Promise<CreateRunResponse> {
  try {
    const headers = authHeaders({ 'Content-Type': 'application/json' });
    headers['Idempotency-Key'] = createIdempotencyKey('follow_up');
    const resp = await fetch(
      `${BASE}/conversations/${encodeURIComponent(conversationId)}/follow-ups`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: body.text,
          agent_id: body.agent_id ?? null,
        }),
      },
    );
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `Follow-up failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return parseApiStrict(
      CreateRunResponseSchema,
      await resp.json(),
      'followUpRun',
    );
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Follow-up failed');
  }
}

/**
 * POST /api/runs/{run_id}/resume-approval — recover parked approval wait.
 * Contract failures are surfaced to the caller.
 */
export async function resumeApproval(
  runId: string,
  body: { decision?: string; reason?: string } = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/resume-approval`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
    );
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `Resume failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return { ok: true, data: await resp.json().catch(() => ({})) };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError((err as Error).message || 'Resume failed');
  }
}

export async function respondInteraction(
  runId: string,
  interactionId: string,
  response: unknown,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const resp = await fetch(
    `${BASE}/runs/${encodeURIComponent(runId)}` +
      `/interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ response }),
    },
  );
  if (!resp.ok) {
    const err = await errorBody(resp);
    throw new ApiError(String(err.error || `Interaction failed: ${resp.status}`), {
      status: resp.status,
    });
  }
  return { ok: true, data: await resp.json().catch(() => ({})) };
}
