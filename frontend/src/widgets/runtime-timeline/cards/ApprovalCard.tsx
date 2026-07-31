import type { ApprovalEntity } from '../../../entities';

/**
 * Approval card — Codex-style inline prompt (entity store, not SSE-only).
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
  const title =
    approval.command ||
    approval.reason ||
    (pending ? 'Tool call requires approval' : `Approval ${approval.status}`);

  return (
    <article
      className={`ix-card ix-approval${pending ? ' ix-waiting' : ''}${
        approval.status === 'approved' ? ' ix-approved' : ''
      }${approval.status === 'rejected' ? ' ix-rejected' : ''}${
        selected ? ' selected' : ''
      }`}
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
      <header className="ix-head">
        <span className="ix-icon" aria-hidden="true">
          {pending ? '⚠' : approval.status === 'approved' ? '✓' : '✕'}
        </span>
        <div className="ix-head-text">
          <span className="ix-kicker">
            {pending
              ? 'Needs your approval'
              : approval.status === 'approved'
                ? 'Approved'
                : approval.status === 'rejected'
                  ? 'Rejected'
                  : approval.status}
            {approval.risk ? ` · ${approval.risk}` : ''}
          </span>
          <h3 className="ix-title">{title}</h3>
        </div>
      </header>
      {approval.reason && approval.reason !== title ? (
        <p className="ix-message">{approval.reason}</p>
      ) : null}
      {approval.command && approval.command !== title ? (
        <pre className="ix-pre">{approval.command}</pre>
      ) : null}
      {pending ? (
        <div className="ix-actions">
          <button
            type="button"
            className="ix-btn secondary"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onReject?.(approval.id);
            }}
          >
            Reject
          </button>
          <button
            type="button"
            className="ix-btn primary"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onApprove?.(approval.id);
            }}
          >
            Approve
          </button>
        </div>
      ) : null}
    </article>
  );
}
