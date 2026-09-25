/**
 * Run 详情（admin）= Trace：左侧 span 瀑布图，右侧选中节点的内容。
 * 节点内容由持久事件与工具台账拼接（见 runTimeline.ts），不改 trace 契约。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { getConversation, getConversationEvents } from '../../shared/api/client';
import { cancelRun, getRun, listRunTools } from '../../shared/api/runs';
import { getProcessLogs, listProcesses, type ManagedProcess } from '../../shared/api/processes';
import type { PersistedAgentEvent, RunDetail, ToolExecutionSnapshot } from '../../shared/schemas/events';
import { canCancelRun, formatRunDuration } from './runHelpers';
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

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
  return text || null;
}

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
  const { state, agentNameById } = useChat();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<PersistedAgentEvent[]>([]);
  const [tools, setTools] = useState<ToolExecutionSnapshot[]>([]);
  const [input, setInput] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
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
      const detail = await getRun(runId);
      setRun(detail);
      const conversationId = detail.conversation_id;
      const [evs, ledger, conv] = await Promise.all([
        conversationId ? getConversationEvents(conversationId).then((r) => r.events) : Promise.resolve([]),
        listRunTools(runId).catch(() => []),
        conversationId ? getConversation(conversationId).catch(() => null) : Promise.resolve(null),
      ]);
      setEvents(evs.filter((e) => e.run_id === runId));
      setTools(ledger);
      setTitle(conv?.title || null);
      const messages = Array.isArray(conv?.messages) ? (conv!.messages as Array<Record<string, unknown>>) : [];
      const mine = messages.find((m) => m.run_id === runId && m.role === 'user');
      setInput(mine ? userText(mine.content) : null);
    } catch (err) {
      setError((err as Error).message || '读取运行失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const conv = run?.conversation_id ? (state.conversations || []).find((c) => c.id === run.conversation_id) : null;
  const agentName = conv?.agent_id ? agentNameById(conv.agent_id) : null;
  const agentText = agentName ? `${agentName}${conv?.agent_version_no ? ` · v${conv.agent_version_no}` : ''}` : '—';
  const detailRecord = run as (RunDetail & Record<string, unknown>) | null;

  const timeline = useMemo(() => buildRunTimeline({
    runId,
    events,
    tools,
    userInput: input,
    runLabel: `运行 · ${agentText === '—' ? '智能体' : agentText}`,
    runKv: [
      ['Run ID', runId],
      ['Trace ID', String(detailRecord?.trace_id || '—')],
      ['尝试次数', String(detailRecord?.attempt ?? 1)],
    ],
    startedAt: run?.started_at || null,
    finishedAt: (detailRecord?.completed_at as string | null) || run?.finished_at || null,
  }), [runId, events, tools, input, agentText, run, detailRecord]);

  const current = timeline.nodes.find((n) => n.id === selected) ?? timeline.nodes.find((n) => n.kind === 'model') ?? timeline.nodes[0];
  const total = Math.max(1, timeline.end - timeline.start);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => formatSpan(total * f));
  const status = String(run?.status || '');
  const cancellable = canCancelRun(status);

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
        <div><h1>{title || '（无标题会话）'}</h1></div>
        {run ? <RunStatus status={status} /> : null}
        <span className={a.sp} />
        {cancellable ? <button type="button" className={a.btn} onClick={() => void cancel()}>{confirmCancel ? '确认取消运行' : '取消运行'}</button> : null}
        {run?.conversation_id ? (
          <button type="button" className={a.btn} onClick={() => navigate(`/c/${encodeURIComponent(run.conversation_id!)}`)}>打开会话</button>
        ) : null}
        <button type="button" className={a.btn} onClick={() => void copyId()}>复制 Run ID</button>
      </div>

      {notice ? <p className={a.notice} role="status" onClick={() => setNotice(null)}>{notice}</p> : null}
      {error ? <p className={s.error} role="alert">{error}</p> : null}

      {run ? (
        <div className={s.meta}>
          <span><b>用户</b>{String(state.authUser?.display_name || state.authUser?.username || '—')}</span>
          <span><b>智能体</b>{agentText}</span>
          <span><b>模型</b>{String(detailRecord?.model_id || '') || '平台默认'}</span>
          <span className={a.num}><b>开始</b>{formatClock(run.started_at)}</span>
          <span className={a.num}><b>耗时</b>{formatRunDuration(run.started_at || null, (detailRecord?.completed_at as string | null) || run.finished_at || null)}</span>
          <span><b>Tokens</b>—</span>
          <span><b>工具</b>{timeline.toolCalls} 次{timeline.approvals ? ` · ${timeline.approvals} 次审批` : ''}</span>
          <span><b>模型轮次</b>{timeline.modelRounds}</span>
        </div>
      ) : null}
      {run?.error ? <pre className={s.runError}>{String(run.error)}</pre> : null}

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
        <ProcessLogs runId={runId} sessionId={String((detailRecord?.sandbox_session_id as string | null) || run.session_id || '')} />
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
