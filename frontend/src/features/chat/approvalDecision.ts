export type ApprovalDecision = 'approve' | 'reject';

export type ApprovalDecisionDeps = {
  decide: (
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<Record<string, unknown>>;
  markApproval: (approvalId: string, status: 'approved' | 'rejected') => void;
  setStatus: (text: string, color: string) => void;
  flashError: (message: string) => void;
};

/** Apply one approval decision and report whether the durable API accepted it. */
export async function resolveApprovalDecision(
  approvalId: string,
  decision: ApprovalDecision,
  deps: ApprovalDecisionDeps,
): Promise<boolean> {
  if (!approvalId) return false;
  try {
    const result = await deps.decide(approvalId, decision);
    deps.markApproval(
      approvalId,
      decision === 'approve' ? 'approved' : 'rejected',
    );
    deps.setStatus(
      decision === 'approve' ? 'Approved' : 'Rejected',
      decision === 'approve' ? '#22c55e' : '#ef4444',
    );
    if (result.agent_resume_status === 'pending') {
      deps.flashError(
        'Decision saved; Agent resume is pending. Use Resume to retry.',
      );
    }
    return true;
  } catch (error) {
    deps.flashError((error as Error).message || 'Decision failed');
    return false;
  }
}
