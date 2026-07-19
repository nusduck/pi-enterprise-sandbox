/**
 * Process Control API client (B2/B3).
 * BFF routes are owner-scoped through the Agent process authority.
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

export type ManagedProcess = {
  process_id: string;
  session_id?: string | null;
  sandbox_session_id?: string | null;
  run_id?: string | null;
  execution_id?: string | null;
  command: string;
  status: string;
  pid?: number | null;
  exit_code?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at?: string | null;
};

export type ProcessRead = {
  process_id: string;
  stream: 'stdout' | 'stderr';
  cursor: string;
  next_cursor: string;
  data: string;
  truncated: boolean;
  completed: boolean;
  status?: string | null;
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

async function requireOk(resp: Response, fallback: string): Promise<void> {
  if (resp.ok) return;
  const err = await errorBody(resp);
  throw new ApiError(
    String(err.error || err.detail || `${fallback}: ${resp.status}`),
    {
      status: resp.status,
      code: typeof err.code === 'string' ? err.code : null,
    },
  );
}

export async function listProcesses(
  opts: { runId?: string; sessionId?: string; status?: string; limit?: number } = {},
): Promise<ManagedProcess[]> {
  const q = new URLSearchParams();
  if (opts.runId) q.set('run_id', opts.runId);
  if (opts.sessionId) q.set('session_id', opts.sessionId);
  if (opts.status) q.set('status', opts.status);
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(`${BASE}/processes${qs}`, { headers: authHeaders() });
  await requireOk(resp, 'List processes failed');
  const body = (await resp.json()) as {
    processes?: ManagedProcess[];
    items?: ManagedProcess[];
  };
  return body.processes || body.items || [];
}

export async function getProcess(processId: string): Promise<ManagedProcess> {
  const resp = await fetch(`${BASE}/processes/${encodeURIComponent(processId)}`, {
    headers: authHeaders(),
  });
  await requireOk(resp, 'Get process failed');
  return (await resp.json()) as ManagedProcess;
}

export async function readProcess(
  processId: string,
  opts: { stream?: 'stdout' | 'stderr'; cursor?: string; limit?: number } = {},
): Promise<ProcessRead> {
  const q = new URLSearchParams();
  if (opts.stream) q.set('stream', opts.stream);
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(
    `${BASE}/processes/${encodeURIComponent(processId)}/read${qs}`,
    { headers: authHeaders() },
  );
  await requireOk(resp, 'Read process failed');
  return (await resp.json()) as ProcessRead;
}

/**
 * GET /api/processes/{id}/logs?offset=&limit=
 */
export async function getProcessLogs(
  processId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<ProcessLogs> {
  const q = new URLSearchParams();
  if (opts.offset != null) q.set('offset', String(opts.offset));
  if (opts.limit != null) q.set('limit', String(opts.limit));
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(
    `${BASE}/processes/${encodeURIComponent(processId)}/logs${qs}`,
    { headers: authHeaders() },
  );
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
