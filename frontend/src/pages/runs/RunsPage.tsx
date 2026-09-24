/**
 * Active Runs page — /runs (F5 / ADR 0003 §10).
 * Filter by status; open conversation, cancel, view logs/detail.
 * Soft-fails when list API is incomplete; falls back to entity store.
 */
import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listRuns, cancelRun, getRun, getRunTraceSpans } from '../../shared/api/runs';
import {
  createTraceSpan,
  getRunTraceSpans as getStoreTraceSpans,
  type TraceSpanEntity,
} from '../../entities';
import { formatRunStatusLabel } from '../../widgets/runtime-timeline/buildTimeline';
import { TracePanel } from '../../widgets/trace-panel/TracePanel';
import {
  RUN_STATUS_FILTERS,
  canCancelRun,
  filterRunsByStatus,
  formatRunDuration,
  mergeRunRows,
  shortId,
  type RunRow,
  type RunStatusFilterId,
} from './runHelpers';
import {
  IconRefresh,
  IconClose,
  IconTerminal,
  IconChat,
  IconAlertCircle,
  IconSparkles,
  IconLayers,
  IconCopy,
  IconCheck,
} from '../../shared/ui/Icons';

export function RunsPage() {
  const { entityStore, selectConversation } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RunStatusFilterId>('all');
  const [apiRows, setApiRows] = useState<Awaited<ReturnType<typeof listRuns>>>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<'logs' | 'trace'>('logs');
  const [detailLog, setDetailLog] = useState<string | null>(null);
  const [traceSpans, setTraceSpans] = useState<TraceSpanEntity[]>([]);
  const [traceId, setTraceId] = useState<string | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listRuns();
      setApiRows(list);
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

  const rows = useMemo(() => {
    const merged = mergeRunRows(apiRows, entityStore);
    return filterRunsByStatus(merged, filter);
  }, [apiRows, entityStore, filter]);

  async function onOpen(row: RunRow) {
    if (row.conversationId) {
      await selectConversation(row.conversationId);
    }
    navigate('/');
  }

  async function onCancel(row: RunRow) {
    if (!canCancelRun(row.status)) return;
    if (!window.confirm(`Cancel run ${shortId(row.id)}?`)) return;
    setBusyId(row.id);
    try {
      const ok = await cancelRun(row.id);
      if (!ok) {
        setBanner('Cancel is not available yet (backend may not expose cancel for this run).');
      } else {
        setBanner(`Cancel requested for ${shortId(row.id)}.`);
        await refresh();
      }
    } catch (err) {
      setBanner((err as Error).message || 'Cancel failed');
    } finally {
      setBusyId(null);
    }
  }

  async function onViewLogs(row: RunRow) {
    setDetailLog(null);
    try {
      const detail = await getRun(row.id);
      if (detail) {
        const lines = [
          `run_id: ${detail.run_id || detail.id || row.id}`,
          `status: ${detail.status || row.status}`,
          `conversation_id: ${detail.conversation_id || row.conversationId || '—'}`,
          `session_id: ${detail.session_id || detail.agent_session_id || '—'}`,
          `started_at: ${detail.started_at || row.startedAt || '—'}`,
          `finished_at: ${detail.finished_at || row.finishedAt || '—'}`,
          `error: ${detail.error || row.error || '—'}`,
          `last_sequence: ${detail.last_sequence ?? '—'}`,
          `last_event_id: ${detail.last_event_id || '—'}`,
        ];
        setDetailLog(lines.join('\n'));
      } else {
        const run = entityStore.runsById[row.id];
        const tools = run
          ? run.toolExecutionIds
              .map((id) => entityStore.toolExecutionsById[id])
              .filter(Boolean)
          : [];
        const lines = [
          `run_id: ${row.id}`,
          `status: ${row.status}`,
          `conversation_id: ${row.conversationId || '—'}`,
          `source: ${row.source} (detail API unavailable)`,
          `started_at: ${row.startedAt || '—'}`,
          `finished_at: ${row.finishedAt || '—'}`,
          `error: ${row.error || '—'}`,
          '',
          '--- tool executions (entity store) ---',
          ...tools.map(
            (t) =>
              `${t!.name} [${t!.status}] ${t!.isError ? 'ERROR' : 'ok'}`,
          ),
          tools.length === 0 ? '(none in local store)' : '',
        ];
        setDetailLog(lines.filter(Boolean).join('\n'));
      }
    } catch (err) {
      setDetailLog(`Failed to load logs: ${(err as Error).message}`);
    }
  }

  async function loadTrace(runId: string) {
    setTraceLoading(true);
    setTraceError(null);
    try {
      const resp = await getRunTraceSpans(runId);
      const spans: TraceSpanEntity[] = (resp.spans || []).map((wire) => {
        const id = String(wire.id || wire.spanId || wire.span_id || '');
        const parentId = (wire.parentId || wire.parent_id || null) as string | null;
        const kind = (wire.kind || 'other') as TraceSpanEntity['kind'];
        const rawStatus = String(wire.status || '').toLowerCase();
        const status =
          rawStatus === 'ok' || rawStatus === 'error' || rawStatus === 'cancelled'
            ? rawStatus
            : 'running';
        return createTraceSpan({
          id: id || `${runId}-${Math.random()}`,
          runId,
          orgId: String(wire.orgId || wire.org_id || '') || null,
          userId: String(wire.userId || wire.user_id || '') || null,
          parentId,
          kind,
          name: String(wire.name || kind),
          status,
          spanId: (wire.spanId || wire.span_id || null) as string | null,
          durationMs:
            typeof wire.durationMs === 'number'
              ? wire.durationMs
              : typeof wire.duration_ms === 'number'
                ? wire.duration_ms
                : null,
          tokens: typeof wire.tokens === 'number' ? wire.tokens : null,
          cost: typeof wire.cost === 'number' ? wire.cost : null,
          error: wire.error ? String(wire.error) : null,
          metadata: (wire.metadata as Record<string, unknown>) || null,
          startedAt: (wire.startedAt || wire.started_at || null) as string | null,
          finishedAt: (wire.finishedAt || wire.finished_at || null) as string | null,
        });
      });
      setTraceSpans(spans);
      setTraceId(resp.traceId || resp.trace_id || null);
    } catch {
      const storeSpans = getStoreTraceSpans(entityStore, runId);
      setTraceSpans(storeSpans);
      const run = entityStore.runsById[runId];
      setTraceId(run?.traceId || null);
      if (!storeSpans || storeSpans.length === 0) {
        setTraceError('No trace spans found for this run.');
      }
    } finally {
      setTraceLoading(false);
    }
  }

  async function onToggleLogs(row: RunRow) {
    if (expandedRowId === row.id && expandedTab === 'logs') {
      setExpandedRowId(null);
      return;
    }
    setExpandedRowId(row.id);
    setExpandedTab('logs');
    await onViewLogs(row);
  }

  async function onToggleTrace(row: RunRow) {
    if (expandedRowId === row.id && expandedTab === 'trace') {
      setExpandedRowId(null);
      return;
    }
    setExpandedRowId(row.id);
    setExpandedTab('trace');
    await loadTrace(row.id);
  }

  async function handleCopyLogs() {
    if (!detailLog) return;
    try {
      await navigator.clipboard.writeText(detailLog);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Active Runs</h2>
          <p className="mgmt-subtitle">
            Running, waiting approval, interrupted, failed, and completed runs across all conversations.
          </p>
        </div>
        <button
          type="button"
          className="mgmt-btn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <IconRefresh size={14} className={loading ? 'icon-spin' : ''} />
          <span>{loading ? 'Refreshing…' : 'Refresh'}</span>
        </button>
      </header>

      {banner ? (
        <div className="mgmt-banner" role="status">
          <IconAlertCircle size={15} />
          <span>{banner}</span>
          <button
            type="button"
            className="mgmt-banner-close"
            aria-label="Dismiss notification"
            title="Dismiss notification"
            onClick={() => setBanner(null)}
          >
            <IconClose size={13} />
          </button>
        </div>
      ) : null}

      <div className="mgmt-filters" role="tablist" aria-label="Filter runs by status">
        {RUN_STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`mgmt-chip${filter === f.id ? ' active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <div className="mgmt-empty">
          <IconSparkles size={24} className="icon-pulse" />
          <p>Loading runs…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="mgmt-empty">
          <p className="mgmt-empty-title">No runs to display</p>
          <p className="mgmt-empty-body">
            {apiAvailable === false
              ? 'The runs list API is not available yet. Active runs from this browser session will appear here when the workbench creates them.'
              : filter === 'all'
                ? 'No runs found in the local store or API. Start a conversation to create a run.'
                : `No runs match “${RUN_STATUS_FILTERS.find((x) => x.id === filter)?.label}”.`}
          </p>
        </div>
      ) : (
        <div className="mgmt-table-wrap">
          <table className="mgmt-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Conversation</th>
                <th>Status</th>
                <th>Step / Tool</th>
                <th>Duration</th>
                <th>Model</th>
                <th>Tokens</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isExpanded = expandedRowId === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr className={isExpanded ? 'selected is-expanded' : ''}>
                      <td>
                        <code className="mgmt-id-code" title={row.id}>{shortId(row.id, 12)}</code>
                      </td>
                      <td>
                        {row.conversationId ? (
                          <code className="mgmt-id-code" title={row.conversationId}>
                            {shortId(row.conversationId, 10)}
                          </code>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <span className={`mgmt-status status-${row.status}`}>
                          <span className="mgmt-status-dot" />
                          {formatRunStatusLabel(row.status)}
                        </span>
                      </td>
                      <td className="mgmt-muted">
                        {row.currentStep || '—'}
                        {row.currentTool ? ` · ${row.currentTool}` : ''}
                      </td>
                      <td>{formatRunDuration(row.startedAt, row.finishedAt)}</td>
                      <td className="mgmt-muted">{row.model || '—'}</td>
                      <td className="mgmt-muted">{row.tokenUsage || '—'}</td>
                      <td>
                        <div className="mgmt-row-actions">
                          <button
                            type="button"
                            className="mgmt-btn sm"
                            onClick={() => void onOpen(row)}
                            title="Open conversation"
                          >
                            <IconChat size={12} /> Open
                          </button>
                          <button
                            type="button"
                            className={`mgmt-btn sm secondary${isExpanded && expandedTab === 'logs' ? ' active' : ''}`}
                            onClick={() => void onToggleLogs(row)}
                            title="View logs"
                          >
                            <IconTerminal size={12} /> Logs
                          </button>
                          <button
                            type="button"
                            className={`mgmt-btn sm secondary${isExpanded && expandedTab === 'trace' ? ' active' : ''}`}
                            onClick={() => void onToggleTrace(row)}
                            title="View trace spans"
                          >
                            <IconLayers size={12} /> Trace
                          </button>
                          {canCancelRun(row.status) ? (
                            <button
                              type="button"
                              className="mgmt-btn sm danger"
                              disabled={busyId === row.id}
                              onClick={() => void onCancel(row)}
                            >
                              {busyId === row.id ? '…' : 'Cancel'}
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {isExpanded ? (
                      <tr key={`${row.id}-expand`} className="mgmt-expand-row">
                        <td colSpan={8}>
                          <div className="mgmt-inline-drawer" aria-label="Run detail">
                            <div className="mgmt-inline-head">
                              <div className="mgmt-inline-nav">
                                <span className="mgmt-inline-title">Run {shortId(row.id, 12)}</span>
                                <div className="mgmt-inline-tabs" role="tablist">
                                  <button
                                    type="button"
                                    role="tab"
                                    aria-selected={expandedTab === 'logs'}
                                    className={`mgmt-inline-tab${expandedTab === 'logs' ? ' active' : ''}`}
                                    onClick={() => void onToggleLogs(row)}
                                  >
                                    <IconTerminal size={13} />
                                    <span>Logs</span>
                                  </button>
                                  <button
                                    type="button"
                                    role="tab"
                                    aria-selected={expandedTab === 'trace'}
                                    className={`mgmt-inline-tab${expandedTab === 'trace' ? ' active' : ''}`}
                                    onClick={() => void onToggleTrace(row)}
                                  >
                                    <IconLayers size={13} />
                                    <span>Trace</span>
                                  </button>
                                </div>
                              </div>
                              <div className="mgmt-inline-actions">
                                {expandedTab === 'logs' && detailLog ? (
                                  <button
                                    type="button"
                                    className="mgmt-btn sm secondary"
                                    onClick={() => void handleCopyLogs()}
                                    title="Copy logs"
                                  >
                                    {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
                                    <span>{copied ? 'Copied' : 'Copy'}</span>
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="mgmt-btn sm secondary"
                                  onClick={() => setExpandedRowId(null)}
                                  title="Close detail"
                                >
                                  <IconClose size={12} />
                                  <span>Close</span>
                                </button>
                              </div>
                            </div>
                            <div className="mgmt-inline-content">
                              {expandedTab === 'logs' ? (
                                <div>
                                  {row.error ? (
                                    <p className="mgmt-error">Failure: {row.error}</p>
                                  ) : null}
                                  <pre className="mgmt-log">{detailLog || 'Loading logs…'}</pre>
                                </div>
                              ) : (
                                <div className="mgmt-inline-trace-wrap">
                                  {traceLoading ? (
                                    <div className="mgmt-trace-loading">
                                      <IconSparkles size={18} className="icon-pulse" />
                                      <p>Loading trace spans…</p>
                                    </div>
                                  ) : traceError ? (
                                    <p className="mgmt-error">{traceError}</p>
                                  ) : (
                                    <TracePanel spans={traceSpans} traceId={traceId} />
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
