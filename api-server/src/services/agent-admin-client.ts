/**
 * 管理端 Run 查询的 Agent 端调用（`/internal/admin/runs*`）。
 *
 * BFF 只转发与投影身份：角色判定、org 作用域、跨 org 404 都是 agent/ 的事，
 * 这里不做二次判断，也不缓存。单独成文件：`agent-client.ts` 已贴着行数棘轮。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

type Opts = { auth?: any; traceId?: string | null };

/** Query keys the Agent accepts; anything else from the browser is dropped. */
const LIST_KEYS = ['status', 'agent_id', 'user_id', 'from', 'to', 'q', 'cursor', 'limit'] as const;

async function requestAdminRuns(path: string, query: URLSearchParams | null, { auth = null, traceId = null }: Opts, base = '/internal/admin/runs'): Promise<any> {
  const url = new URL(`${config.AGENT_BASE_URL}${base}${path}`);
  if (query) for (const [k, v] of query) url.searchParams.set(k, v);
  const resp = await agentFetch(url, { headers: requestHeaders({ auth, traceId }) });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string' ? payload.error : `Agent admin request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

function pick(source: URLSearchParams, keys: readonly string[]): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value != null && value !== '') out.set(key, value);
  }
  return out;
}

export function listAdminRuns(source: URLSearchParams, opts: Opts = {}): Promise<any> {
  return requestAdminRuns('', pick(source, LIST_KEYS), opts);
}

export function getAdminRunStats(source: URLSearchParams, opts: Opts = {}): Promise<any> {
  return requestAdminRuns('/stats', pick(source, ['day_start']), opts);
}

export function getAdminRun(runId: string, opts: Opts = {}): Promise<any> {
  return requestAdminRuns(`/${encodeURIComponent(runId)}`, null, opts);
}

export function listAdminRunTools(runId: string, opts: Opts = {}): Promise<any> {
  return requestAdminRuns(`/${encodeURIComponent(runId)}/tools`, null, opts);
}

/**
 * All persisted events of one run. Pages until a short page (tools often land
 * after many `message.delta` rows); bounded so one run cannot pin the BFF.
 */
export async function listAllAdminRunEvents(runId: string, opts: Opts = {}): Promise<{ events: any[]; truncated: boolean }> {
  const pageSize = 1000;
  const maxPages = 20;
  const events: any[] = [];
  let after = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const query = new URLSearchParams({ after_sequence: String(after), limit: String(pageSize) });
    const body = await requestAdminRuns(`/${encodeURIComponent(runId)}/events`, query, opts);
    const rows: any[] = Array.isArray(body?.events) ? body.events : [];
    events.push(...rows);
    if (rows.length < pageSize) return { events, truncated: false };
    const last = Number(rows[rows.length - 1]?.sequence);
    if (!Number.isFinite(last) || last <= after) return { events, truncated: false };
    after = last;
  }
  return { events, truncated: true };
}

/** `skill` tool calls per Skill over the last `days` days, org-wide (admin). */
export function getAdminSkillUsage(source: URLSearchParams, opts: Opts = {}): Promise<any> {
  return requestAdminRuns('', pick(source, ['days']), opts, '/internal/admin/skill-usage');
}
