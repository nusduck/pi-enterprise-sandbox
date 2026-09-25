import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Agent } from '../../shared/api';
import type { CronJob, CronJobInput } from '../../shared/api/cron-jobs';
import {
  buildCron,
  formFromCron,
  formatInstant,
  nextOccurrences,
  parseCron,
  zonedIso,
  type Frequency,
  type ScheduleForm,
} from './scheduleModel';
import s from './schedules.module.css';

const FREQUENCIES: Array<[Frequency, string]> = [
  ['once', '仅一次'],
  ['daily', '每天'],
  ['weekly', '每周'],
  ['monthly', '每月'],
  ['custom', '自定义'],
];
const WEEK: Array<[number, string]> = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];
const ZONES = ['Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/New_York'];

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

type Draft = {
  name: string;
  prompt: string;
  agentId: string;
  timezone: string;
  enabled: boolean;
  misfire: CronJobInput['misfire_policy'];
  concurrency: CronJobInput['concurrency_policy'];
  form: ScheduleForm;
};

function draftFor(job: CronJob | null): Draft {
  const timezone = job?.timezone || browserZone();
  const form: ScheduleForm = {
    frequency: 'weekly', time: '09:00', weekdays: [1], dayOfMonth: 1, date: todayIn(timezone), cron: '0 9 * * 1',
  };
  if (job?.schedule_type === 'cron' && job.cron_expression) {
    Object.assign(form, formFromCron(job.cron_expression));
  } else if (job?.schedule_type === 'once' && job.run_at) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(job.run_at));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    form.frequency = 'once';
    form.date = `${get('year')}-${get('month')}-${get('day')}`;
    form.time = `${get('hour')}:${get('minute')}`;
  }
  return {
    name: job?.name || '',
    prompt: job?.prompt || '',
    agentId: job?.agent_id || '',
    timezone,
    enabled: job?.enabled ?? true,
    misfire: job?.misfire_policy || 'skip',
    concurrency: job?.concurrency_policy || 'forbid',
    form,
  };
}

/**
 * Create / edit a scheduled task. The builder composes a cron expression
 * (or run_at for one-time jobs); the preview lists the next triggers with the
 * same evaluator semantics as the Agent, in the job's own timezone.
 */
export function ScheduleDialog({
  open,
  job,
  agents,
  onClose,
  onSave,
  onTryRun,
}: {
  open: boolean;
  /** null creates a new task. */
  job: CronJob | null;
  agents: Agent[];
  onClose: () => void;
  onSave: (input: CronJobInput) => Promise<void>;
  onTryRun?: () => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFor(job));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open) {
      setDraft(draftFor(job));
      setError(null);
      if (!d.open) d.showModal();
    } else if (d.open) {
      d.close();
    }
  }, [open, job]);

  const form = draft.form;
  const expression = buildCron(form);
  const cronValid = form.frequency === 'once' || parseCron(expression) != null;
  const runAt = form.frequency === 'once' ? zonedIso(form.date, form.time, draft.timezone) : null;
  const preview = useMemo(() => {
    if (form.frequency === 'once') return runAt ? [new Date(runAt)] : [];
    return cronValid ? nextOccurrences(expression, draft.timezone, 3) : [];
  }, [form.frequency, runAt, cronValid, expression, draft.timezone]);
  const zones = ZONES.includes(draft.timezone) ? ZONES : [draft.timezone, ...ZONES];

  const setForm = (patch: Partial<ScheduleForm>) => setDraft((d) => ({ ...d, form: { ...d.form, ...patch } }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.name.trim() || !draft.prompt.trim()) return setError('请填写名称和每次发送的指令');
    if (!cronValid) return setError('Cron 表达式无效：需要 5 个字段（分 时 日 月 周）');
    if (form.frequency === 'weekly' && !form.weekdays.length) return setError('每周至少选择一天');
    if (form.frequency === 'once' && (!runAt || new Date(runAt).getTime() <= Date.now())) {
      return setError('一次性任务的时间需要在将来');
    }
    if (form.frequency !== 'once' && !preview.length) return setError('这个表达式在一年内都不会触发');
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: draft.name.trim(),
        prompt: draft.prompt.trim(),
        agent_id: draft.agentId || null,
        schedule_type: form.frequency === 'once' ? 'once' : 'cron',
        cron_expression: form.frequency === 'once' ? null : expression,
        run_at: form.frequency === 'once' ? runAt : null,
        timezone: draft.timezone,
        enabled: draft.enabled,
        misfire_policy: draft.misfire,
        concurrency_policy: draft.concurrency,
      });
    } catch (err) {
      setError((err as Error).message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} className={s.dialog} onClose={onClose} aria-label={job ? '编辑定时任务' : '新建定时任务'}>
      <form onSubmit={(e) => void submit(e)}>
        <div className={s.formBody}>
          <h2>{job ? '编辑定时任务' : '新建定时任务'}</h2>
          <div className={s.grid2}>
            <label className={s.field}>
              <span>名称</span>
              <input id="cj-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="区域销售周报" />
            </label>
            <label className={s.field}>
              <span>智能体</span>
              <select id="cj-agent" value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
                <option value="">默认智能体</option>
                {agents.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}
              </select>
            </label>
          </div>
          <label className={s.field}>
            <span>每次发送的指令</span>
            <textarea
              id="cj-prompt"
              rows={4}
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="汇总上周各区域销售数据，找出下滑超过 5% 的区域并分析原因。"
            />
          </label>

          <div className={s.field}>
            <span>频率</span>
            <div className={s.seg} role="radiogroup" aria-label="频率">
              {FREQUENCIES.map(([f, label]) => (
                <button key={f} type="button" role="radio" aria-checked={form.frequency === f} onClick={() => setForm({ frequency: f })}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {form.frequency === 'weekly' ? (
            <div className={s.field}>
              <span>星期</span>
              <div className={s.week}>
                {WEEK.map(([d, label]) => {
                  const on = form.weekdays.includes(d);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setForm({ weekdays: on ? form.weekdays.filter((x) => x !== d) : [...form.weekdays, d] })}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <div className={s.grid3}>
            {form.frequency === 'once' ? (
              <label className={s.field}>
                <span>日期</span>
                <input id="cj-date" type="date" value={form.date} onChange={(e) => setForm({ date: e.target.value })} />
              </label>
            ) : null}
            {form.frequency === 'monthly' ? (
              <label className={s.field}>
                <span>每月几号</span>
                <select id="cj-dom" value={form.dayOfMonth} onChange={(e) => setForm({ dayOfMonth: Number(e.target.value) })}>
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d} 日</option>)}
                </select>
              </label>
            ) : null}
            {form.frequency === 'custom' ? (
              <label className={s.field}>
                <span>Cron 表达式</span>
                <input id="cj-cron" className={s.mono} value={form.cron} onChange={(e) => setForm({ cron: e.target.value })} />
                <small>分 时 日 月 周，例如 <code>0 9 * * 1-5</code></small>
              </label>
            ) : (
              <label className={s.field}>
                <span>时间</span>
                <input id="cj-time" type="time" value={form.time} onChange={(e) => setForm({ time: e.target.value })} />
              </label>
            )}
            <label className={s.field}>
              <span>时区</span>
              <select id="cj-tz" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}>
                {zones.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </label>
          </div>

          <div className={s.preview} aria-live="polite">
            <span className={s.muted}>{form.frequency === 'once' ? '将在' : '接下来'}</span>
            {preview.length ? (
              preview.map((d, i) => (
                <span key={d.toISOString()} className={i === 0 ? s.first : s.muted}>
                  {formatInstant(d, draft.timezone)}
                </span>
              ))
            ) : (
              <span className={s.err}>{cronValid ? '一年内不会触发' : '表达式无效'}</span>
            )}
            {form.frequency !== 'once' ? <code className={s.expr}>{expression || '—'}</code> : null}
          </div>

          <details className={s.adv}>
            <summary>高级选项</summary>
            <div className={s.optRow}>
              <span>错过计划时间时<small>例如服务停机期间</small></span>
              <div className={s.seg}>
                <button type="button" aria-pressed={draft.misfire === 'skip'} onClick={() => setDraft({ ...draft, misfire: 'skip' })}>跳过</button>
                <button type="button" aria-pressed={draft.misfire === 'fire_once'} onClick={() => setDraft({ ...draft, misfire: 'fire_once' })}>补跑一次</button>
              </div>
            </div>
            <div className={s.optRow}>
              <span>上一次还没结束时</span>
              <div className={s.seg}>
                <button type="button" aria-pressed={draft.concurrency === 'forbid'} onClick={() => setDraft({ ...draft, concurrency: 'forbid' })}>跳过本次</button>
                <button type="button" aria-pressed={draft.concurrency === 'allow'} onClick={() => setDraft({ ...draft, concurrency: 'allow' })}>同时运行</button>
              </div>
            </div>
          </details>

          <label className={s.check}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
            {job ? '启用' : '创建后立即启用'}
          </label>
          {error ? <p className={s.err} role="alert">{error}</p> : null}
        </div>
        <div className={s.formFoot}>
          {job && onTryRun ? (
            <button type="button" className={s.btn} onClick={() => void onTryRun()}>立即运行一次</button>
          ) : null}
          <span className={s.sp} />
          <button type="button" className={s.btn} onClick={onClose}>取消</button>
          <button type="submit" className={s.btnPri} disabled={saving}>{job ? '保存' : '创建'}</button>
        </div>
      </form>
    </dialog>
  );
}
