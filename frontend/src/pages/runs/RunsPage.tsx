/**
 * Active Runs page — /runs (F5 / ADR 0003 §10).
 * Filter by status; open conversation, cancel, view logs/detail.
 * Soft-fails when list API is incomplete; falls back to entity store.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listRuns, cancelRun, getRun } from '../../shared/api/runs';
import { formatRunStatusLabel } from '../../widgets/runtime-timeline/buildTimeline';
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

export function RunsPage() {
  const { entityStore, selectConversation } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<RunStatusFilterId>('all');
  const [apiRows, setApiRows] = useState<Awaited<ReturnType<typeof listRuns>>>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<RunRow | null>(null);
  const [detailLog, setDetailLog] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listRuns(
        filter === 'all' || filter === 'completed'
          ? {}
          : { status: filter },
      );
      setApiRows(list);
      // Heuristic: empty + no store data later → may be unavailable; we still mark tried
      setApiAvailable(true);
    } catch {
      setApiRows([]);
      setApiAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [filter]);

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
    setSelected(row);
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
        // Fall back to entity / row fields
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

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Active Runs</h2>
          <p className="mgmt-subtitle">
            Running, waiting approval, interrupted, failed, and completed runs
            across conversations.
          </p>
        </div>
        <button
          type="button"
          className="mgmt-btn"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {banner ? (
        <div className="mgmt-banner" role="status">
          <span>{banner}</span>
          <button type="button" className="mgmt-banner-close" onClick={() => setBanner(null)}>
            ✕
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
        <div className="mgmt-empty">Loading runs…</div>
      ) : rows.length === 0 ? (
        <div className="mgmt-empty">
          <p className="mgmt-empty-title">No runs to show</p>
          <p className="mgmt-empty-body">
            {apiAvailable === false
              ? 'The runs list API is not available yet. Active runs from this browser session will appear here when the workbench creates them.'
              : filter === 'all'
                ? 'No runs in the local store or API. Start a conversation to create a run.'
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
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={selected?.id === row.id ? 'selected' : ''}
                >
                  <td>
                    <code title={row.id}>{shortId(row.id, 12)}</code>
                  </td>
                  <td>
                    {row.conversationId ? (
                      <code title={row.conversationId}>
                        {shortId(row.conversationId, 10)}
                      </code>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <span className={`mgmt-status status-${row.status}`}>
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
                        Open
                      </button>
                      <button
                        type="button"
                        className="mgmt-btn sm secondary"
                        onClick={() => void onViewLogs(row)}
                        title="View logs / detail"
                      >
                        Logs
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <aside className="mgmt-detail" aria-label="Run detail">
          <header className="mgmt-detail-head">
            <h3>Run {shortId(selected.id, 16)}</h3>
            <button
              type="button"
              className="mgmt-btn sm secondary"
              onClick={() => {
                setSelected(null);
                setDetailLog(null);
              }}
            >
              Close
            </button>
          </header>
          {selected.error ? (
            <p className="mgmt-error">Failure: {selected.error}</p>
          ) : null}
          <pre className="mgmt-log">{detailLog || 'Loading…'}</pre>
        </aside>
      ) : null}
    </div>
  );
}
