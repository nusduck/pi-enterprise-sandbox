/**
 * Pure helpers for Active Runs page (F5 / ADR 0003 §10).
 * Unit-testable — no React / no I/O.
 */
import type { RunEntity, EntityStore, ToolExecutionEntity } from '../../entities';
import type { RunDetail } from '../../shared/schemas/events';
import type { RunListItem as ApiRunItem } from '../../shared/schemas/management';

/** Status filter chips shown on the Active Runs page. */
export const RUN_STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'waiting_approval', label: 'Waiting Approval' },
  { id: 'interrupted', label: 'Interrupted' },
  { id: 'failed', label: 'Failed' },
  { id: 'completed', label: 'Completed' },
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
  tokenUsage: string | null;
  source: 'api' | 'store' | 'merged';
};

/** Map "completed" filter to terminal success statuses. */
const COMPLETED_STATUSES = new Set(['succeeded', 'completed', 'cancelled']);

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
  return rows.filter((r) => set.has(r.status));
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
    status: String(any.status || 'unknown'),
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
    finishedAt: (any.finished_at as string | null | undefined) ?? null,
    createdAt: (any.created_at as string | null | undefined) ?? null,
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
    status: run.status,
    currentStep:
      tools.length > 0 ? `Tool ${tools.length}` : null,
    currentTool,
    model: null,
    runner: null,
    error: run.error,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
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
  ].includes(status);
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
