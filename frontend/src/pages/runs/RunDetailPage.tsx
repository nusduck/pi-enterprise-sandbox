/**
 * Run 详情（admin）= Trace：左侧 span 瀑布图，右侧选中节点的内容。
 * 节点内容由持久事件与工具台账拼接（见 runTimeline.ts），不改 trace 契约。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { cancelRun, getRun } from '../../shared/api/runs';
import { getAdminRun, listAdminRunEvents, listAdminRunTools, type AdminRun } from '../../shared/api/adminRuns';
import { getProcessLogs, listProcesses, type ManagedProcess } from '../../shared/api/processes';
import type { PersistedAgentEvent, ToolExecutionSnapshot } from '../../shared/schemas/events';
import { canCancelRun, formatRunDuration, runInputLabel } from './runHelpers';
import { buildRunTimeline, formatSpan, type TimelineNode } from './runTimeline';
import { RunStatus, formatClock } from './RunsPage';
import a from '../settings/adminPage.module.css';
import s from './runDetail.module.css';

type Tab = 'timeline' | 'tools' | 'processes';

const KIND_LABEL: Record<TimelineNode['kind'], string> = {
  run: 'RUN', queue: 'QUEUE', model: 'LLM', tool: 'TOOL', sub: 'SUB', wait: 'WAIT',
};
const NODE_STATUS: Record<TimelineNode['status'], [string, string]> = {
  ok: ['成功', a.ok],
  error: ['失败', a.err],
  running: ['进行中', a.info],
  waiting: ['等待中', a.warn],
  approved: ['已批准', a.warn],
  rejected: ['已拒绝', a.err],
};

function pretty(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const { state } = useChat();
  const [run, setRun] = useState<AdminRun | null>(null);
  /** Sandbox session of the run; only readable by its owner (exec is owner-scoped). */
  const [sandboxSessionId, setSandboxSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<PersistedAgentEvent[]>([]);
  const [tools, setTools] = useState<ToolExecutionSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('timeline');
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Only the run itself decides "not found"; a failed timeline or ledger read
      // keeps the rest of the page and says what is missing.
      const [detail, evs, ledger] = await Promise.allSettled([
        getAdminRun(runId),
        listAdminRunEvents(runId),
        listAdminRunTools(runId),
      ]);
      if (detail.status === 'rejected') throw detail.reason;
      setRun(detail.value);
      setEvents(evs.status === 'fulfilled' ? evs.value : []);
      setTools(ledger.status === 'fulfilled' ? ledger.value : []);
      const missing = [evs.status === 'rejected' ? '时间线' : '', ledger.status === 'rejected' ? '工具台账' : ''].filter(Boolean);
      setNotice(missing.length ? `${missing.join('和')}读取失败，重新打开页面可以重试。` : null);
      // The owner-scoped run read succeeds only for the admin's own runs.
      const own = (await getRun(runId).catch(() => null)) as Record<string, unknown> | null;
      setSandboxSessionId(own ? String(own.sandbox_session_id || own.session_id || '') || null : null);
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 404 ? '找不到这次运行（不存在，或不属于本组织）。' : status === 403 ? '需要管理员权限。' : (err as Error).message || '读取运行失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwn = Boolean(run?.conversation_id && (state.conversations || []).some((c) => c.id === run.conversation_id));
  const agentText = run?.agent_name ? `${run.agent_name}${run.agent_version_no ? ` · v${run.agent_version_no}` : ''}` : '—';

  const timeline = useMemo(() => buildRunTimeline({
    runId,
    events,
    tools,
    userInput: run?.user_input ?? null,
    runLabel: `运行 · ${agentText === '—' ? '智能体' : agentText}`,
    runKv: [
      ['Run ID', runId],
      ['Trace ID', run?.trace_id || '—'],
      ...(run?.parent_run_id ? [['父运行', run.parent_run_id] as [string, string]] : []),
    ],
    startedAt: run?.started_at || null,
    finishedAt: run?.completed_at || null,
  }), [runId, events, tools, agentText, run]);

  const current = timeline.nodes.find((n) => n.id === selected) ?? timeline.nodes.find((n) => n.kind === 'model') ?? timeline.nodes[0];
  const total = Math.max(1, timeline.end - timeline.start);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => formatSpan(total * f));
  const status = String(run?.status || '');
  // Cancel goes through the owner-scoped run API, so it is offered on own runs only.
  const cancellable = isOwn && canCancelRun(status);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(runId);
      setNotice('已复制 Run ID');
    } catch {
      setNotice(`复制失败，请手动复制：${runId}`);
    }
  }

  async function cancel() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    try {
      const result = await cancelRun(runId);
      setNotice(`已请求取消${result.cancelledDescendants.length ? `，连带 ${result.cancelledDescendants.length} 个子任务` : ''}。`);
      await load();
    } catch (err) {
      setNotice((err as Error).message || '取消失败');
    }
  }

  return (
    <div className={a.page}>
      <div className={s.crumb}>
        <Link to="/admin/runs">运行</Link> / <span className={a.mono}>{runId.slice(0, 10)}</span>
      </div>
      <div className={a.head}>
        <div>
          <h1>{run?.conversation_title || '（无标题会话）'}</h1>
          {run ? (
            <p>
              {run.parent_run_id ? '子运行' : run.turn_no ? `第 ${run.turn_no} 轮` : ''}
              {runInputLabel(run.user_input, 120) ? `${run.parent_run_id || run.turn_no ? '：' : ''}${runInputLabel(run.user_input, 120)}` : ''}
            </p>
          ) : null}
        </div>
        {run ? <RunStatus status={status} /> : null}
        <span className={a.sp} />
        {cancellable ? <button type="button" className={a.btn} onClick={() => void cancel()}>{confirmCancel ? '确认取消运行' : '取消运行'}</button> : null}
        {run?.conversation_id && isOwn ? (
          <button type="button" className={a.btn} onClick={() => navigate(`/c/${encodeURIComponent(run.conversation_id!)}`)}>打开会话</button>
        ) : null}
        <button type="button" className={a.btn} onClick={() => void copyId()}>复制 Run ID</button>
      </div>

      {notice ? <p className={a.notice} role="status" onClick={() => setNotice(null)}>{notice}</p> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      {run ? (
        <div className={s.meta}>
          <span><b>用户</b>{run.user_name || '—'}</span>
          <span><b>智能体</b>{agentText}</span>
          <span><b>模型</b>{run.model_id || '平台默认'}</span>
          <span className={a.num}><b>开始</b>{formatClock(run.started_at)}</span>
          <span className={a.num}><b>耗时</b>{formatRunDuration(run.started_at || null, run.completed_at || null)}</span>
          <span title="token 用量尚未采集"><b>Tokens</b>—</span>
          <span><b>工具</b>{timeline.toolCalls} 次{timeline.approvals ? ` · ${timeline.approvals} 次审批` : ''}</span>
          <span><b>模型轮次</b>{timeline.modelRounds}</span>
        </div>
      ) : null}
      {run?.status_reason ? <pre className={s.runError}>{run.status_reason}</pre> : null}

      <div className={a.tabs} role="tablist" aria-label="运行详情">
        <button type="button" role="tab" aria-selected={tab === 'timeline'} onClick={() => setTab('timeline')}>时间线</button>
        <button type="button" role="tab" aria-selected={tab === 'tools'} onClick={() => setTab('tools')}>工具台账<small>{tools.length}</small></button>
        <button type="button" role="tab" aria-selected={tab === 'processes'} onClick={() => setTab('processes')}>进程日志</button>
      </div>

      {loading && !run ? <div className={a.empty}>正在读取…</div> : null}

      {run && tab === 'timeline' ? (
        <div className={s.trace} aria-label="Run detail">
          <div className={s.wf} role="listbox" aria-label="Span 时间线">
            <div className={s.wfHead}>
              <span>节点</span>
              <span className={s.axis}>{ticks.map((t, i) => <span key={i}>{t}</span>)}</span>
              <span />
            </div>
            {timeline.nodes.map((n) => {
              const left = ((n.start - timeline.start) / total) * 100;
              const width = Math.max((((n.end ?? timeline.end) - n.start) / total) * 100, 0.4);
              return (
                <button
                  key={n.id}
                  type="button"
                  role="option"
                  aria-selected={n.id === current?.id}
                  className={s.wfRow}
                  onClick={() => setSelected(n.id)}
                >
                  <span className={s.wfName} style={{ paddingLeft: n.depth * 14 }}>
                    <span className={`${s.kind} ${s[`k_${n.kind}`]}`}>{KIND_LABEL[n.kind]}</span>
                    <span className={s.wfText}>{n.name}</span>
                  </span>
                  <span className={s.track}>
                    <i className={`${s[`b_${n.kind}`]}${n.status === 'error' || n.status === 'rejected' ? ` ${s.bErr}` : ''}${n.end == null ? ` ${s.bOpen}` : ''}`} style={{ left: `${left}%`, width: `${width}%` }} />
                  </span>
                  <span className={s.wfDur}>{n.end == null ? '…' : formatSpan(n.end - n.start)}</span>
                </button>
              );
            })}
            {timeline.nodes.length === 1 ? <p className={a.empty}>这次运行没有持久事件。</p> : null}
          </div>

          {current ? (
            <aside className={s.insp} aria-live="polite">
              <div className={s.inspHead}>
                <b>{current.name}</b>
                <span>
                  <span className={`${a.pill} ${NODE_STATUS[current.status][1]}`}>{NODE_STATUS[current.status][0]}</span>{' '}
                  <span className={`${a.muted} ${a.num}`}>
                    开始 +{formatSpan(current.start - timeline.start)} · 耗时 {current.end == null ? '进行中' : formatSpan(current.end - current.start)}
                  </span>
                </span>
              </div>
              <div className={s.inspBody}>
                {current.kv.length ? (
                  <dl className={s.kv}>{current.kv.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
                ) : null}
                {current.blocks.map((b, i) => (
                  <div key={`${b.title}-${i}`} className={s.blk}>
                    <h5>{b.title}</h5>
                    {b.kind === 'pre' ? <pre>{b.body}</pre> : <div className={s.txt}>{b.body}</div>}
                  </div>
                ))}
                {!current.kv.length && !current.blocks.length ? <p className={a.muted}>这个节点没有更多内容。</p> : null}
                {current.kind === 'model' ? <p className={s.foot}>模型收到的完整 prompt 目前没有持久化，这里只有它的输出。</p> : null}
              </div>
            </aside>
          ) : null}
        </div>
      ) : null}

      {run && tab === 'tools' ? <ToolLedger tools={tools} /> : null}
      {run && tab === 'processes' ? (
        sandboxSessionId ? <ProcessLogs runId={runId} sessionId={sandboxSessionId} /> : (
          <div className={`${a.tableWrap} ${a.empty}`}>进程日志存放在运行所有者的沙箱里，沙箱按用户隔离，这里只能查看你自己的运行。</div>
        )
      ) : null}
    </div>
  );
}

function ToolLedger({ tools }: { tools: ToolExecutionSnapshot[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!tools.length) return <div className={`${a.tableWrap} ${a.empty}`}>这次运行没有调用工具。</div>;
  return (
    <div className={a.tableWrap}>
      <table className={a.table}>
        <thead><tr><th>工具</th><th>状态</th><th>来源</th><th>风险</th><th>开始</th><th className={a.right}>耗时</th><th /></tr></thead>
        <tbody>
          {tools.map((t) => {
            const row = t as ToolExecutionSnapshot & Record<string, unknown>;
            const isOpen = open === t.tool_call_id;
            const started = (row.started_at as string | null) || t.created_at || null;
            const finished = (row.completed_at as string | null) || t.finished_at || null;
            return [
              <tr key={t.tool_call_id} className={s.ledgerRow} onClick={() => setOpen(isOpen ? null : t.tool_call_id)}>
                <td className={a.mono}>{t.tool_name || '—'}</td>
                <td><span className={`${a.pill} ${/fail|error|reject|denied/i.test(t.status) ? a.err : /succe|complete/i.test(t.status) ? a.ok : a.mute}`}>{t.status}</span></td>
                <td>{String(row.tool_source || '—')}</td>
                <td>{String(row.risk_level || '—')}</td>
                <td className={a.num}>{formatClock(started)}</td>
                <td className={`${a.right} ${a.num}`}>{formatRunDuration(started, finished)}</td>
                <td className={s.linkCell}>{isOpen ? '收起' : '展开'}</td>
              </tr>,
              isOpen ? (
                <tr key={`${t.tool_call_id}-d`} className={s.ledgerDetail}>
                  <td colSpan={7}>
                    <div className={s.ledgerGrid}>
                      <div><h5>参数</h5><pre>{pretty(t.arguments ?? {})}</pre></div>
                      <div><h5>结果</h5><pre>{pretty(t.result_json ?? t.result_summary ?? t.error ?? '—')}</pre></div>
                    </div>
                    <p className={a.muted}>toolCallId <span className={a.mono}>{t.tool_call_id}</span></p>
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function ProcessLogs({ runId, sessionId }: { runId: string; sessionId: string }) {
  const [items, setItems] = useState<ManagedProcess[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    if (!sessionId) {
      setItems([]);
      return;
    }
    // The process API is scoped by sandbox session; keep this run's processes.
    listProcesses({ sessionId, runId, limit: 100 })
      .then((list) => { if (alive) setItems(list.filter((p) => !p.run_id || p.run_id === runId)); })
      .catch((err: Error) => { if (alive) setError(err.message || '读取进程失败'); });
    return () => { alive = false; };
  }, [runId, sessionId]);

  async function show(p: ManagedProcess) {
    if (logs[p.process_id] != null) {
      setLogs(({ [p.process_id]: _, ...rest }) => rest);
      return;
    }
    const sid = p.session_id || p.sandbox_session_id || sessionId;
    try {
      const out = await getProcessLogs(p.process_id, { sessionId: sid, limit: 200_000 });
      const text = [out.stdout, out.stderr ? `--- stderr ---\n${out.stderr}` : ''].filter(Boolean).join('\n') || '（无输出）';
      setLogs((cur) => ({ ...cur, [p.process_id]: out.truncated ? `${text}\n…（已截断）` : text }));
    } catch (err) {
      setLogs((cur) => ({ ...cur, [p.process_id]: `读取日志失败：${(err as Error).message}` }));
    }
  }

  if (error) return <div className={`${a.tableWrap} ${a.empty}`}>{error}</div>;
  if (!items) return <div className={`${a.tableWrap} ${a.empty}`}>正在读取…</div>;
  if (!items.length) return <div className={`${a.tableWrap} ${a.empty}`}>这次运行没有后台进程。前台命令的输出见时间线里对应的工具节点。</div>;
  return (
    <div className={s.procs}>
      {items.map((p) => (
        <div key={p.process_id} className={s.proc}>
          <div className={s.procHead}>
            <code>{p.command}</code>
            <span className={a.sp} />
            <span className={`${a.pill} ${p.status === 'running' ? a.info : p.exit_code ? a.err : a.ok}`}>{p.status}{p.exit_code != null ? ` · ${p.exit_code}` : ''}</span>
            <span className={`${a.muted} ${a.num}`}>{formatClock(p.started_at || p.created_at)}</span>
            <button type="button" className={a.btn} onClick={() => void show(p)}>{logs[p.process_id] != null ? '收起日志' : '查看日志'}</button>
          </div>
          {logs[p.process_id] != null ? <pre className={s.log}>{logs[p.process_id]}</pre> : null}
        </div>
      ))}
    </div>
  );
}
