/**
 * Approval Panel (plan §19.9) — external high-risk ops only.
 * Ordinary bash never appears here unless policy emits an approval event.
 */
import type { ApprovalEntity } from '../../entities';
import { ApprovalCard } from '../runtime-timeline/cards/ApprovalCard';

export function ApprovalPanel({
  approvals,
  selectedId,
  onSelect,
  onApprove,
  onReject,
  busy,
  emptyHint = 'No pending approvals.',
}: {
  approvals: ApprovalEntity[];
  selectedId?: string | null;
  onSelect?: (approvalId: string) => void;
  onApprove?: (approvalId: string) => void;
  onReject?: (approvalId: string) => void;
  busy?: boolean;
  emptyHint?: string;
}) {
  if (!approvals.length) {
    return <p className="inspector-empty">{emptyHint}</p>;
  }
  return (
    <div className="approval-panel" aria-label="Approvals">
      {approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          selected={selectedId === approval.id}
          onSelect={onSelect}
          onApprove={onApprove}
          onReject={onReject}
          busy={busy}
        />
      ))}
    </div>
  );
}
