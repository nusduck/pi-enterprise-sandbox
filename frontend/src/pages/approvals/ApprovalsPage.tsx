/**
 * 审批（admin）：在对话之外处理工具审批。
 * 列表 API 不可用时退回本浏览器会话里的审批（entity store）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChat } from '../../features/chat/ChatContext';
import { listApprovalsPage } from '../../shared/api/approvals';
import type { ApprovalListItem } from '../../shared/schemas/management';
import { Pager, useCursorPagination } from '../../shared/ui/Pager';
import {
  APPROVAL_STATUS_FILTERS,
  canDecideApproval,
  filterApprovalsByStatus,
  formatArgs,
  mergeApprovalRows,
  normalizeApprovalStatus,
  validateApprovalReason,
  type ApprovalRow,
  type ApprovalStatusFilterId,
} from './approvalHelpers';
import { shortId } from '../runs/runHelpers';
import { PageHeader } from '../../shared/ui/PageHeader';
import { StatusBadge } from '../../shared/ui/StatusBadge';
import { EmptyState } from '../../shared/ui/EmptyState';
import a from '../settings/adminPage.module.css';
import s from './approvals.module.css';

const STATUS_ZH: Record<string, [string, string]> = {
  pending: ['待审批', a.warn],
  approved: ['已批准', a.ok],
  rejected: ['已拒绝', a.err],
  expired: ['已过期', a.mute],
  cancelled: ['已取消', a.mute],
};

const RISK_ZH: Record<string, [string, string]> = {
  low: ['低风险', a.ok],
  medium: ['中风险', a.warn],
  high: ['高风险', a.err],
  critical: ['极高风险', a.err],
};

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function ApprovalsPage() {
  const { entityStore, resolveApproval, state } = useChat();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ApprovalStatusFilterId>('pending');
  const pagination = useCursorPagination({ initialPageSize: 20 });
  const [apiItems, setApiItems] = useState<ApprovalListItem[]>([]);
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [decisionModeById, setDecisionModeById] = useState<Record<string, 'approve' | 'reject'>>({});
  const [reasonDraftById, setReasonDraftById] = useState<Record<string, string>>({});
  const [rowErrorById, setRowErrorById] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const page = await listApprovalsPage({
        status: filter === 'all' ? undefined : filter,
        limit: pagination.pageSize,
        cursor: pagination.currentCursor,
      });
      setApiItems(page.approvals);
      pagination.setPageData(page.next_cursor);
      setApiAvailable(true);
    } catch {
      setApiItems([]);
      pagination.setPageData(null);
      setApiAvailable(false);
    } finally {
      setLoading(false);
    }
  }, [filter, pagination.pageSize, pagination.currentCursor, pagination.setPageData]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rows = useMemo(
    () => filterApprovalsByStatus(mergeApprovalRows(apiItems, entityStore), filter),
    [apiItems, entityStore, filter],
  );
  const titleById = useMemo(
    () => new Map((state.conversations || []).map((c) => [c.id, c.title || null])),
    [state.conversations],
  );

  async function onDecide(row: ApprovalRow, decision: 'approve' | 'reject', reason?: string) {
    if (!canDecideApproval(row.status)) return;
    setBusyId(row.id);
    setRowErrorById((prev) => {
      const next = { ...prev };
      delete next[row.id];
      return next;
    });
    try {
      const applied = await resolveApproval(row.id, decision, reason);
      if (!applied) {
        const msg = '操作失败，这条审批仍在等待处理。';
        setBanner(msg);
        setRowErrorById((prev) => ({ ...prev, [row.id]: msg }));
        return;
      }
      setBanner(`${decision === 'approve' ? '已批准' : '已拒绝'} ${row.tool || shortId(row.id)}`);
      setDecisionModeById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      setReasonDraftById((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      await refresh();
    } catch (err) {
      const msg = (err as Error).message || '操作失败';
      setBanner(msg);
      setRowErrorById((prev) => ({ ...prev, [row.id]: msg }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={a.page}>
      <PageHeader
        title="审批"
        description="需要人工确认的工具调用。在这里的决定与对话里的审批卡等效，批准后运行会继续。"
        action={
          <button type="button" className={a.btn} onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        }
      />

      {banner ? <p className={a.notice} role="status" onClick={() => setBanner(null)}>{banner}</p> : null}

      <div className={a.tabs} role="tablist" aria-label="按状态筛选">
        {APPROVAL_STATUS_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => {
              setFilter(f.id);
              pagination.reset();
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          variant={apiAvailable === false ? 'error' : 'empty'}
          title={loading ? '正在读取…' : apiAvailable === false ? '审批列表接口暂不可用' : '暂无审批'}
          description={
            loading
              ? '正在读取…'
              : apiAvailable === false
                ? '审批列表接口暂不可用；本页只能显示这个浏览器里产生的审批。'
                : filter === 'pending'
                  ? '没有待处理的审批。'
                  : '没有符合这个状态的审批。'
          }
        />
      ) : (
        <div className={`${a.tableCard} ${s.listCard}`}>
          <ul className={s.list}>
          {rows.map((row) => {
            const open = expandedId === row.id;
            const pending = canDecideApproval(row.status);
            const statusKey = normalizeApprovalStatus(row.status);
            const [statusLabel] = STATUS_ZH[statusKey] || [row.status, a.mute];
            const risk = row.riskLevel ? RISK_ZH[row.riskLevel.toLowerCase()] || [row.riskLevel, a.mute] : null;
            const title = row.conversationId ? titleById.get(row.conversationId) : null;
            const mode = decisionModeById[row.id] || null;
            const reasonDraft = reasonDraftById[row.id] || '';
            const reasonValidation = validateApprovalReason(reasonDraft);
            const rowError = rowErrorById[row.id] || null;
            return (
              <li key={row.id} className={`${s.card}${pending ? ` ${s.pending}` : ''}`}>
                <div className={s.head}>
                  <code className={s.tool}>{row.tool || '工具调用'}</code>
                  {risk ? <StatusBadge status={row.riskLevel?.toLowerCase() || 'neutral'} label={risk[0]} /> : null}
                  <StatusBadge status={statusKey} label={statusLabel} />
                  <span className={a.sp} />
                  <time className={`${a.muted} ${a.num}`}>{formatTime(row.createdAt)}</time>
                </div>
                {row.reason ? (
                  <p className={s.reason}>
                    {!pending && !row.reason.startsWith('原因：') ? `原因：${row.reason}` : row.reason}
                  </p>
                ) : null}
                {row.command ? <pre className={s.cmd}>{row.command}</pre> : null}
                {open && row.arguments != null ? <pre className={s.cmd}>{formatArgs(row.arguments)}</pre> : null}
                <div className={s.foot}>
                  <span className={s.meta}>
                    {row.conversationId ? (title || `会话 ${shortId(row.conversationId, 8)}`) : '无关联会话'}
                    {row.username ? ` · ${row.username}` : ''}
                    {row.runId ? <code title={row.runId}> · {shortId(row.runId, 10)}</code> : null}
                  </span>
                  <span className={a.sp} />
                  {row.arguments != null ? (
                    <button type="button" className={s.link} onClick={() => setExpandedId(open ? null : row.id)}>
                      {open ? '收起参数' : '查看参数'}
                    </button>
                  ) : null}
                  {row.conversationId ? (
                    <button type="button" className={s.link} onClick={() => navigate(`/c/${encodeURIComponent(row.conversationId!)}`)}>
                      打开会话
                    </button>
                  ) : null}
                  {pending ? (
                    mode ? (
                      <div className={s.decisionBox}>
                        <textarea
                          className={s.reasonInput}
                          rows={2}
                          placeholder={mode === 'reject' ? '拒绝原因（可选）' : '批准原因（可选）'}
                          value={reasonDraft}
                          onChange={(e) => {
                            const val = e.target.value;
                            setReasonDraftById((prev) => ({ ...prev, [row.id]: val }));
                            if (rowErrorById[row.id]) {
                              setRowErrorById((prev) => {
                                const next = { ...prev };
                                delete next[row.id];
                                return next;
                              });
                            }
                          }}
                          disabled={busyId === row.id}
                        />
                        {reasonValidation.error ? (
                          <small className={s.fieldError}>{reasonValidation.error}</small>
                        ) : null}
                        {rowError ? <small className={s.fieldError}>{rowError}</small> : null}
                        <div className={s.decisionActions}>
                          <span className={a.sp} />
                          <button
                            type="button"
                            className={a.btn}
                            disabled={busyId === row.id}
                            onClick={() => {
                              setDecisionModeById((prev) => {
                                const next = { ...prev };
                                delete next[row.id];
                                return next;
                              });
                              setRowErrorById((prev) => {
                                const next = { ...prev };
                                delete next[row.id];
                                return next;
                              });
                            }}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className={mode === 'approve' ? a.btnPri : a.btn}
                            disabled={busyId === row.id || !reasonValidation.valid}
                            onClick={() => void onDecide(row, mode, reasonDraft.trim() || undefined)}
                          >
                            {busyId === row.id ? '处理中…' : mode === 'approve' ? '确认批准' : '确认拒绝'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={a.btn}
                          disabled={busyId === row.id}
                          onClick={() => setDecisionModeById((prev) => ({ ...prev, [row.id]: 'reject' }))}
                        >
                          拒绝
                        </button>
                        <button
                          type="button"
                          className={a.btnPri}
                          disabled={busyId === row.id}
                          onClick={() => setDecisionModeById((prev) => ({ ...prev, [row.id]: 'approve' }))}
                        >
                          {busyId === row.id ? '处理中…' : '批准'}
                        </button>
                      </>
                    )
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <Pager
          page={pagination.page}
          count={rows.length}
          pageSize={pagination.pageSize}
          onPageSizeChange={pagination.setPageSize}
          onPrev={pagination.goToPrevPage}
          onNext={pagination.goToNextPage}
          hasPrev={pagination.hasPrev}
          hasNext={pagination.hasNext}
          loading={loading}
        />
      </div>
    )}
    </div>
  );
}
