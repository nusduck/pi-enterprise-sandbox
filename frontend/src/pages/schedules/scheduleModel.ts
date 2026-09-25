/**
 * Pure model for the scheduled-tasks page: cron preview with the same
 * semantics as the Agent (`agent/src/application/cron-schedule.ts`), the
 * frequency builder ↔ cron mapping, Chinese schedule descriptions, one-time
 * run_at conversion, and the 30-day run strip.
 */
import type { CronJob, CronJobRun } from '../../shared/api/cron-jobs';

// ── cron (5 fields, minute granularity, IANA timezone) ───────────────

type Field = { values: Set<number>; wildcard: boolean };
export type Cron = { minute: Field; hour: Field; dom: Field; month: Field; dow: Field };

const SPECS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(raw: string, [min, max]: [number, number]): Field | null {
  const values = new Set<number>();
  for (const piece of raw.split(',')) {
    const parts = piece.split('/');
    if (!piece || parts.length > 2) return null;
    const step = parts[1] == null ? 1 : Number(parts[1]);
    if (!Number.isInteger(step) || step < 1) return null;
    let from = min;
    let to = max;
    if (parts[0] !== '*') {
      const range = parts[0].split('-');
      if (range.length > 2 || range.some((r) => !/^\d+$/.test(r))) return null;
      from = Number(range[0]);
      to = range.length === 2 ? Number(range[1]) : from;
      if (from < min || to > max || to < from) return null;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return { values, wildcard: raw === '*' };
}

/** Parse a five-field expression; null when the Agent would reject it. */
export function parseCron(expression: string): Cron | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((f, i) => parseField(f, SPECS[i]));
  if (parsed.some((p) => p == null)) return null;
  const [minute, hour, dom, month, dow] = parsed as Field[];
  return { minute, hour, dom, month, dow };
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zoned(date: Date, fmt: Intl.DateTimeFormat) {
  const parts = fmt.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    minute: get('minute'),
    hour: get('hour'),
    dom: get('day'),
    month: get('month'),
    dow: WEEKDAY[parts.find((p) => p.type === 'weekday')?.value || ''] ?? -1,
  };
}

function dayMatches(cron: Cron, v: { dom: number; dow: number }): boolean {
  const dowMatch = cron.dow.values.has(v.dow) || (v.dow === 0 && cron.dow.values.has(7));
  const domMatch = cron.dom.values.has(v.dom);
  // Traditional cron ORs the day fields when both are constrained.
  if (cron.dom.wildcard) return dowMatch;
  if (cron.dow.wildcard) return domMatch;
  return domMatch || dowMatch;
}

/**
 * Next `count` trigger instants strictly after `after`. Walks UTC minutes like
 * the Agent, but skips to the next hour / day when those fields cannot match.
 */
export function nextOccurrences(expression: string, timeZone: string, count = 3, after = new Date()): Date[] {
  const cron = parseCron(expression);
  if (!cron) return [];
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
  } catch {
    return [];
  }
  const out: Date[] = [];
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 370 * 24 * 60 * 60 * 1000;
  while (out.length < count && t.getTime() <= limit) {
    const v = zoned(t, fmt);
    if (!cron.month.values.has(v.month) || !dayMatches(cron, v)) {
      t.setUTCMinutes(t.getUTCMinutes() + (24 - v.hour) * 60 - v.minute);
    } else if (!cron.hour.values.has(v.hour)) {
      t.setUTCMinutes(t.getUTCMinutes() + 60 - v.minute);
    } else if (!cron.minute.values.has(v.minute)) {
      t.setUTCMinutes(t.getUTCMinutes() + 1);
    } else {
      out.push(new Date(t.getTime()));
      t.setUTCMinutes(t.getUTCMinutes() + 1);
    }
  }
  return out;
}

// ── frequency builder ────────────────────────────────────────────────

export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly' | 'custom';

export type ScheduleForm = {
  frequency: Frequency;
  /** HH:MM wall clock in the job's timezone. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: number[];
  dayOfMonth: number;
  /** YYYY-MM-DD for one-time jobs. */
  date: string;
  cron: string;
};

function hm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  return m ? [Number(m[1]), Number(m[2])] : [9, 0];
}

/** Cron expression the builder stands for (custom returns the raw text). */
export function buildCron(form: ScheduleForm): string {
  const [h, m] = hm(form.time);
  switch (form.frequency) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${[...form.weekdays].sort((a, b) => a - b).join(',') || '1'}`;
    case 'monthly':
      return `${m} ${h} ${form.dayOfMonth} * *`;
    default:
      return form.cron.trim();
  }
}

/** Reverse of buildCron for editing; anything else stays a custom expression. */
export function formFromCron(expression: string): Pick<ScheduleForm, 'frequency' | 'time' | 'weekdays' | 'dayOfMonth' | 'cron'> {
  const base = { frequency: 'custom' as Frequency, time: '09:00', weekdays: [1], dayOfMonth: 1, cron: expression };
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1]) || f[3] !== '*') return base;
  const time = `${f[1].padStart(2, '0')}:${f[0].padStart(2, '0')}`;
  if (f[2] === '*' && f[4] === '*') return { ...base, frequency: 'daily', time };
  if (f[2] === '*' && /^[0-7](,[0-7])*$/.test(f[4])) {
    const days = [...new Set(f[4].split(',').map((d) => Number(d) % 7))];
    return { ...base, frequency: 'weekly', time, weekdays: days };
  }
  if (/^\d+$/.test(f[2]) && f[4] === '*') return { ...base, frequency: 'monthly', time, dayOfMonth: Number(f[2]) };
  return base;
}

const WEEK_ZH = ['日', '一', '二', '三', '四', '五', '六'];

/** Short Chinese description for the table ("每周一、三 09:00"). */
export function describeCron(expression: string): string {
  const f = formFromCron(expression);
  switch (f.frequency) {
    case 'daily':
      return `每天 ${f.time}`;
    case 'weekly': {
      const days = [...f.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      return days.length === 7 ? `每天 ${f.time}` : `每周${days.map((d) => WEEK_ZH[d]).join('、')} ${f.time}`;
    }
    case 'monthly':
      return `每月 ${f.dayOfMonth} 日 ${f.time}`;
    default:
      return `Cron ${expression}`;
  }
}

export function describeJob(job: Pick<CronJob, 'schedule_type' | 'cron_expression' | 'run_at' | 'timezone'>): string {
  if (job.schedule_type === 'once') return `仅一次 · ${formatInstant(job.run_at, job.timezone)}`;
  return describeCron(job.cron_expression || '');
}

// ── time helpers ─────────────────────────────────────────────────────

/** "9月29日 周一 09:00" in the job's timezone. */
export function formatInstant(iso: string | Date | null, timeZone: string): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

function offsetMinutes(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Wall-clock date + time in `timeZone` → ISO string with its UTC offset, the
 * form the Agent requires for run_at ("must include a UTC offset").
 */
export function zonedIso(date: string, time: string, timeZone: string): string | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) return null;
  const [h, m] = hm(time);
  const wall = Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), h, m);
  let off = offsetMinutes(new Date(wall), timeZone);
  off = offsetMinutes(new Date(wall - off * 60000), timeZone);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date}T${pad(h)}:${pad(m)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

// ── run history ──────────────────────────────────────────────────────

export type RunOutcome = 'ok' | 'err' | 'skip' | 'live';

/** One scheduled instant's result: the cron row status, else its Run's. */
export function runOutcome(run: Pick<CronJobRun, 'status' | 'run_status'>): RunOutcome {
  const status = String(run.status || '').toUpperCase();
  if (status === 'FAILED') return 'err';
  if (status === 'SKIPPED') return 'skip';
  const runStatus = String(run.run_status || '').toUpperCase();
  if (runStatus === 'SUCCEEDED') return 'ok';
  if (['FAILED', 'CANCELLED', 'CRASHED', 'INTERRUPTED', 'BUDGET_EXCEEDED'].includes(runStatus)) return 'err';
  return 'live';
}

export type DayCell = { day: string; outcome: RunOutcome | 'none'; count: number };

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Last `days` local days, oldest first; a day with any failure shows as failed. */
export function dailyStrip(runs: readonly Pick<CronJobRun, 'status' | 'run_status' | 'scheduled_at'>[], days = 30, now = new Date()): DayCell[] {
  const cells: DayCell[] = [];
  const index = new Map<string, DayCell>();
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const cell: DayCell = { day: localDay(d), outcome: 'none', count: 0 };
    cells.push(cell);
    index.set(cell.day, cell);
  }
  const rank: Record<DayCell['outcome'], number> = { none: 0, skip: 1, ok: 2, live: 3, err: 4 };
  for (const run of runs) {
    if (!run.scheduled_at) continue;
    const cell = index.get(localDay(new Date(run.scheduled_at)));
    if (!cell) continue;
    const outcome = runOutcome(run);
    cell.count += 1;
    if (rank[outcome] > rank[cell.outcome]) cell.outcome = outcome;
  }
  return cells;
}

// ── "new results" dot in the sidebar ─────────────────────────────────

const SEEN_KEY = 'schedules-seen-at';

/** True when some job ran after the viewer last opened the schedules page. */
export function hasUnseenRuns(jobs: readonly Pick<CronJob, 'last_run_at'>[], seenAt: string | null): boolean {
  const seen = Date.parse(seenAt || '');
  return jobs.some((job) => {
    const ran = Date.parse(job.last_run_at || '');
    return Number.isFinite(ran) && (!Number.isFinite(seen) || ran > seen);
  });
}

/** Per-browser marker; storage can be unavailable (private mode), which reads as "never seen". */
export function readSchedulesSeenAt(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markSchedulesSeen(at = new Date()): void {
  try {
    window.localStorage.setItem(SEEN_KEY, at.toISOString());
    window.dispatchEvent(new Event('schedules-seen'));
  } catch {
    /* per-viewer convenience only */
  }
}
