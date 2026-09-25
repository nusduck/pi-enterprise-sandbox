/**
 * 运行（admin）：Run 列表 + 右侧详情（概况 / Trace）。
 * 列表 API 不可用时退回本浏览器会话里的 Run（entity store）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listRuns, cancelRun, getRun, getRunTraceSpans } from '../../shared/api/runs';
import { getRunTraceSpans as getStoreTraceSpans, type TraceSpanEntity } from '../../entities';
import type { RunDetail } from '../../shared/schemas/events';
import { TracePanel } from '../../widgets/trace-panel/TracePanel';
import { agentTone, isDefaultAgentName } from '../../widgets/conversation-sidebar/sidebarModel';
import {
  RUN_STATUS_FILTERS,
  canCancelRun,
  filterRunsByStatus,
  formatRunDuration,
  mergeRunRows,
  normalizeRunStatus,
  shortId,
  traceSpansFromResponse,
  type RunRow,
  type RunStatusFilterId,
} from './runHelpers';
import a from '../settings/adminPage.module.css';
import s from './runs.module.css';

const STATUS_ZH: Record<string, [string, string]> = {
  queued: ['排队中', a.mute],
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

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date().toDateString() === date.toDateString();
  return date.toLocaleString('zh-CN', today
    ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

type DetailTab = 'overview' | 'trace';

export function RunsPage() {
  const { entityStore, state, agentNameById } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RunStatusFilterId>('all');
  const [apiRows, setApiRows] = useState<RunDetail[]>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [traceSpans, setTraceSpans] = useState<TraceSpanEntity[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

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
  const rows = useMemo(() => filterRunsByStatus(allRows, filter), [allRows, filter]);
  const counts = useMemo(
    () => Object.fromEntries(RUN_STATUS_FILTERS.map((f) => [f.id, filterRunsByStatus(allRows, f.id).length])),
    [allRows],
  );
  const conversationById = useMemo(
    () => new Map((state.conversations || []).map((c) => [c.id, c])),
    [state.conversations],
  );
  const showModel = allRows.some((r) => r.model);
  const selected = rows.find((r) => r.id === selectedId) ?? allRows.find((r) => r.id === selectedId) ?? null;

  const loadDetail = useCallback(async (runId: string) => {
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await getRun(runId));
    } catch (err) {
      setDetailError((err as Error).message || '读取运行详情失败');
    }
  }, []);

  const loadTrace = useCallback(async (runId: string) => {
    setTraceLoading(true);
    setTraceError(null);
    setTraceSpans([]);
    try {
      const resp = await getRunTraceSpans(runId);
      setTraceSpans(traceSpansFromResponse(runId, resp));
      setTraceId(resp.traceId || resp.trace_id || null);
    } catch {
      const storeSpans = getStoreTraceSpans(entityStore, runId);
      setTraceSpans(storeSpans);
      setTraceId(entityStore.runsById[runId]?.traceId || null);
      if (!storeSpans.length) setTraceError('没有找到这次运行的 Trace。');
    } finally {
      setTraceLoading(false);
    }
  }, [entityStore]);

  function select(row: RunRow) {
    if (row.id === selectedId) {
      setSelectedId(null);
      return;
    }
    setSelectedId(row.id);
    setConfirmCancel(null);
    void loadDetail(row.id);
    if (tab === 'trace') void loadTrace(row.id);
  }

  function switchTab(next: DetailTab) {
    setTab(next);
    if (next === 'trace' && selectedId) void loadTrace(selectedId);
  }

  function openConversation(row: RunRow) {
    if (row.conversationId) navigate(`/c/${encodeURIComponent(row.conversationId)}`);
  }

  async function onCancel(row: RunRow) {
    if (!canCancelRun(row.status)) return;
    if (confirmCancel !== row.id) {
      setConfirmCancel(row.id);
      return;
    }
    setConfirmCancel(null);
    setBusyId(row.id);
    try {
      const result = await cancelRun(row.id);
      const extra = result.cancelledDescendants.length ? `，连带 ${result.cancelledDescendants.length} 个子任务` : '';
      setBanner(`已请求取消 ${shortId(row.id)}${extra}。`);
      await refresh();
      if (selectedId === row.id) void loadDetail(row.id);
    } catch (err) {
      setBanner((err as Error).message || '取消失败');
    } finally {
      setBusyId(null);
    }
  }

  const titleOf = (row: RunRow) => {
    const conv = row.conversationId ? conversationById.get(row.conversationId) : null;
    return conv?.title || (row.conversationId ? `会话 ${shortId(row.conversationId, 8)}` : '—');
  };
  const agentOf = (row: RunRow) => {
    const conv = row.conversationId ? conversationById.get(row.conversationId) : null;
    const agentId = conv?.agent_id ?? null;
    const name = agentId ? agentNameById(agentId) : null;
    return agentId && !isDefaultAgentName(name)
      ? <span className={s.agent} style={{ ['--tag' as string]: `var(--agent-tone-${agentTone(agentId)})` }}>{name}</span>
      : null;
  };

  return (
    <div className={a.page}>
      <div className={a.head}>
        <div>
          <h1>运行</h1>
          <p>每一次模型回复都是一次运行。点一行查看概况与 Trace；目前只列出你自己的运行，跨用户视图待服务端接口。</p>
        </div>
        <span className={a.sp} />
        <button type="button" className={a.btn} onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {banner ? <p className={a.notice} role="status" onClick={() => setBanner(null)}>{banner}</p> : null}

      <div className={a.tabs} role="tablist" aria-label="按状态筛选">
        {RUN_STATUS_FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}<small>{counts[f.id] ?? 0}</small>
          </button>
        ))}
      </div>

      <div className={`${s.split}${selected ? ` ${s.withDetail}` : ''}`}>
        <div className={a.tableWrap}>
          {rows.length === 0 ? (
            <div className={a.empty}>
              {loading
                ? '正在读取…'
                : apiAvailable === false
                  ? '运行列表接口暂不可用；本页只能显示这个浏览器里产生的运行。'
                  : filter === 'all' ? '还没有运行记录。' : '没有符合这个状态的运行。'}
            </div>
          ) : (
            <table className={a.table}>
              <thead>
                <tr><th>开始</th><th>会话</th><th>状态</th>{showModel ? <th>模型</th> : null}<th className={a.right}>耗时</th><th aria-label="操作" /></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={`${s.row}${row.id === selectedId ? ` ${s.on}` : ''}`}
                    onClick={() => select(row)}
                    aria-selected={row.id === selectedId}
                  >
                    <td className={a.num}>{formatTime(row.startedAt || row.createdAt)}</td>
                    <td className={s.title}>
                      <span>{titleOf(row)}</span>
                      {agentOf(row)}
                    </td>
                    <td><RunStatus status={row.status} /></td>
                    {showModel ? <td className={`${a.mono} ${a.muted}`}>{row.model || '—'}</td> : null}
                    <td className={`${a.right} ${a.num}`}>{formatRunDuration(row.startedAt, row.finishedAt)}</td>
                    <td className={a.right} onClick={(e) => e.stopPropagation()}>
                      <span className={s.actions}>
                        {row.conversationId ? <button type="button" className={s.link} onClick={() => openConversation(row)}>打开会话</button> : null}
                        {canCancelRun(row.status) ? (
                          <button type="button" className={`${s.link} ${s.danger}`} disabled={busyId === row.id} onClick={() => void onCancel(row)}>
                            {busyId === row.id ? '…' : confirmCancel === row.id ? '确认取消' : '取消'}
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {selected ? (
          <aside className={s.detail} aria-label="Run detail">
            <div className={s.detailHead}>
              <div>
                <b>{titleOf(selected)}</b>
                <small className={a.mono}>{selected.id}</small>
              </div>
              <span className={a.sp} />
              <button type="button" className={s.close} aria-label="关闭详情" onClick={() => setSelectedId(null)}>×</button>
            </div>
            <div className={a.tabs} role="tablist" aria-label="运行详情">
              <button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => switchTab('overview')}>概况</button>
              <button type="button" role="tab" aria-selected={tab === 'trace'} onClick={() => switchTab('trace')}>Trace</button>
            </div>
            {tab === 'overview' ? (
              <div className={s.overview}>
                {selected.error || detail?.error ? <p className={s.error}>{detail?.error || selected.error}</p> : null}
                {detailError ? <p className={a.notice}>{detailError}</p> : null}
                <dl className={s.kv}>
                  <dt>状态</dt><dd><RunStatus status={detail?.status || selected.status} /></dd>
                  <dt>开始</dt><dd className={a.num}>{formatTime(selected.startedAt)}</dd>
                  <dt>结束</dt><dd className={a.num}>{formatTime(selected.finishedAt)}</dd>
                  <dt>耗时</dt><dd className={a.num}>{formatRunDuration(selected.startedAt, selected.finishedAt)}</dd>
                  <dt>模型</dt><dd className={a.mono}>{selected.model || '—'}</dd>
                  <dt>Tokens</dt><dd>{selected.tokenUsage || '—'}</dd>
                  <dt>会话</dt><dd className={a.mono}>{selected.conversationId || '—'}</dd>
                  <dt>Agent 会话</dt><dd className={a.mono}>{detail?.agent_session_id || detail?.session_id || '—'}</dd>
                  <dt>事件游标</dt><dd className={a.mono}>{detail?.last_sequence ?? '—'}</dd>
                </dl>
                {selected.conversationId ? (
                  <button type="button" className={a.btn} onClick={() => openConversation(selected)}>打开会话</button>
                ) : null}
              </div>
            ) : traceLoading ? (
              <p className={a.empty}>正在读取 Trace…</p>
            ) : traceError ? (
              <p className={a.empty}>{traceError}</p>
            ) : (
              <div className={s.trace}><TracePanel spans={traceSpans} traceId={traceId} /></div>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
