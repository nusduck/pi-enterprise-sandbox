/**
 * Approval Center — /approvals (F5 / ADR 0003 §9).
 * Complete approvals outside the conversation page.
 * Soft-fails when list API missing; entity store keeps session approvals.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listApprovals } from '../../shared/api/approvals';
import type { ApprovalListItem } from '../../shared/schemas/management';
import {
  APPROVAL_STATUS_FILTERS,
  canDecideApproval,
  filterApprovalsByStatus,
  formatArgs,
  mergeApprovalRows,
  type ApprovalRow,
  type ApprovalStatusFilterId,
} from './approvalHelpers';
import { shortId } from '../runs/runHelpers';

export function ApprovalsPage() {
  const { entityStore, resolveApproval, selectConversation } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ApprovalStatusFilterId>('pending');
  const [apiItems, setApiItems] = useState<ApprovalListItem[]>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listApprovals(
        filter === 'all' ? {} : { status: filter },
      );
      setApiItems(list);
      setApiAvailable(true);
    } catch {
      setApiItems([]);
      setApiAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    const merged = mergeApprovalRows(apiItems, entityStore);
    return filterApprovalsByStatus(merged, filter);
  }, [apiItems, entityStore, filter]);

  async function onDecide(row: ApprovalRow, decision: 'approve' | 'reject') {
    if (!canDecideApproval(row.status)) return;
    setBusyId(row.id);
    try {
      await resolveApproval(row.id, decision);
      setBanner(
        decision === 'approve'
          ? `Approved ${shortId(row.id)}`
          : `Rejected ${shortId(row.id)}`,
      );
      await refresh();
    } catch (err) {
      setBanner((err as Error).message || 'Decision failed');
    } finally {
      setBusyId(null);
    }
  }

  async function onOpenConversation(row: ApprovalRow) {
    if (row.conversationId) {
      await selectConversation(row.conversationId);
      navigate('/');
    } else {
      setBanner('No conversation linked to this approval.');
    }
  }

  return (
    <div className="mgmt-page">
      <header className="mgmt-header">
        <div>
          <h2 className="mgmt-title">Approval Center</h2>
          <p className="mgmt-subtitle">
            Pending, approved, rejected, expired, and cancelled tool approvals.
            Decisions apply even when you leave the conversation.
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

      <div className="mgmt-filters" role="tablist" aria-label="Filter approvals">
        {APPROVAL_STATUS_FILTERS.map((f) => (
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
        <div className="mgmt-empty">Loading approvals…</div>
      ) : rows.length === 0 ? (
        <div className="mgmt-empty">
          <p className="mgmt-empty-title">No approvals to show</p>
          <p className="mgmt-empty-body">
            {apiAvailable === false
              ? 'The approvals list API is not available yet. Approvals from this browser session (entity store) will appear here when tools request them.'
              : filter === 'pending'
                ? 'No pending approvals. High-risk tools will show up here when they need a decision.'
                : `No approvals with status “${APPROVAL_STATUS_FILTERS.find((x) => x.id === filter)?.label}”.`}
          </p>
        </div>
      ) : (
        <ul className="mgmt-card-list">
          {rows.map((row) => {
            const open = expandedId === row.id;
            const pending = canDecideApproval(row.status);
            return (
              <li key={row.id} className={`mgmt-card status-${row.status}`}>
                <header className="mgmt-card-head">
                  <div>
                    <span className={`mgmt-status status-${row.status}`}>
                      {row.status}
                    </span>
                    {row.riskLevel ? (
                      <span className="mgmt-risk">risk: {row.riskLevel}</span>
                    ) : null}
                    <h3 className="mgmt-card-title">
                      {row.tool || 'Tool approval'}
                    </h3>
                  </div>
                  <time className="mgmt-muted">
                    {row.createdAt
                      ? new Date(row.createdAt).toLocaleString()
                      : '—'}
                  </time>
                </header>

                {row.reason ? (
                  <p className="mgmt-card-reason">{row.reason}</p>
                ) : null}

                {row.command ? (
                  <pre className="mgmt-cmd">{row.command}</pre>
                ) : null}

                <dl className="mgmt-meta-grid">
                  <div>
                    <dt>Approval</dt>
                    <dd>
                      <code title={row.id}>{shortId(row.id, 14)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Run</dt>
                    <dd>
                      {row.runId ? (
                        <code title={row.runId}>{shortId(row.runId, 12)}</code>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Conversation</dt>
                    <dd>
                      {row.conversationId ? (
                        <code title={row.conversationId}>
                          {shortId(row.conversationId, 10)}
                        </code>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{row.workspaceId || '—'}</dd>
                  </div>
                  <div>
                    <dt>User</dt>
                    <dd>{row.username || '—'}</dd>
                  </div>
                </dl>

                {open && row.arguments != null ? (
                  <pre className="mgmt-log">{formatArgs(row.arguments)}</pre>
                ) : null}

                <div className="mgmt-row-actions">
                  {pending ? (
                    <>
                      <button
                        type="button"
                        className="mgmt-btn sm approve"
                        disabled={busyId === row.id}
                        onClick={() => void onDecide(row, 'approve')}
                      >
                        {busyId === row.id ? '…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="mgmt-btn sm danger"
                        disabled={busyId === row.id}
                        onClick={() => void onDecide(row, 'reject')}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {row.conversationId ? (
                    <button
                      type="button"
                      className="mgmt-btn sm secondary"
                      onClick={() => void onOpenConversation(row)}
                    >
                      Open conversation
                    </button>
                  ) : null}
                  {row.arguments != null ? (
                    <button
                      type="button"
                      className="mgmt-btn sm secondary"
                      onClick={() =>
                        setExpandedId(open ? null : row.id)
                      }
                    >
                      {open ? 'Hide args' : 'Show args'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
