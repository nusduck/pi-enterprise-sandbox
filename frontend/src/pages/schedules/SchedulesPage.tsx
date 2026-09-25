import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import {
  createCronJob,
  deleteCronJob,
  listAllCronJobRuns,
  listCronJobs,
  runCronJobNow,
  updateCronJob,
  type CronJob,
  type CronJobInput,
  type CronJobRun,
} from '../../shared/api/cron-jobs';
import { getRun } from '../../shared/api/runs';
import { agentTone, isDefaultAgentName } from '../../widgets/conversation-sidebar/sidebarModel';
import { dailyStrip, describeJob, formatInstant, markSchedulesSeen, runOutcome, type RunOutcome } from './scheduleModel';
import { ScheduleDialog } from './ScheduleDialog';
import s from './schedules.module.css';

type Tab = 'jobs' | 'runs';
type HistoryRow = CronJobRun & { jobName: string; timezone: string };

const OUTCOME: Record<RunOutcome, [string, string]> = {
  ok: ['成功', s.ok],
  err: ['失败', s.fail],
  skip: ['已跳过', s.mute],
  live: ['进行中', s.live],
};

/**
 * Scheduled tasks: the jobs table and the run history across all jobs, with a
 * 30-day strip on top. Each job starts a conversation when it fires, so every
 * run links back to the conversation it produced.
 */
export function SchedulesPage() {
  const navigate = useNavigate();
  const { agents, agentNameById } = useChat();
  const [tab, setTab] = useState<Tab>('jobs');
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ job: CronJob | null } | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      // The strip covers 30 days; one cross-job request replaces one per job.
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - 30);
      const [list, runs] = await Promise.all([listCronJobs(), listAllCronJobRuns(since)]);
      if (gen !== generation.current) return;
      setJobs(list);
      setError(null);
      setHistory(runs.map((r) => ({ ...r, jobName: r.job_name, timezone: r.job_timezone })));
    } catch (err) {
      if (gen === generation.current) setError((err as Error).message || '读取定时任务失败');
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opening the page clears the sidebar's "new results" dot.
  useEffect(() => {
    markSchedulesSeen();
  }, []);

  useEffect(() => {
    if (!menuFor) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(`.${s.more}`)) {
        setMenuFor(null);
        setConfirmDelete(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuFor]);

  const strip = useMemo(() => dailyStrip(history, 30), [history]);
  const recent = strip.reduce((n, c) => n + c.count, 0);
  const recentFailed = history.filter((r) => runOutcome(r) === 'err'
    && r.scheduled_at && Date.now() - Date.parse(r.scheduled_at) < 30 * 86_400_000).length;

  async function act(label: string, fn: () => Promise<unknown>) {
    setMenuFor(null);
    setConfirmDelete(null);
    try {
      await fn();
      setNotice(label);
      await refresh();
    } catch (err) {
      setError((err as Error).message || `${label}失败`);
    }
  }

  async function save(input: CronJobInput) {
    const job = editing?.job;
    if (job) await updateCronJob(job.cron_job_id, input);
    else await createCronJob(input);
    setEditing(null);
    setNotice(job ? '已保存' : '已创建');
    await refresh();
  }

  async function openRun(run: HistoryRow) {
    if (!run.run_id) return;
    try {
      const detail = await getRun(run.run_id);
      const conversationId = detail?.conversation_id;
      if (!conversationId) throw new Error('找不到这次运行对应的会话');
      navigate(`/c/${encodeURIComponent(conversationId)}`);
    } catch (err) {
      setError((err as Error).message || '打开会话失败');
    }
  }

  const agentTag = (agentId: string | null) => {
    const name = agentId ? agentNameById(agentId) : null;
    return agentId && !isDefaultAgentName(name)
      ? <span className={s.tag} style={{ ['--tag' as string]: `var(--agent-tone-${agentTone(agentId)})` }}>{name}</span>
      : null;
  };

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.top}>
          <div className={s.tabs} role="tablist" aria-label="定时任务">
            <button type="button" role="tab" aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')}>定时任务</button>
            <button type="button" role="tab" aria-selected={tab === 'runs'} onClick={() => setTab('runs')}>运行</button>
          </div>
          <span className={s.sp} />
          <button type="button" className={s.primaryPill} onClick={() => setEditing({ job: null })}>新建定时任务</button>
        </div>

        {error ? <p className={s.banner} role="alert" onClick={() => setError(null)}>{error}</p> : null}
        {notice ? <p className={`${s.banner} ${s.bannerOk}`} role="status" onClick={() => setNotice(null)}>{notice}</p> : null}

        <section className={`${s.panel} ${s.history}`} aria-label="最近 30 天运行">
          <div className={s.historyHead}>
            <b>运行历史记录</b>
            <span className={s.muted}>最近 30 天</span>
            <span className={s.sp} />
            <button type="button" className={s.link} onClick={() => setTab('runs')}>
              {recent} 次运行{recentFailed ? ` · ${recentFailed} 次失败` : ''} ›
            </button>
          </div>
          <div className={s.bars} role="img" aria-label={`最近 30 天共 ${recent} 次运行，${recentFailed} 次失败`}>
            {strip.map((c) => (
              <i key={c.day} className={s[`bar_${c.outcome}`]} title={`${c.day} · ${c.count ? `${c.count} 次` : '无运行'}`} />
            ))}
          </div>
          <div className={s.legend}>
            <span><i className={s.bar_ok} />成功</span>
            <span><i className={s.bar_err} />有失败</span>
            <span><i className={s.bar_none} />无运行</span>
          </div>
        </section>

        {tab === 'jobs' ? (
          <section className={`${s.panel} ${s.tableWrap}`}>
            {loading && !jobs.length ? <p className={s.empty}>正在读取…</p> : null}
            {!loading && !jobs.length ? (
              <div className={s.empty}>
                <b>还没有定时任务</b>
                <span>定时任务会按计划自动发起一次对话，结果出现在会话列表里。</span>
              </div>
            ) : null}
            {jobs.length ? (
              <table className={s.table}>
                <thead>
                  <tr><th>定时任务</th><th>日程</th><th>下次运行</th><th>状态</th><th aria-label="操作" /></tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.cron_job_id} onClick={() => setEditing({ job })}>
                      <td>
                        <span className={s.name}>
                          <span className={s.icon} aria-hidden="true">
                            <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M11 2.8 5 11h4.5L9 17.2 15 9h-4.5z" /></svg>
                          </span>
                          {job.name}
                          {agentTag(job.agent_id)}
                        </span>
                      </td>
                      <td className={s.muted}>{describeJob(job)}</td>
                      <td className={s.num}>{job.enabled ? formatInstant(job.next_run_at, job.timezone) : '—'}</td>
                      <td>
                        <span className={s.state}>
                          <i className={job.enabled ? s.dotOn : s.dotOff} aria-hidden="true" />
                          {job.enabled ? '已启用' : '已暂停'}
                        </span>
                      </td>
                      <td className={s.more} onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className={s.ghost}
                          aria-label={`${job.name} 的更多操作`}
                          aria-expanded={menuFor === job.cron_job_id}
                          onClick={() => setMenuFor(menuFor === job.cron_job_id ? null : job.cron_job_id)}
                        >
                          ⋯
                        </button>
                        {menuFor === job.cron_job_id ? (
                          <div className={s.menu} role="menu">
                            <button type="button" role="menuitem" onClick={() => void act('已开始运行', () => runCronJobNow(job.cron_job_id))}>立即运行</button>
                            <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setEditing({ job }); }}>编辑</button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => void act(job.enabled ? '已暂停' : '已启用', () => updateCronJob(job.cron_job_id, { enabled: !job.enabled }))}
                            >
                              {job.enabled ? '暂停' : '启用'}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className={s.danger}
                              onClick={() =>
                                confirmDelete === job.cron_job_id
                                  ? void act('已删除', () => deleteCronJob(job.cron_job_id))
                                  : setConfirmDelete(job.cron_job_id)
                              }
                            >
                              {confirmDelete === job.cron_job_id ? '确认删除（运行记录会保留）' : '删除'}
                            </button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>
        ) : (
          <section className={`${s.panel} ${s.tableWrap}`}>
            {!history.length ? <div className={s.empty}><b>还没有运行记录</b></div> : (
              <table className={s.table}>
                <thead>
                  <tr><th>计划时间</th><th>定时任务</th><th>结果</th><th aria-label="操作" /></tr>
                </thead>
                <tbody>
                  {history.map((run) => {
                    const [label, cls] = OUTCOME[runOutcome(run)];
                    return (
                      <tr key={run.cron_job_run_id} className={s.static}>
                        <td className={s.num}>{formatInstant(run.scheduled_at, run.timezone)}</td>
                        <td>{run.jobName}</td>
                        <td>
                          <span className={`${s.pill} ${cls}`}>{label}</span>
                          {run.error_message ? <span className={s.errText}> {run.error_message}</span> : null}
                        </td>
                        <td className={s.right}>
                          {run.run_id ? (
                            <button type="button" className={s.btn} onClick={() => void openRun(run)}>打开会话</button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        )}
      </div>

      <ScheduleDialog
        open={editing != null}
        job={editing?.job ?? null}
        agents={agents}
        onClose={() => setEditing(null)}
        onSave={save}
        onTryRun={editing?.job ? () => act('已开始运行', () => runCronJobNow(editing.job!.cron_job_id)) : undefined}
      />
    </div>
  );
}
