/**
 * 管理端 Run 查询（`/api/admin/runs*`）：全组织、只读。
 * 角色与 org 作用域由 agent/ 判定；非管理员得到 403，别的 org 的运行得到 404。
 */
import { z } from 'zod';
import { parseApi } from '../schemas/api';
import {
  PersistedAgentEventSchema,
  ToolExecutionSnapshotSchema,
  type PersistedAgentEvent,
  type ToolExecutionSnapshot,
} from '../schemas/events';
import { ApiError, authHeaders } from './client';

const nullableString = z.string().nullable().optional();

export const AdminRunSchema = z
  .object({
    run_id: z.string(),
    status: z.string(),
    status_reason: nullableString,
    user_id: z.string(),
    user_name: nullableString,
    conversation_id: nullableString,
    conversation_title: nullableString,
    agent_id: nullableString,
    agent_name: nullableString,
    agent_version_no: z.number().nullable().optional(),
    model_id: nullableString,
    parent_run_id: nullableString,
    trace_id: nullableString,
    tool_count: z.number().default(0),
    approval_count: z.number().default(0),
    created_at: nullableString,
    started_at: nullableString,
    completed_at: nullableString,
    updated_at: nullableString,
    user_input: nullableString,
    user_input_excerpt: nullableString,
    turn_no: z.number().nullable().optional(),
  })
  .passthrough();
export type AdminRun = z.infer<typeof AdminRunSchema>;

const AdminRunPageSchema = z.object({
  runs: z.array(AdminRunSchema).default([]),
  next_cursor: z.string().nullable().optional(),
});
export type AdminRunPage = z.infer<typeof AdminRunPageSchema>;

const AdminRunStatsSchema = z.object({
  day_start: z.string(),
  today: z.number(),
  yesterday: z.number(),
  failed_today: z.number(),
  failure_rate: z.number().nullable(),
  waiting: z.number(),
  longest_wait_ms: z.number().nullable(),
  median_ms: z.number().nullable(),
  p95_ms: z.number().nullable(),
  last_7_days: z.array(z.number()),
  truncated: z.boolean().optional(),
});
export type AdminRunStats = z.infer<typeof AdminRunStatsSchema>;

async function getJson(path: string, label: string): Promise<unknown> {
  const resp = await fetch(`/api/admin${path}`, { headers: authHeaders() });
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ApiError(String(body.error || `${label} failed: ${resp.status}`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
    });
  }
  return resp.json();
}

export type AdminRunFilters = {
  status?: string | null;
  agentId?: string | null;
  from?: string | null;
  q?: string | null;
  cursor?: string | null;
  limit?: number;
};

export async function listAdminRuns(f: AdminRunFilters = {}): Promise<AdminRunPage> {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status);
  if (f.agentId) q.set('agent_id', f.agentId);
  if (f.from) q.set('from', f.from);
  if (f.q) q.set('q', f.q);
  if (f.cursor) q.set('cursor', f.cursor);
  q.set('limit', String(f.limit ?? 50));
  return parseApi(AdminRunPageSchema, await getJson(`/runs?${q}`, 'List runs'), 'admin runs');
}

/** `dayStart` is the viewer's local midnight so "today" matches their clock. */
export async function getAdminRunStats(dayStart: Date): Promise<AdminRunStats> {
  const q = new URLSearchParams({ day_start: dayStart.toISOString() });
  return parseApi(AdminRunStatsSchema, await getJson(`/runs/stats?${q}`, 'Run stats'), 'admin run stats');
}

export async function getAdminRun(runId: string): Promise<AdminRun> {
  return parseApi(AdminRunSchema, await getJson(`/runs/${encodeURIComponent(runId)}`, 'Get run'), 'admin run');
}

export async function listAdminRunEvents(runId: string): Promise<PersistedAgentEvent[]> {
  const body = await getJson(`/runs/${encodeURIComponent(runId)}/events`, 'Run events');
  return parseApi(z.object({ events: z.array(PersistedAgentEventSchema).default([]) }), body, 'admin run events').events;
}

export async function listAdminRunTools(runId: string): Promise<ToolExecutionSnapshot[]> {
  const body = await getJson(`/runs/${encodeURIComponent(runId)}/tools`, 'Run tools');
  return parseApi(z.object({ tools: z.array(ToolExecutionSnapshotSchema).default([]) }), body, 'admin run tools').tools;
}

/** `skill` tool calls per Skill name over the last `days` days, org-wide (admin only). */
export async function getAdminSkillUsage(days = 7): Promise<Map<string, number>> {
  const body = await getJson(`/skill-usage?days=${days}`, 'Skill usage');
  const parsed = parseApi(
    z.object({ usage: z.array(z.object({ name: z.string(), calls: z.number() })).default([]) }),
    body,
    'skill usage',
  );
  return new Map(parsed.usage.map((u) => [u.name, u.calls]));
}
