/**
 * 运行（admin）：统计条 + 筛选 + 整行可点的表格，点进 /admin/runs/:runId 看 Trace。
 * 数据来自 owner 作用域的 /api/runs（最近 50 次）；全组织视图与服务端统计见第 3 期。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listRuns, listRunTools } from '../../shared/api/runs';
import type { RunDetail } from '../../shared/schemas/events';
import { isDefaultAgentName } from '../../widgets/conversation-sidebar/sidebarModel';
import {
  RUN_STATUS_FILTERS,
  filterRunsByStatus,
  formatLongDuration,
  formatRunDuration,
  inRange,
  mergeRunRows,
  normalizeRunStatus,
  runStats,
  type RunRange,
  type RunRow,
  type RunStatusFilterId,
} from './runHelpers';
import a from '../settings/adminPage.module.css';
import s from './runs.module.css';

const STATUS_ZH: Record<string, [string, string]> = {
  accepted: ['排队中', a.mute],
  queued: ['排队中', a.mute],
  starting: ['启动中', a.info],
  restoring_session: ['恢复中', a.info],
  running: ['运行中', a.info],
  waiting_approval: ['等待审批', a.warn],
  waiting_input: ['等待回答', a.warn],
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

const RANGES: Array<[RunRange, string]> = [['today', '今天'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['all', '全部']];

export function RunsPage() {
  const { entityStore, state, agents, agentNameById } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RunStatusFilterId>('all');
  const [query, setQuery] = useState('');
  const [agentId, setAgentId] = useState('');
  const [range, setRange] = useState<RunRange>('7d');
  const [apiRows, setApiRows] = useState<RunDetail[]>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setApiRows(await listRuns());
      setApiAvailable(true);
    } catch {
      setApiRows([]);
      setApiAvailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allRows = useMemo(() => mergeRunRows(apiRows, entityStore), [apiRows, entityStore]);
  const conversationById = useMemo(
    () => new Map((state.conversations || []).map((c) => [c.id, c])),
    [state.conversations],
  );
  // The list is owner-scoped, so every row belongs to the signed-in user.
  const owner = String(state.authUser?.display_name || state.authUser?.username || '—');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return filterRunsByStatus(allRows, filter).filter((row) => {
      if (!inRange(row, range)) return false;
      const conv = row.conversationId ? conversationById.get(row.conversationId) : null;
      if (agentId && conv?.agent_id !== agentId) return false;
      if (!q) return true;
      return (conv?.title || '').toLowerCase().includes(q) || row.id.toLowerCase().includes(q) || owner.toLowerCase().includes(q);
    });
  }, [allRows, filter, range, agentId, query, conversationById, owner]);
  const stats = useMemo(() => runStats(allRows), [allRows]);

  // Tool counts come from each run's ledger; the list API has no count yet.
  useEffect(() => {
    const missing = rows.slice(0, 50).map((r) => r.id).filter((id) => toolCounts[id] == null);
    if (!missing.length) return;
    let alive = true;
    void Promise.all(missing.map((id) => listRunTools(id).then((t) => [id, t.length] as const).catch(() => [id, -1] as const)))
      .then((pairs) => {
        if (alive) setToolCounts((cur) => ({ ...cur, ...Object.fromEntries(pairs) }));
      });
    return () => {
      alive = false;
    };
  }, [rows, toolCounts]);

  const titleOf = (row: RunRow) => (row.conversationId ? conversationById.get(row.conversationId)?.title : null) || '（无标题会话）';
  const agentLabel = (row: RunRow) => {
    const id = row.conversationId ? conversationById.get(row.conversationId)?.agent_id : null;
    const name = id ? agentNameById(id) : null;
    return name ? (isDefaultAgentName(name) ? 'default' : name) : '—';
  };
  const open = (row: RunRow) => navigate(`/admin/runs/${encodeURIComponent(row.id)}`);
  const delta = stats.today - stats.yesterday;

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>运行</h1>
          <p>每次模型回复是一次运行，点进任意一行查看完整 Trace。</p>
        </div>
        <span className={a.sp} />
        <button type="button" className={a.btn} onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      <p className={s.scope}>目前只包含你自己最近 50 次运行；全组织视图、用户筛选与服务端统计待管理接口（第 3 期）。</p>

      <div className={s.kpis}>
        <div className={s.kpi}><small>今日运行</small><b>{stats.today}</b><span>较昨日 {delta >= 0 ? `+${delta}` : delta}</span></div>
        <div className={s.kpi}>
          <small>失败</small><b className={stats.failedToday ? s.errNum : undefined}>{stats.failedToday}</b>
          <span>{stats.failureRate == null ? '今日无运行' : `失败率 ${(stats.failureRate * 100).toFixed(1)}%`}</span>
        </div>
        <div className={s.kpi}>
          <small>等待中</small><b className={stats.waiting ? s.warnNum : undefined}>{stats.waiting}</b>
          <span>{stats.longestWaitMs == null ? '没有等待审批或回答' : `最久 ${formatLongDuration(stats.longestWaitMs)}`}</span>
        </div>
        <div className={s.kpi}><small>耗时中位数</small><b>{formatLongDuration(stats.medianMs)}</b><span>P95 {formatLongDuration(stats.p95Ms)}</span></div>
        <div className={s.kpi}><small>近 7 天运行量</small><Sparkline values={stats.last7} /></div>
      </div>

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

      <div className={a.tableWrap}>
        {rows.length === 0 ? (
          <div className={a.empty}>
            {loading ? '正在读取…' : apiAvailable === false ? '运行列表接口暂不可用。' : '没有符合条件的运行。'}
          </div>
        ) : (
          <table className={a.table}>
            <thead>
              <tr>
                <th>状态</th><th>会话</th><th>用户</th><th>智能体</th><th>模型</th>
                <th className={a.right}>工具</th><th className={a.right}>Tokens</th><th className={a.right}>耗时</th><th>开始</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={s.row}
                  tabIndex={0}
                  onClick={() => open(row)}
                  onKeyDown={(e) => { if (e.key === 'Enter') open(row); }}
                >
                  <td><RunStatus status={row.status} /></td>
                  <td className={s.title}><span>{titleOf(row)}</span></td>
                  <td>{owner}</td>
                  <td>{agentLabel(row)}</td>
                  <td className={`${a.mono} ${a.muted}`}>{row.model || '平台默认'}</td>
                  <td className={`${a.right} ${a.num}`}>{toolCounts[row.id] == null || toolCounts[row.id] < 0 ? '—' : toolCounts[row.id]}</td>
                  <td className={`${a.right} ${a.num}`}>{row.tokenUsage || '—'}</td>
                  <td className={`${a.right} ${a.num}`}>{formatRunDuration(row.startedAt, row.finishedAt)}</td>
                  <td className={a.num}>{formatClock(row.startedAt || row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
