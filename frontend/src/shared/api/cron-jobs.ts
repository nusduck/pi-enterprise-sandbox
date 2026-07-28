import { ApiError, authHeaders } from './client';

const BASE = '/api/cron-jobs';

export type CronJob = {
  cron_job_id: string;
  name: string;
  prompt: string;
  agent_id: string | null;
  schedule_type: 'cron' | 'once';
  cron_expression: string | null;
  run_at: string | null;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  misfire_policy: 'skip' | 'fire_once';
  concurrency_policy: 'forbid' | 'allow';
  created_at: string | null;
  updated_at: string | null;
};

export type CronJobRun = {
  cron_job_run_id: string;
  cron_job_id: string;
  scheduled_at: string | null;
  claimed_at: string | null;
  run_id: string | null;
  status: string;
  run_status: string | null;
  error_message: string | null;
};

export type CronJobInput = {
  name: string;
  prompt: string;
  agent_id?: string | null;
  schedule_type: 'cron' | 'once';
  cron_expression?: string | null;
  run_at?: string | null;
  timezone: string;
  enabled?: boolean;
  misfire_policy?: 'skip' | 'fire_once';
  concurrency_policy?: 'forbid' | 'allow';
};

async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const suppliedHeaders: Record<string, string> = {};
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => { suppliedHeaders[key] = value; });
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) suppliedHeaders[key] = value;
  } else if (init.headers) {
    Object.assign(suppliedHeaders, init.headers);
  }
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: authHeaders({
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...suppliedHeaders,
    }),
  });
  if (!resp.ok) {
    const body = await errorBody(resp);
    throw new ApiError(String(body.error || `Cron request failed: ${resp.status}`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
      traceId: resp.headers.get('x-trace-id'),
    });
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

export async function listCronJobs(): Promise<CronJob[]> {
  const result = await request<{ cron_jobs?: CronJob[] }>('', { method: 'GET' });
  return Array.isArray(result.cron_jobs) ? result.cron_jobs : [];
}

export function createCronJob(input: CronJobInput): Promise<CronJob> {
  return request('', { method: 'POST', body: JSON.stringify(input) });
}

export function updateCronJob(id: string, input: Partial<CronJobInput>): Promise<CronJob> {
  return request(`/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(input),
  });
}

export function deleteCronJob(id: string): Promise<void> {
  return request(`/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function runCronJobNow(id: string): Promise<CronJobRun> {
  return request(`/${encodeURIComponent(id)}/run`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export async function listCronJobRuns(id: string): Promise<CronJobRun[]> {
  const result = await request<{ cron_job_runs?: CronJobRun[] }>(
    `/${encodeURIComponent(id)}/runs`,
    { method: 'GET' },
  );
  return Array.isArray(result.cron_job_runs) ? result.cron_job_runs : [];
}
