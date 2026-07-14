/**
 * Run-centric API adapters (ADR 0003 §14, §16).
 * Core Run endpoints fail loudly so API contract regressions are visible.
 */
import {
  CreateRunResponseSchema,
  RunDetailSchema,
  type CreateRunResponse,
  type RunDetail,
} from '../schemas/events';
import { parseApiStrict } from '../schemas/api';
import { authHeaders, ApiError } from './client';
import type { SSEEvent } from '../sse/parser';
import { readSSEStream } from '../sse/parser';

export type { CreateRunResponse, RunDetail };

const BASE = '/api';

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
    const resp = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
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

/**
 * POST /runs/{run_id}/cancel — user-initiated stop only.
 */
export async function cancelRun(runId: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/cancel`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
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
  } = {},
): Promise<void> {
  const headers = authHeaders({ Accept: 'text/event-stream' });
  if (opts.lastEventId) {
    headers['Last-Event-ID'] = opts.lastEventId;
  }

  const qs =
    opts.afterSequence != null && opts.afterSequence > 0
      ? `?after_sequence=${encodeURIComponent(String(opts.afterSequence))}`
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

  await readSSEStream(resp, onEvent, opts.signal);
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
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/steer`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
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
 * POST /api/runs/{run_id}/follow-up — queue text after current run work.
 * Contract failures are surfaced to the caller.
 */
export async function followUpRun(
  runId: string,
  body: { text: string; conversation_id?: string | null },
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const resp = await fetch(
      `${BASE}/runs/${encodeURIComponent(runId)}/follow-up`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          text: body.text,
          conversation_id: body.conversation_id ?? null,
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
    return { ok: true, data: await resp.json().catch(() => ({})) };
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
