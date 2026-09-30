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

/** 一个 Skill 名在近 N 天里的调用统计，按层拆开（ADR 0015 D1 / design §7.4）。 */
export interface SkillUsageEntry {
  readonly calls: number;
  /** 只有出现过的层才带值；系统层优先的那条规则由服务端判定。 */
  readonly byScope: { readonly system: number; readonly org: number; readonly user: number };
}

const SKILL_SCOPES = ['system', 'org', 'user'] as const;

/**
 * `skill` tool calls per Skill name over the last `days` days, org-wide (admin only).
 *
 * 服务端按 (名字, 层) 各出一行——同一个名字可能在不同 AgentVersion 下属于不同层。
 * 这里按名字聚成一条：总量给表格用，分层给 tooltip 用。未知 scope 只计入总量，
 * 不猜它是哪一层（猜错比不显示更糟）。
 */
export async function getAdminSkillUsage(days = 7): Promise<Map<string, SkillUsageEntry>> {
  const body = await getJson(`/skill-usage?days=${days}`, 'Skill usage');
  const parsed = parseApi(
    z.object({
      usage: z.array(z.object({
        name: z.string(),
        calls: z.number(),
        scope: z.string().optional(),
      })).default([]),
    }),
    body,
    'skill usage',
  );
  const out = new Map<string, { calls: number; byScope: { system: number; org: number; user: number } }>();
  for (const row of parsed.usage) {
    const entry = out.get(row.name) ?? { calls: 0, byScope: { system: 0, org: 0, user: 0 } };
    entry.calls += row.calls;
    const scope = SKILL_SCOPES.find((s) => s === row.scope);
    if (scope) entry.byScope[scope] += row.calls;
    out.set(row.name, entry);
  }
  return out;
}
