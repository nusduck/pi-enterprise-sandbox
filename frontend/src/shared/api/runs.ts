/**
 * Run-centric API adapters (ADR 0003 §14, §16).
 * When backend endpoints are incomplete, helpers soft-fail / stub so UI can rehydrate later.
 */
import {
  CreateRunResponseSchema,
  RunDetailSchema,
  type CreateRunResponse,
  type RunDetail,
} from '../schemas/events';
import { parseApi } from '../schemas/api';
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
 * Returns null when endpoint is not available yet (404/501).
 */
export async function createRun(body: {
  conversation_id?: string | null;
  session_id?: string | null;
  messages?: unknown[];
}): Promise<CreateRunResponse | null> {
  try {
    const resp = await fetch(`${BASE}/runs`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (resp.status === 404 || resp.status === 501 || resp.status === 405) {
      return null;
    }
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
    return parseApi(CreateRunResponseSchema, await resp.json(), 'createRun');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Network / not implemented — soft null for adapter path
    console.warn('[runs] createRun unavailable:', (err as Error).message);
    return null;
  }
}

/**
 * GET /runs/{run_id} — fetch run detail for rehydrate after refresh.
 * Returns null when endpoint is not available.
 */
export async function getRun(runId: string): Promise<RunDetail | null> {
  try {
    const resp = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}`, {
      headers: authHeaders(),
    });
    if (resp.status === 404 || resp.status === 501) return null;
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || `Get run failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    return parseApi(RunDetailSchema, await resp.json(), 'getRun');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.warn('[runs] getRun unavailable:', (err as Error).message);
    return null;
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
    if (resp.status === 404 || resp.status === 501) return false;
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
    console.warn('[runs] cancelRun unavailable:', (err as Error).message);
    return false;
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
 * List in-progress runs for a conversation (rehydrate after refresh).
 * Soft-fails to [] when endpoint missing.
 */
export async function listRuns(opts: {
  conversation_id?: string;
  status?: string;
} = {}): Promise<RunDetail[]> {
  try {
    const q = new URLSearchParams();
    if (opts.conversation_id) q.set('conversation_id', opts.conversation_id);
    if (opts.status) q.set('status', opts.status);
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(`${BASE}/runs${qs}`, {
      headers: authHeaders(),
    });
    if (resp.status === 404 || resp.status === 501) return [];
    if (!resp.ok) return [];
    const data = (await resp.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { runs?: unknown[] })?.runs)
        ? (data as { runs: unknown[] }).runs
        : [];
    return list.map((item) => parseApi(RunDetailSchema, item, 'listRuns'));
  } catch {
    return [];
  }
}

/**
 * POST /api/runs/{run_id}/steer — change current execution direction.
 * Soft-fails to false when endpoint missing.
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
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, error: 'Steer API unavailable' };
    }
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
    console.warn('[runs] steerRun unavailable:', (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * POST /api/runs/{run_id}/follow-up — queue text after current run work.
 * Soft-fails to false when endpoint missing.
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
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, error: 'Follow-up API unavailable' };
    }
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
    console.warn('[runs] followUpRun unavailable:', (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * POST /api/runs/{run_id}/resume-approval — recover parked approval wait.
 * Soft-fails when endpoint missing.
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
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, error: 'Resume-approval API unavailable' };
    }
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
    console.warn('[runs] resumeApproval unavailable:', (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Synthetic local run id when create-run API is not ready.
 * Used by legacy /chat adapter path.
 */
export function syntheticRunId(prefix = 'run'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
