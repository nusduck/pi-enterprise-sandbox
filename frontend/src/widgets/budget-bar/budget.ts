/**
 * Run budget display helpers (ADR §4.9 / §8.1).
 */

export type BudgetUsage = {
  steps?: number;
  tool_calls?: number;
  llm_tokens?: number;
  cost?: number;
  consecutive_tool_failures?: number;
  processes?: number;
  duration_seconds?: number;
  started_at?: number;
  [key: string]: unknown;
};

export type BudgetLimits = {
  max_steps?: number | null;
  max_tool_calls?: number | null;
  max_run_duration?: number | null;
  max_llm_tokens?: number | null;
  max_cost?: number | null;
  max_consecutive_tool_failures?: number | null;
  max_processes?: number | null;
  [key: string]: unknown;
};

export type BudgetSnapshot = {
  usage: BudgetUsage | null;
  limits: BudgetLimits | null;
  warning?: string | null;
};

export type BudgetDimension = {
  key: string;
  label: string;
  used: number;
  limit: number | null;
  /** 0–1 ratio when limit is finite; null when unlimited. */
  ratio: number | null;
  near: boolean;
  exceeded: boolean;
};

const DIMS: {
  key: keyof BudgetUsage;
  limitKey: keyof BudgetLimits;
  label: string;
}[] = [
  { key: 'steps', limitKey: 'max_steps', label: 'Steps' },
  { key: 'tool_calls', limitKey: 'max_tool_calls', label: 'Tools' },
  { key: 'llm_tokens', limitKey: 'max_llm_tokens', label: 'Tokens' },
  { key: 'cost', limitKey: 'max_cost', label: 'Cost' },
  { key: 'processes', limitKey: 'max_processes', label: 'Procs' },
  {
    key: 'duration_seconds',
    limitKey: 'max_run_duration',
    label: 'Duration',
  },
];

export function hasBudgetData(snap: BudgetSnapshot | null | undefined): boolean {
  if (!snap) return false;
  return Boolean(snap.usage && Object.keys(snap.usage).length);
}

export function formatBudgetNumber(n: number, key: string): string {
  if (key === 'cost') {
    return n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2);
  }
  if (key === 'duration_seconds') {
    if (n < 60) return `${Math.round(n)}s`;
    const m = Math.floor(n / 60);
    const s = Math.round(n % 60);
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  if (key === 'llm_tokens' && n >= 1000) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

/**
 * Build display dimensions from usage + limits.
 * Only includes dimensions that have a used value or a limit.
 */
export function listBudgetDimensions(snap: BudgetSnapshot): BudgetDimension[] {
  const usage = snap.usage || {};
  const limits = snap.limits || {};
  const out: BudgetDimension[] = [];

  for (const d of DIMS) {
    const rawUsed = usage[d.key];
    const used = typeof rawUsed === 'number' ? rawUsed : 0;
    const limRaw = limits[d.limitKey];
    const limit =
      limRaw == null || limRaw === undefined ? null : Number(limRaw);
    // Skip fully empty unlimited dims with zero usage
    if ((limit == null || !Number.isFinite(limit)) && used === 0) continue;

    const finiteLimit =
      limit != null && Number.isFinite(limit) && limit > 0 ? limit : null;
    const ratio = finiteLimit != null ? used / finiteLimit : null;
    out.push({
      key: String(d.key),
      label: d.label,
      used,
      limit: finiteLimit,
      ratio,
      near: ratio != null && ratio >= 0.8 && ratio < 1,
      exceeded: ratio != null && ratio >= 1,
    });
  }
  return out;
}

/** Compact one-line summary: "Tools 3/100 · Tokens 1.2k/500k". */
export function formatBudgetSummary(snap: BudgetSnapshot): string {
  const dims = listBudgetDimensions(snap);
  if (!dims.length) return '';
  return dims
    .slice(0, 4)
    .map((d) => {
      const used = formatBudgetNumber(d.used, d.key);
      if (d.limit == null) return `${d.label} ${used}`;
      return `${d.label} ${used}/${formatBudgetNumber(d.limit, d.key)}`;
    })
    .join(' · ');
}

/** Overall tone for the budget bar. */
export function budgetTone(
  snap: BudgetSnapshot,
): 'ok' | 'near' | 'exceeded' {
  const dims = listBudgetDimensions(snap);
  if (dims.some((d) => d.exceeded) || snap.warning === 'exceeded') {
    return 'exceeded';
  }
  if (dims.some((d) => d.near) || snap.warning === 'warning') {
    return 'near';
  }
  return 'ok';
}

/**
 * Extract budget snapshot from a run-like object (entity or API detail).
 */
export function extractBudgetSnapshot(source: {
  budget?: unknown;
  budgetUsage?: unknown;
  budgetLimits?: unknown;
  budget_limits?: unknown;
  budgetWarning?: unknown;
} | null | undefined): BudgetSnapshot | null {
  if (!source) return null;
  const usageRaw =
    source.budgetUsage ??
    (source.budget &&
    typeof source.budget === 'object' &&
    !Array.isArray(source.budget)
      ? source.budget
      : null);
  const limitsRaw = source.budgetLimits ?? source.budget_limits ?? null;

  const usage =
    usageRaw && typeof usageRaw === 'object'
      ? (usageRaw as BudgetUsage)
      : null;
  const limits =
    limitsRaw && typeof limitsRaw === 'object'
      ? (limitsRaw as BudgetLimits)
      : null;

  if (!usage && !limits) return null;
  return {
    usage,
    limits,
    warning:
      source.budgetWarning != null ? String(source.budgetWarning) : null,
  };
}
