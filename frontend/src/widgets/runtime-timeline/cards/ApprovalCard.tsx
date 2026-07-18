import type { ApprovalEntity } from '../../../entities';

/**
 * Approval card — persists from entity store (not SSE-only).
 * Approve / Reject wire through ChatController.
 */
export function ApprovalCard({
  approval,
  selected,
  onSelect,
  onApprove,
  onReject,
  busy,
}: {
  approval: ApprovalEntity;
  selected?: boolean;
  onSelect?: (approvalId: string) => void;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  busy?: boolean;
}) {
  const pending = approval.status === 'pending';

  return (
    <article
      className={`rtc-card rtc-approval status-${approval.status}${selected ? ' selected' : ''}`}
      data-approval-id={approval.id}
      data-status={approval.status}
      onClick={() => onSelect?.(approval.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.(approval.id);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <header className="rtc-card-head">
        <span className="rtc-icon" aria-hidden="true">
          ⚠
        </span>
        <span className="rtc-title">
          {pending ? 'Approval required' : `Approval ${approval.status}`}
        </span>
        <span className="rtc-meta">{approval.status}</span>
      </header>
      {approval.reason ? (
        <p className="rtc-subtitle">{approval.reason}</p>
      ) : null}
      {approval.risk ? (
        <p className="rtc-subtitle rtc-risk">Risk: {approval.risk}</p>
      ) : null}
      {approval.command ? (
        <pre className="rtc-cmd">{approval.command}</pre>
      ) : null}
      <p className="rtc-status-line">
        run {approval.runId}
        {approval.toolExecutionId
          ? ` · tool ${approval.toolExecutionId}`
          : ''}
        {approval.expiresAt ? ` · expires ${approval.expiresAt}` : ''}
      </p>
      {pending ? (
        <div className="rtc-actions">
          <button
            type="button"
            className="btn-approve"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onApprove?.(approval.id);
            }}
          >
            Approve
          </button>
          <button
            type="button"
            className="btn-reject"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onReject?.(approval.id);
            }}
          >
            Reject
          </button>
        </div>
      ) : null}
    </article>
  );
}
