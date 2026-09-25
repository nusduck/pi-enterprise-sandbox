/**
 * Pure helpers for the admin Runs pages: status filters, labels, durations.
 */

/** Status filter chips shown on the Runs page. */
export const RUN_STATUS_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'running', label: '运行中' },
  { id: 'waiting_approval', label: '等待审批' },
  { id: 'waiting_input', label: '等待回答' },
  { id: 'failed', label: '失败' },
  { id: 'completed', label: '已结束' },
] as const;

export type RunStatusFilterId = (typeof RUN_STATUS_FILTERS)[number]['id'];

/** The Agent uses uppercase plan §10 statuses; labels and checks use lowercase. */
export function normalizeRunStatus(status: string | null | undefined): string {
  return String(status || 'unknown').trim().toLowerCase();
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

/** Human duration for the stats strip: 38s, 4 分 10 秒, 1 小时 5 分. */
export function formatLongDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * One-line label for a run's user input: drops the attachment manifest the
 * composer appends ("\n\n[Attachments]\n- a.png → …") and folds whitespace.
 */
export function runInputLabel(text: string | null | undefined, max = 80): string | null {
  if (!text) return null;
  const body = text.split(/\n\s*\[Attachments\]/)[0].replace(/\s+/g, ' ').trim();
  if (!body) return text.includes('[Attachments]') ? '（仅附件）' : null;
  return body.length > max ? `${body.slice(0, max)}…` : body;
}
