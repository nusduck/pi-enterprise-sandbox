/**
 * Process Control API client (B2/B3).
 * Soft-fails when BFF proxy is not yet wired (404/501).
 */
import { authHeaders, ApiError } from './client';

const BASE = '/api';

export type ProcessLogs = {
  stdout: string;
  stderr: string;
  next_offset: number;
  completed: boolean;
  truncated: boolean;
  full_log_location?: string | null;
  log_total?: number;
};

export type ProcessActionResult = {
  ok: boolean;
  status?: number;
  data?: Record<string, unknown> | null;
  error?: string | null;
};

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * GET /api/processes/{id}/logs?offset=&limit=
 * Returns null when endpoint is unavailable.
 */
export async function getProcessLogs(
  processId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<ProcessLogs | null> {
  try {
    const q = new URLSearchParams();
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.limit != null) q.set('limit', String(opts.limit));
    const qs = q.toString() ? `?${q}` : '';
    const resp = await fetch(
      `${BASE}/processes/${encodeURIComponent(processId)}/logs${qs}`,
      { headers: authHeaders() },
    );
    if (resp.status === 404 || resp.status === 501 || resp.status === 405) {
      return null;
    }
    if (!resp.ok) {
      const err = await errorBody(resp);
      throw new ApiError(
        String(err.error || err.detail || `Process logs failed: ${resp.status}`),
        { status: resp.status },
      );
    }
    const data = (await resp.json()) as ProcessLogs;
    return {
      stdout: data.stdout || '',
      stderr: data.stderr || '',
      next_offset: data.next_offset ?? 0,
      completed: Boolean(data.completed),
      truncated: Boolean(data.truncated),
      full_log_location: data.full_log_location ?? null,
      log_total: data.log_total,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.warn('[processes] getProcessLogs unavailable:', (err as Error).message);
    return null;
  }
}

/**
 * POST /api/processes/{id}/stdin  body: { data, eof? }
 */
export async function writeProcessStdin(
  processId: string,
  data: string,
  eof = false,
): Promise<ProcessActionResult> {
  try {
    const resp = await fetch(
      `${BASE}/processes/${encodeURIComponent(processId)}/stdin`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data, eof }),
      },
    );
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, status: resp.status, error: 'Process stdin API unavailable' };
    }
    if (!resp.ok) {
      const err = await errorBody(resp);
      return {
        ok: false,
        status: resp.status,
        error: String(err.error || err.detail || `stdin failed: ${resp.status}`),
      };
    }
    return {
      ok: true,
      status: resp.status,
      data: (await resp.json().catch(() => ({}))) as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * POST /api/processes/{id}/signal  body: { signal }
 */
export async function signalProcess(
  processId: string,
  signal: string,
): Promise<ProcessActionResult> {
  try {
    const resp = await fetch(
      `${BASE}/processes/${encodeURIComponent(processId)}/signal`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ signal }),
      },
    );
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, status: resp.status, error: 'Process signal API unavailable' };
    }
    if (!resp.ok) {
      const err = await errorBody(resp);
      return {
        ok: false,
        status: resp.status,
        error: String(err.error || err.detail || `signal failed: ${resp.status}`),
      };
    }
    return {
      ok: true,
      status: resp.status,
      data: (await resp.json().catch(() => ({}))) as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * POST /api/processes/{id}/cancel
 */
export async function cancelProcess(
  processId: string,
): Promise<ProcessActionResult> {
  try {
    const resp = await fetch(
      `${BASE}/processes/${encodeURIComponent(processId)}/cancel`,
      {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({}),
      },
    );
    if (resp.status === 404 || resp.status === 501) {
      return { ok: false, status: resp.status, error: 'Process cancel API unavailable' };
    }
    if (!resp.ok) {
      const err = await errorBody(resp);
      return {
        ok: false,
        status: resp.status,
        error: String(err.error || err.detail || `cancel failed: ${resp.status}`),
      };
    }
    return {
      ok: true,
      status: resp.status,
      data: (await resp.json().catch(() => ({}))) as Record<string, unknown>,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
