/**
 * Pure helpers for Active Runs page (F5 / ADR 0003 §10).
 * Unit-testable — no React / no I/O.
 */
import type { RunEntity, EntityStore, ToolExecutionEntity } from '../../entities';
import type { RunDetail } from '../../shared/schemas/events';
import type { RunListItem as ApiRunItem } from '../../shared/schemas/management';

/** Status filter chips shown on the Active Runs page. */
export const RUN_STATUS_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'waiting_approval', label: '等待审批' },
  { id: 'waiting_input', label: '等待回答' },
  { id: 'failed', label: '失败' },
  { id: 'completed', label: '已结束' },
] as const;

export type RunStatusFilterId = (typeof RUN_STATUS_FILTERS)[number]['id'];

/** Normalized row for the runs table (API + entity store). */
export type RunRow = {
  id: string;
  conversationId: string | null;
  status: string;
  currentStep: string | null;
  currentTool: string | null;
  model: string | null;
  runner: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tokenUsage: string | null;
  source: 'api' | 'store' | 'merged';
};

/** Map "completed" filter to terminal success statuses. */
const COMPLETED_STATUSES = new Set(['succeeded', 'completed', 'cancelled']);

/**
 * The durable Agent API uses uppercase plan §10 statuses, while the browser
 * entity store predates it and uses lowercase statuses. Keep that transport
 * detail at this boundary so filtering, labels, and cancel affordances agree.
 */
export function normalizeRunStatus(status: string | null | undefined): string {
  return String(status || 'unknown').trim().toLowerCase();
}

/** Map filter chip → matching status set. */
export function statusesForFilter(filter: RunStatusFilterId): Set<string> | null {
  if (filter === 'all') return null;
  if (filter === 'completed') return COMPLETED_STATUSES;
  return new Set([filter]);
}

export function filterRunsByStatus(
  rows: RunRow[],
  filter: RunStatusFilterId,
): RunRow[] {
  const set = statusesForFilter(filter);
  if (!set) return rows;
  return rows.filter((r) => set.has(normalizeRunStatus(r.status)));
}

function shortUsage(usage: unknown): string | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const inTok = u.input_tokens ?? u.prompt_tokens ?? u.input;
  const outTok = u.output_tokens ?? u.completion_tokens ?? u.output;
  const total = u.total_tokens ?? u.total;
  if (total != null) return `${total} tokens`;
  if (inTok != null || outTok != null) {
    return `${inTok ?? '?'} in / ${outTok ?? '?'} out`;
  }
  return null;
}

export function runRowFromApi(item: ApiRunItem | RunDetail): RunRow | null {
  const id =
    (item as { run_id?: string }).run_id ||
    (item as { id?: string }).id ||
    '';
  if (!id) return null;
  const any = item as Record<string, unknown>;
  return {
    id,
    conversationId:
      (any.conversation_id as string | null | undefined) ?? null,
    status: normalizeRunStatus(any.status as string | null | undefined),
    currentStep:
      any.current_step != null ? String(any.current_step) : null,
    currentTool: (any.current_tool as string | null | undefined) ?? null,
    model:
      (any.model_id as string | null | undefined) ||
      (any.model as string | null | undefined) ||
      null,
    runner: (any.runner as string | null | undefined) ?? null,
    error: (any.error as string | null | undefined) ?? null,
    startedAt: (any.started_at as string | null | undefined) ?? null,
    // The Agent Run authority calls this completed_at and emits finished_at
    // alongside it; both spellings stay readable so a single-key response
    // (or a direct Agent call that skips the BFF) still yields a duration.
    finishedAt:
      (any.finished_at as string | null | undefined) ??
      (any.completed_at as string | null | undefined) ??
      null,
    createdAt: (any.created_at as string | null | undefined) ?? null,
    updatedAt: (any.updated_at as string | null | undefined) ?? null,
    tokenUsage: shortUsage(any.usage || any.token_usage),
    source: 'api',
  };
}

export function runRowFromEntity(
  run: RunEntity,
  tools: ToolExecutionEntity[] = [],
): RunRow {
  const currentTool =
    tools
      .filter((t) => t.status === 'running' || t.status === 'waiting_approval')
      .map((t) => t.name)[0] ||
    tools[tools.length - 1]?.name ||
    null;
  return {
    id: run.id,
    conversationId: run.conversationId,
    status: normalizeRunStatus(run.status),
    currentStep:
      tools.length > 0 ? `Tool ${tools.length}` : null,
    currentTool,
    model: null,
    runner: null,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
    updatedAt: null,
    tokenUsage: null,
    source: 'store',
  };
}

/**
 * Merge API list + entity store runs (API wins on field conflicts; store fills gaps).
 */
export function mergeRunRows(
  apiItems: Array<ApiRunItem | RunDetail>,
  store: EntityStore,
): RunRow[] {
  const byId = new Map<string, RunRow>();

  for (const item of apiItems) {
    const row = runRowFromApi(item);
    if (row) byId.set(row.id, row);
  }

  for (const run of Object.values(store.runsById)) {
    const tools = run.toolExecutionIds
      .map((id) => store.toolExecutionsById[id])
      .filter(Boolean) as ToolExecutionEntity[];
    const fromStore = runRowFromEntity(run, tools);
    const existing = byId.get(run.id);
    if (!existing) {
      byId.set(run.id, fromStore);
    } else {
      byId.set(run.id, {
        ...fromStore,
        ...Object.fromEntries(
          Object.entries(existing).filter(([, v]) => v != null && v !== ''),
        ),
        id: run.id,
        source: 'merged',
      } as RunRow);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const ta = Date.parse(a.startedAt || a.createdAt || '') || 0;
    const tb = Date.parse(b.startedAt || b.createdAt || '') || 0;
    return tb - ta;
  });
}

/** Whether cancel is allowed for this status. */
export function canCancelRun(status: string): boolean {
  return [
    'queued',
    'restoring_session',
    'running',
    'waiting_approval',
    'waiting_input',
    'cancel_requested',
  ].includes(normalizeRunStatus(status));
}

export function formatRunDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string {
  if (!startedAt) return '—';
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return '—';
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (Number.isNaN(end)) return '—';
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function shortId(id: string, n = 10): string {
  if (id.length <= n) return id;
  return `${id.slice(0, n)}…`;
}

// ── list page: range filter and headline numbers ────────────────────

export type RunRange = 'today' | '7d' | '30d' | 'all';

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function rowTime(row: RunRow): number | null {
  const t = Date.parse(row.startedAt || row.createdAt || '');
  return Number.isNaN(t) ? null : t;
}

export function inRange(row: RunRow, range: RunRange, now = Date.now()): boolean {
  if (range === 'all') return true;
  const t = rowTime(row);
  if (t == null) return false;
  const from = range === 'today' ? startOfDay(now) : startOfDay(now) - (range === '7d' ? 6 : 29) * DAY;
  return t >= from;
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export type RunStats = {
  today: number;
  yesterday: number;
  failedToday: number;
  failureRate: number | null;
  waiting: number;
  /** Longest current wait (ms) among runs waiting for approval or input. */
  longestWaitMs: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  /** Runs per day, oldest first, ending today. */
  last7: number[];
};

export function runStats(rows: readonly RunRow[], now = Date.now()): RunStats {
  const today0 = startOfDay(now);
  const yesterday0 = today0 - DAY;
  let today = 0;
  let yesterday = 0;
  let failedToday = 0;
  let waiting = 0;
  let longestWaitMs: number | null = null;
  const last7 = Array.from({ length: 7 }, () => 0);
  const durations: number[] = [];
  for (const row of rows) {
    const t = rowTime(row);
    const status = normalizeRunStatus(row.status);
    if (t != null) {
      if (t >= today0) {
        today += 1;
        if (status === 'failed') failedToday += 1;
      } else if (t >= yesterday0) yesterday += 1;
      const day = Math.floor((today0 - startOfDay(t)) / DAY);
      if (day >= 0 && day < 7) last7[6 - day] += 1;
    }
    if (status === 'waiting_approval' || status === 'waiting_input') {
      waiting += 1;
      const since = Date.parse(row.updatedAt || row.startedAt || '');
      if (!Number.isNaN(since)) longestWaitMs = Math.max(longestWaitMs ?? 0, now - since);
    }
    const start = Date.parse(row.startedAt || '');
    const end = Date.parse(row.finishedAt || '');
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) durations.push(end - start);
  }
  durations.sort((a, b) => a - b);
  return {
    today,
    yesterday,
    failedToday,
    failureRate: today ? failedToday / today : null,
    waiting,
    longestWaitMs,
    medianMs: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    last7,
  };
}

/** Human duration for the stats strip: 38s, 4 分 10 秒, 1 小时 5 分. */
export function formatLongDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
