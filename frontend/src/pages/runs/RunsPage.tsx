/**
 * 运行（admin）：全组织的运行。统计条 + 筛选 + 整行可点的表格，点进
 * /admin/runs/:runId 看 Trace。数据来自 /api/admin/runs*（角色与 org 作用域由 agent/ 判定）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import {
  getAdminRunStats,
  listAdminRuns,
  type AdminRun,
  type AdminRunStats,
} from '../../shared/api/adminRuns';
import {
  RUN_STATUS_FILTERS,
  formatLongDuration,
  formatRunDuration,
  normalizeRunStatus,
  type RunStatusFilterId,
} from './runHelpers';
import a from '../settings/adminPage.module.css';
import s from './runs.module.css';

const STATUS_ZH: Record<string, [string, string]> = {
  accepted: ['排队中', a.mute],
  queued: ['排队中', a.mute],
  starting: ['启动中', a.info],
  retrying: ['重试中', a.info],
  restoring_session: ['恢复中', a.info],
  running: ['运行中', a.info],
  waiting_approval: ['等待审批', a.warn],
  waiting_input: ['等待回答', a.warn],
  cancelling: ['取消中', a.mute],
  cancel_requested: ['取消中', a.mute],
  succeeded: ['成功', a.ok],
  completed: ['成功', a.ok],
  failed: ['失败', a.err],
  cancelled: ['已取消', a.mute],
  interrupted: ['已中断', a.warn],
};

export function RunStatus({ status }: { status: string }) {
  const key = normalizeRunStatus(status);
  const [label, cls] = STATUS_ZH[key] || [key, a.mute];
  return <span className={`${a.pill} ${cls}`}>{label}</span>;
}

export function formatClock(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('zh-CN', today
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 140, 24 - (v / max) * 22] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <svg className={s.spark} viewBox="0 0 140 26" preserveAspectRatio="none" role="img" aria-label={`近 7 天运行量：${values.join(', ')}`}>
      <polygon points={`0,26 ${line} 140,26`} className={s.sparkFill} />
      <polyline points={line} className={s.sparkLine} />
      <circle cx={last[0]} cy={last[1]} r="2.2" className={s.sparkDot} />
    </svg>
  );
}

/** UI filter → the Agent's status parameter (groups or plan §10 statuses). */
const STATUS_PARAM: Record<RunStatusFilterId, string | null> = {
  all: null,
  running: 'running',
  waiting_approval: 'WAITING_APPROVAL',
  waiting_input: 'WAITING_INPUT',
  failed: 'failed',
  completed: 'completed',
};

type RunRange = 'today' | '7d' | '30d' | 'all';
const RANGES: Array<[RunRange, string]> = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部']];

function localMidnight(daysAgo = 0): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

function rangeStart(range: RunRange): string | null {
  if (range === 'all') return null;
  return localMidnight(range === 'today' ? 0 : range === '7d' ? 6 : 29).toISOString();
}

export function RunsPage() {
  const { agents } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RunStatusFilterId>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [agentId, setAgentId] = useState('');
  const [range, setRange] = useState<RunRange>('7d');
  const [runs, setRuns] = useState<AdminRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<AdminRunStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = useCallback(async (append: string | null = null) => {
    const gen = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const page = await listAdminRuns({
        status: STATUS_PARAM[filter],
        agentId: agentId || null,
        from: rangeStart(range),
        q: debounced || null,
        cursor: append,
      });
      if (gen !== generation.current) return;
      setRuns((cur) => (append ? [...cur, ...page.runs] : page.runs));
      setCursor(page.next_cursor ?? null);
    } catch (err) {
      if (gen !== generation.current) return;
      const status = (err as { status?: number }).status;
      setError(status === 403 ? '需要管理员权限。' : (err as Error).message || '读取运行失败');
      if (!append) setRuns([]);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [filter, agentId, range, debounced]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await getAdminRunStats(localMidnight()));
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const open = (run: AdminRun) => navigate(`/admin/runs/${encodeURIComponent(run.run_id)}`);
  const delta = stats ? stats.today - stats.yesterday : 0;

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>运行</h1>
          <p>本组织所有用户的运行记录，点进任意一行查看完整 Trace。</p>
        </div>
        <span className={a.sp} />
        <button type="button" className={a.btn} onClick={() => { void load(); void loadStats(); }} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className={s.kpis}>
        <div className={s.kpi}><small>今日运行</small><b>{stats?.today ?? '—'}</b><span>{stats ? `较昨日 ${delta >= 0 ? `+${delta}` : delta}` : ' '}</span></div>
        <div className={s.kpi}>
          <small>失败</small><b className={stats?.failed_today ? s.errNum : undefined}>{stats?.failed_today ?? '—'}</b>
          <span>{!stats ? ' ' : stats.failure_rate == null ? '今日无运行' : `失败率 ${(stats.failure_rate * 100).toFixed(1)}%`}</span>
        </div>
        <div className={s.kpi}>
          <small>等待中</small><b className={stats?.waiting ? s.warnNum : undefined}>{stats?.waiting ?? '—'}</b>
          <span>{!stats ? ' ' : stats.longest_wait_ms == null ? '没有等待审批或回答' : `最久 ${formatLongDuration(stats.longest_wait_ms)}`}</span>
        </div>
        <div className={s.kpi}>
          <small>耗时中位数</small><b>{formatLongDuration(stats?.median_ms ?? null)}</b>
          <span>P95 {formatLongDuration(stats?.p95_ms ?? null)}</span>
        </div>
        <div className={s.kpi}><small>近 7 天运行量</small>{stats ? <Sparkline values={stats.last_7_days} /> : null}</div>
      </div>
      {stats?.truncated ? <p className={s.scope}>近 7 天运行超过 2 万次，统计为下限值。</p> : null}

      <div className={a.toolbar}>
        <input className={a.search} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话标题、Run ID、用户" aria-label="搜索运行" />
        <div className={a.seg} role="tablist" aria-label="按状态筛选">
          {RUN_STATUS_FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <select className={s.select} value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="按智能体筛选">
          <option value="">全部智能体</option>
          {agents.map((ag) => <option key={ag.agent_id} value={ag.agent_id}>{ag.name}</option>)}
        </select>
        <select className={s.select} value={range} onChange={(e) => setRange(e.target.value as RunRange)} aria-label="时间范围">
          {RANGES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      {error ? <p className={a.notice} role="alert">{error}</p> : null}

      <div className={a.tableWrap}>
        {runs.length === 0 ? (
          <div className={a.empty}>{loading ? '正在读取…' : error ? '—' : '没有符合条件的运行。'}</div>
        ) : (
          <table className={a.table}>
            <thead>
              <tr>
                <th>状态</th><th>会话</th><th>用户</th><th>智能体</th><th>模型</th>
                <th className={a.right}>工具</th><th className={a.right}>Tokens</th><th className={a.right}>耗时</th><th>开始</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.run_id}
                  className={s.row}
                  tabIndex={0}
                  onClick={() => open(run)}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(run); }}
                >
                  <td><RunStatus status={run.status} /></td>
                  <td className={s.title}>
                    <span>{run.conversation_title || '（无标题会话）'}</span>
                    {run.parent_run_id ? <small className={a.muted}>子运行</small> : null}
                  </td>
                  <td>{run.user_name || '—'}</td>
                  <td>{run.agent_name ? `${run.agent_name}${run.agent_version_no ? ` · v${run.agent_version_no}` : ''}` : '—'}</td>
                  <td className={`${a.mono} ${a.muted}`}>{run.model_id || '平台默认'}</td>
                  <td className={`${a.right} ${a.num}`}>{run.tool_count}{run.approval_count ? <small className={a.muted}> · 审批 {run.approval_count}</small> : null}</td>
                  <td className={`${a.right} ${a.num}`} title="token 用量尚未采集">—</td>
                  <td className={`${a.right} ${a.num}`}>{formatRunDuration(run.started_at ?? null, run.completed_at ?? null)}</td>
                  <td className={a.num}>{formatClock(run.started_at || run.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {cursor ? (
        <button type="button" className={`${a.btn} ${s.more}`} disabled={loading} onClick={() => void load(cursor)}>
          {loading ? '读取中…' : '加载更多'}
        </button>
      ) : null}
    </div>
  );
}
